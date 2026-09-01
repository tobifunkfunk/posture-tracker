/**
 * The session itself. Two modes share one recording pipeline: what differs is
 * only how much the screen tells you while you sit.
 */
import { el, append, clear, fmtDuration } from '../dom';
import { startCamera, stopCamera, CameraError, ScreenLock } from '../../capture/camera';
import { PostureLandmarker, PerfMeter } from '../../capture/landmarker';
import { TripodWatcher } from '../../capture/orientation';
import { SessionRecorder } from '../../posture/recorder';
import { RollingMean } from '../../posture/filter';
import type { CameraProfile, PoseFrame } from '../../posture/types';
import type { Polyline } from '../../posture/contour';
import type { TrunkAxis } from '../../posture/silhouette';
import { cameraRollFromGravity } from '../../posture/silhouette';
import {
  blankProfile, getProfile, getSettings, listProfiles, newId, saveProfile, saveSession,
  type SessionMode, type Settings,
} from '../../store/db';
import { AutoCalibrator, applyYawCorrection, poolAzimuth } from '../../posture/autocalibrate';
import { calibrateGravity } from '../../posture/frames';
import { motionPermissionState, requestMotionPermission, readGravity } from '../../capture/orientation';
import { toPhysics } from '../../posture/frames';
import { AmbientGlow, Chime, NudgeEngine } from '../../nudge';
import { LevelGauge, PlumbGauge, RotationGauge } from '../gauges';
import { drawOverlay } from '../overlay';
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
  // Rotation is depth-derived and far noisier than tilt, so the live dial
  // reads a 30 second average rather than the instantaneous value.
  const twistAverage = new RollingMean(30);
  let calibrator: AutoCalibrator | null = null;
  let latestWorld: PoseFrame | null = null;
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
      // Fall back to any existing setup before inventing a new one, so a
      // cleared active-profile setting does not orphan the history.
      const existing = await listProfiles();
      profile = existing[0] ?? blankProfile();
      if (!existing.length) await saveProfile(profile);
      settings.activeProfileId = profile.id;
    }

    nudges = new NudgeEngine(settings.nudges, settings.tolerance);
    renderSetup();
  }

  function renderSetup(): void {
    clear(root);
    const s = settings!;
    append(root,
      el('h1', {}, 'Sit'),
      el('p', { class: 'sub' }, profile!.sessionCount === 0
        ? 'Just sit. The app measures its own setup as you go — shoulder height and tilt are referenced to gravity and work from the very first sit.'
        : `Setup learned from ${profile!.sessionCount} sit${profile!.sessionCount === 1 ? '' : 's'}. Tilt is corrected from the phone’s sensor each time.`),
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
      landmarker = new PostureLandmarker({
        sampleHz: settings!.sampleHz,
        // Always on: the outline is not decoration, it is where the trunk
        // axis comes from now that the hips are not relied on.
        withSegmentation: true,
        cameraRollRad: cameraRollFromGravity(profile!.gravityDown),
      });
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

  function onFrame(r: {
    world: PoseFrame; screen: PoseFrame; contours: Polyline[] | null;
    trunkAxis: TrunkAxis | null; inferenceMs: number; timestamp: number;
  }): void {
    if (disposed) return;
    perf.record(r.inferenceMs, r.timestamp);

    // Nothing is visible during a blind sit, so skip the drawing entirely.
    if (mode === 'live' || !running) {
      drawOverlay(canvas, {
        frame: r.screen,
        contours: r.contours,
        style: settings!.overlayStyle,
        showGuides: true,
      });
    }

    if (!running || !recorder) return;
    latestWorld = r.world;
    const live = recorder.push(r.world, performance.now(), r.trunkAxis);
    if (!live) return;

    // Every frame tells us a little about where the camera actually stands.
    calibrator?.observe(
      live.metrics.torsoYaw,
      profile!.refShoulderWidth,
      live.metrics.hipsReliable,
    );

    if (mode === 'live' && settings!.nudges.visual) {
      levelGauge.set(live.metrics.shoulderOnlyTilt);
      plumbGauge.set(live.metrics.lateralLean);
      rotationGauge.set(twistAverage.push(live.metrics.torsoTwist, live.elapsedMs / 1000));
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
    // Both of these must happen inside the gesture that began the session:
    // browsers start audio suspended, and iOS only grants motion access from
    // a user action.
    await chime.unlock();
    await lock.acquire();
    await measureGravity();

    recorder = new SessionRecorder(profile);
    recorder.begin(performance.now());
    calibrator = new AutoCalibrator(profile.azimuth);
    nudges!.reset();
    twistAverage.reset();
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

  /**
   * Read the phone's gravity vector at the start of every sit.
   *
   * Doing it per session rather than once at setup means a tripod that gets
   * nudged between sits corrects itself, with no ritual and nothing to
   * remember. The accelerometer's sign convention differs between engines, so
   * it is resolved against the body the camera can already see.
   */
  async function measureGravity(): Promise<void> {
    if (!profile) return;
    if (motionPermissionState() === 'prompt') await requestMotionPermission();

    const reading = await readGravity(1600);
    if (!reading || reading.samples < 5 || reading.stability > 1.2) {
      statusEl.textContent = profile.gravitySource === 'sensor'
        ? 'No fresh tilt reading — using the last good one.'
        : 'No tilt sensor available; assuming the camera is level.';
      return;
    }

    const frames = latestWorld ? [toPhysics(latestWorld)] : [];
    const resolved = calibrateGravity({ reading: reading.vector, sampleFrames: frames });
    if (resolved.confident || profile.gravitySource !== 'sensor') {
      profile.gravityDown = resolved.gravityDown;
      profile.gravitySource = resolved.confident ? 'sensor' : 'assumed-level';
    }
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
          el('div', { style: 'flex:1;text-align:center' }, el('h3', {}, 'Twist (30s)'), rotationGauge.root))),
      el('div', { class: 'card small muted' },
        'The shoulder gauge already has whole-body lean subtracted, so it shows asymmetry rather than listing. '
        + 'Twist is averaged over 30 seconds — it is derived from depth, which the model estimates far less precisely, '
        + 'so an instantaneous reading would be mostly noise.'),
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

    /*
     * Now that the sit is over, use it to improve the setup estimate. Yaw is
     * offset exactly by any azimuth error, so the stored samples can simply be
     * shifted onto the better estimate — which is what allows recording to
     * begin immediately instead of after a settling period.
     */
    let setupChanged = false;
    const estimate = calibrator?.estimate() ?? null;
    if (estimate) {
      const pooled = poolAzimuth(profile.azimuth, profile.sessionCount, estimate);
      setupChanged = pooled.setupChanged;
      applyYawCorrection(result.samples, (pooled.azimuth - profile.azimuth) * (180 / Math.PI));

      profile = {
        ...profile,
        azimuth: pooled.azimuth,
        sessionCount: pooled.setupChanged ? 1 : profile.sessionCount + 1,
        refShoulderWidth: Number.isFinite(calibrator!.shoulderWidth)
          ? calibrator!.shoulderWidth : profile.refShoulderWidth,
        hipsUsable: calibrator!.hipsUsable,
      };
      await saveProfile(profile);
    }
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
        setupChanged,
        tripodDriftDeg: drift,
        notes: '',
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
