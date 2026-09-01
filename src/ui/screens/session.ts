/**
 * The session itself. Two modes share one recording pipeline: what differs is
 * only how much the screen tells you while you sit.
 */
import { el, append, clear, fmtDuration } from '../dom';
import { startCamera, stopCamera, CameraError, ScreenLock } from '../../capture/camera';
import { PostureLandmarker, PerfMeter } from '../../capture/landmarker';
import { TripodWatcher } from '../../capture/orientation';
import { SessionRecorder } from '../../posture/recorder';
import type { CameraProfile, PoseFrame } from '../../posture/types';
import { getProfile, getSettings, newId, saveSession, type SessionMode, type Settings } from '../../store/db';
import { AmbientGlow, Chime, NudgeEngine } from '../../nudge';
import { LevelGauge, PlumbGauge, RotationGauge } from '../gauges';
import { drawSkeleton } from '../overlay';
import { navigate } from '../../router';

export function sessionScreen(root: HTMLElement): () => void {
  let disposed = false;
  let stream: MediaStream | null = null;
  let landmarker: PostureLandmarker | null = null;
  let recorder: SessionRecorder | null = null;
  let profile: CameraProfile | null = null;
  let settings: Settings | null = null;
  let mode: SessionMode = 'blind';
  let running = false;
  let startedAt = 0;
  let blindEl: HTMLElement | null = null;
  let tickTimer: number | null = null;
  let cameraError: string | null = null;

  const lock = new ScreenLock();
  const chime = new Chime();
  const glow = new AmbientGlow();
  const tripod = new TripodWatcher();
  const perf = new PerfMeter();
  let nudges: NudgeEngine | null = null;

  const video = el('video', { playsinline: true, muted: true, class: 'mirror' });
  const canvas = el('canvas', { width: 480, height: 640, class: 'mirror' });
  const stage = el('div', { class: 'stage', style: 'margin-bottom:14px' }, video, canvas);
  const panel = el('div');

  const levelGauge = new LevelGauge();
  const plumbGauge = new PlumbGauge();
  const rotationGauge = new RotationGauge();
  const timerEl = el('div', { class: 'timer' }, '0:00');
  const statusEl = el('div', { class: 'small muted' }, '');

  /* ------------------------------------------------------------ setup view */

  async function init(): Promise<void> {
    settings = await getSettings();
    mode = settings.defaultMode;
    if (settings.activeProfileId) profile = (await getProfile(settings.activeProfileId)) ?? null;

    if (!profile) {
      clear(root);
      root.append(
        el('h1', {}, 'Sit'),
        el('div', { class: 'notice' }, 'No camera setup saved yet. Calibration is what makes the numbers mean anything.'),
        el('button', { class: 'primary block', onclick: () => navigate('#/calibrate') }, 'Set up the camera'),
      );
      return;
    }

    nudges = new NudgeEngine(settings.nudges, settings.tolerance);
    renderSetup();
  }

  function renderSetup(): void {
    clear(root);
    const s = settings!;
    append(root,
      el('h1', {}, 'Sit'),
      el('p', { class: 'sub' }, profile!.gravitySource === 'sensor'
        ? 'Camera tilt is being corrected from the phone’s sensor.'
        : 'Camera tilt is assumed level — re-calibrate on the phone for better absolute numbers.'),
      cameraError
        ? el('div', { class: 'notice bad' },
            el('div', {}, cameraError),
            el('button', { class: 'ghost', style: 'margin-top:10px', onclick: () => { cameraError = null; renderSetup(); } }, 'Try again'))
        : null,
      stage,
      el('div', { class: 'card' },
        el('h3', {}, 'Mode'),
        el('div', { class: 'row', style: 'gap:8px' },
          modeButton('blind', 'Blind', 'Screen goes dark. Nothing to look at, nothing to chase.'),
          modeButton('live', 'Live feedback', 'See your posture and correct it as you go.')),
      ),
      el('div', { class: 'card' },
        el('label', { class: 'field' },
          el('span', {}, 'Length (minutes, 0 for open-ended)'),
          el('input', {
            type: 'number', min: 0, max: 180, value: s.plannedMinutes,
            onchange: (e: Event) => { s.plannedMinutes = Number((e.target as HTMLInputElement).value) || 0; },
          })),
        el('div', { class: 'small muted' },
          activeNudgeSummary(s)),
      ),
      el('button', {
        class: 'primary block', style: 'margin-top:14px', disabled: cameraError !== null,
        onclick: () => void start(),
      }, cameraError ? 'Camera unavailable' : 'Begin'),
      statusEl,
    );
    void preview();
  }

  function modeButton(m: SessionMode, label: string, desc: string): HTMLElement {
    return el('button', {
      class: mode === m ? 'primary' : '', style: 'flex:1;text-align:left',
      onclick: () => { mode = m; renderSetup(); },
    }, el('div', {}, label), el('div', { class: 'small', style: 'opacity:0.75;font-weight:400' }, desc));
  }

  function activeNudgeSummary(s: Settings): string {
    const on: string[] = [];
    if (s.nudges.visual && mode === 'live') on.push('gauges');
    if (s.nudges.chime) on.push('chime');
    if (s.nudges.glow) on.push('glow');
    if (!on.length) return 'No nudges enabled — feedback only in the report afterwards.';
    return `Nudges: ${on.join(', ')} · after ${s.nudges.minOutOfBandSec}s out of range, then quiet for ${s.nudges.cooldownSec}s.`;
  }

  /** Show the camera during setup so framing can be checked before starting. */
  async function preview(): Promise<void> {
    if (stream || disposed) return;
    try {
      stream = await startCamera(video, { facingMode: 'user' });
      landmarker = new PostureLandmarker({ sampleHz: settings!.sampleHz, withFace: settings!.withFace });
      await landmarker.load();
      landmarker.start(video, onFrame);
      if (cameraError) {
        cameraError = null;
        renderSetup();
      }
    } catch (err) {
      // Surface this properly rather than as fine print: without a camera
      // there is no session to begin.
      cameraError = err instanceof CameraError ? err.message : String(err);
      if (!disposed) renderSetup();
    }
  }

  /* --------------------------------------------------------------- running */

  function onFrame(r: { world: PoseFrame; screen: PoseFrame; inferenceMs: number; timestamp: number }): void {
    if (disposed) return;
    perf.record(r.inferenceMs, r.timestamp);
    if (mode === 'live' || !running) drawSkeleton(canvas, r.screen);

    if (!running || !recorder) return;
    const live = recorder.push(r.world, performance.now());
    if (!live) return;

    if (mode === 'live' && settings!.nudges.visual) {
      levelGauge.set(live.metrics.shoulderOnlyTilt);
      plumbGauge.set(live.metrics.lateralLean);
      rotationGauge.set(live.metrics.torsoTwist);
    }

    const decision = nudges!.evaluate(live.metrics, performance.now());
    if (settings!.nudges.glow) {
      const worstValue = decision.worst ? live.metrics[decision.worst] : 0;
      glow.set(decision.outOfBand ? decision.severity * 0.9 : 0,
        typeof worstValue === 'number' && worstValue > 0 ? 'left' : 'right');
    }
    if (decision.fire && settings!.nudges.chime) chime.play(settings!.nudges.chimeVolume);
  }

  async function start(): Promise<void> {
    if (!profile || !settings) return;
    // Audio must be unlocked from inside the gesture that began the session.
    await chime.unlock();
    await lock.acquire();

    recorder = new SessionRecorder(profile);
    recorder.begin(performance.now());
    nudges!.reset();
    startedAt = Date.now();
    running = true;

    if (profile.gravitySource === 'sensor') {
      tripod.start({ x: profile.gravityDown.x, y: profile.gravityDown.y, z: profile.gravityDown.z });
    }
    if (settings.startBell) chime.bell(0.3);

    if (mode === 'blind') showBlind();
    else showLive();

    tickTimer = window.setInterval(tick, 500);
  }

  function tick(): void {
    if (!running) return;
    const elapsed = Date.now() - startedAt;
    timerEl.textContent = fmtDuration(elapsed);
    const planned = (settings?.plannedMinutes ?? 0) * 60_000;
    if (planned > 0 && elapsed >= planned) void finish();
  }

  function showBlind(): void {
    // As close to off as a screen that must stay awake can get: the camera
    // needs the page foregrounded, so darkness is the best available.
    blindEl = el('div', { class: 'blind' },
      el('div', { class: 'dot' }),
      el('div', { class: 'hold' }, 'press and hold to end'),
    );
    let holdTimer: number | null = null;
    const beginHold = () => { holdTimer = window.setTimeout(() => void finish(), 2000); };
    const cancelHold = () => { if (holdTimer) window.clearTimeout(holdTimer); holdTimer = null; };
    blindEl.addEventListener('pointerdown', beginHold);
    blindEl.addEventListener('pointerup', cancelHold);
    blindEl.addEventListener('pointercancel', cancelHold);
    blindEl.addEventListener('pointerleave', cancelHold);
    document.body.append(blindEl);
  }

  function showLive(): void {
    clear(root);
    clear(panel);
    panel.append(
      el('div', { class: 'row spread', style: 'align-items:center;margin-bottom:12px' },
        timerEl,
        el('button', { class: 'ghost', onclick: () => void finish() }, 'End')),
      stage,
      el('div', { class: 'card' },
        el('div', { class: 'row', style: 'gap:4px' },
          el('div', { style: 'flex:1;text-align:center' }, el('h3', {}, 'Shoulders'), levelGauge.root),
          el('div', { style: 'flex:1;text-align:center' }, el('h3', {}, 'Lean'), plumbGauge.root),
          el('div', { style: 'flex:1;text-align:center' }, el('h3', {}, 'Twist'), rotationGauge.root))),
      el('div', { class: 'card small muted' },
        'The shoulder gauge already has whole-body lean subtracted, so it shows asymmetry rather than listing.'),
    );
    root.append(panel);
  }

  async function finish(): Promise<void> {
    if (!running || !recorder || !profile) return;
    running = false;
    if (tickTimer) window.clearInterval(tickTimer);
    blindEl?.remove();
    blindEl = null;
    glow.clear();

    const result = recorder.end(performance.now());
    const drift = tripod.driftDegrees();
    tripod.stop();
    void lock.release();
    if (settings?.endBell) chime.bell(0.3);

    const id = newId();
    await saveSession(
      {
        id,
        profileId: profile.id,
        startedAt,
        durationMs: result.durationMs,
        mode,
        quality: result.quality,
        hipQuality: result.hipQuality,
        // Beyond about a degree the camera has genuinely moved and the
        // session's angles no longer share a baseline with the others.
        tripodMoved: drift !== null && drift > 1.5,
        tripodDriftDeg: drift,
        notes: '',
        headSource: settings?.withFace ? 'face-model' : 'pose-fallback',
      },
      result.samples,
    );

    landmarker?.stop();
    navigate(`#/report/${id}`);
  }

  void init();

  return () => {
    disposed = true;
    running = false;
    if (tickTimer) window.clearInterval(tickTimer);
    blindEl?.remove();
    tripod.stop();
    glow.destroy();
    chime.close();
    void lock.release();
    landmarker?.close();
    stopCamera(stream);
  };
}
