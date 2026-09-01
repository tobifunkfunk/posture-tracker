/**
 * Calibration. Everything the KPIs mean depends on this screen getting four
 * things right: the camera's level, whether the feed is mirrored, the
 * tripod's angle off-axis, and where the meditator's own neutral sits.
 */
import { el, clear, fmt } from '../dom';
import { startCamera, stopCamera, CameraError, guessMirrored } from '../../capture/camera';
import { PostureLandmarker } from '../../capture/landmarker';
import { motionPermissionState, requestMotionPermission, readGravity } from '../../capture/orientation';
import {
  applyMirror, calibrateAzimuth, calibrateGravity, gravityMatrix, landmarkDistance,
  rotateFrame, toPhysics, trunkVector,
} from '../../posture/frames';
import { PoseIdx, type CameraProfile, type PoseFrame } from '../../posture/types';
import { median } from '../../posture/vec';
import { newId, saveProfile, getSettings, saveSettings } from '../../store/db';
import { QualityMeter, qualityAdvice } from '../../posture/quality';
import { drawOverlay } from '../overlay';
import { navigate } from '../../router';

type Stage = 'intro' | 'framing' | 'level' | 'mirror' | 'reference' | 'done';

export function calibrateScreen(root: HTMLElement): () => void {
  let stage: Stage = 'intro';
  let stream: MediaStream | null = null;
  let landmarker: PostureLandmarker | null = null;
  let latest: PoseFrame | null = null;      // RAW world landmarks
  let latestScreen: PoseFrame | null = null; // normalised, for the overlay
  let disposed = false;

  // Collected as the stages complete.
  let gravityDown = { x: 0, y: -1, z: 0 };
  let gravitySource: CameraProfile['gravitySource'] = 'assumed-level';
  let mirrored = guessMirrored('user');
  let azimuth = 0;
  let refWidth = NaN;
  let refTrunk = NaN;
  let statusText = '';
  const quality = new QualityMeter(60);

  const video = el('video', { playsinline: true, muted: true, class: 'mirror' });
  const canvas = el('canvas', { width: 480, height: 640, class: 'mirror' });
  const body = el('div');
  const qualityPanel = el('div', { class: 'card', style: 'margin-top:10px' });
  const framingNotice = el('div', { class: 'notice' }, 'Looking for you…');
  const framingButton = el('button', {
    class: 'primary block', style: 'margin-top:12px', disabled: true,
    onclick: () => { stage = 'level'; render(); void measureLevel(); },
  }, 'Framing looks right');

  const render = () => {
    if (disposed) return;
    clear(body);
    body.append(stageView());
  };

  /* ---------------------------------------------------------------- stages */

  function stageList(): HTMLElement {
    const order = ['framing', 'level', 'mirror', 'reference'] as const;
    const names: Record<(typeof order)[number], string> = {
      framing: 'Frame yourself in the shot',
      level: 'Measure the camera tilt',
      mirror: 'Check left and right',
      reference: 'Capture your neutral sit',
    };
    const currentIdx = order.indexOf(stage as (typeof order)[number]);
    return el('ol', { class: 'steps' },
      ...order.map((s, i) =>
        el('li', { class: i < currentIdx || stage === 'done' ? 'done' : i === currentIdx ? 'active' : '' },
          names[s])),
    );
  }

  function stageView(): HTMLElement {
    switch (stage) {
      case 'intro':
        return el('div', {},
          el('p', { class: 'sub' },
            'Four quick steps. They are what let the app tell a crooked tripod from a crooked spine — without them every angle it reports is partly about the camera.'),
          el('div', { class: 'card' },
            el('h3', {}, 'Before you start'),
            el('ul', { class: 'small muted', style: 'padding-left:18px;margin:0' },
              el('li', {}, 'Put the phone on the tripod about 1.5–2 m away, roughly at chest height.'),
              el('li', {}, 'Stand it about 35° off to one side, not straight in front.'),
              el('li', {}, 'Mark the tripod feet and your cushion with tape. If either moves, this calibration stops being valid.'),
              el('li', {}, 'Wear something reasonably close-fitting — loose fabric moves the shoulder landmarks more than the asymmetry you are looking for.'))),
          el('button', { class: 'primary block', style: 'margin-top:16px', onclick: () => { stage = 'framing'; render(); void begin(); } }, 'Start calibration'));

      case 'framing':
        updateFraming();
        return el('div', {}, stageList(), framingNotice, qualityPanel, framingButton);

      case 'level':
        return el('div', {},
          stageList(),
          el('p', { class: 'sub' }, statusText || 'Hold still — reading the phone’s tilt sensor.'),
          el('div', { class: 'card small muted' },
            'The phone reports which way is down, so the app can subtract the tripod’s own tilt. A 3° lean in the tripod would otherwise read as a 3° drop in your shoulder.'));

      case 'mirror':
        return el('div', {},
          stageList(),
          el('div', { class: 'notice' },
            el('strong', {}, 'Raise your right hand'), ' and hold it up until this advances.'),
          el('p', { class: 'small muted' },
            'A mirrored feed makes the pose model label your left side as your right. This is the only reliable way to settle it.'),
          el('button', { class: 'ghost block', onclick: () => { mirrored = !mirrored; statusText = ''; render(); } },
            `Currently assuming: ${mirrored ? 'mirrored' : 'not mirrored'} — tap to flip`));

      case 'reference':
        return el('div', {},
          stageList(),
          el('p', { class: 'sub' }, statusText || 'Sit the way you mean to sit. As balanced and as square to the front as you can manage. Hold it.'),
          el('div', { class: 'card small muted' },
            'This becomes your zero. Rotation and forward lean are measured against this sit, not against the room — so "am I twisted compared to my own normal?" is the question the numbers answer.'));

      case 'done':
        return el('div', {},
          el('div', { class: 'notice good' }, 'Calibration saved.'),
          el('div', { class: 'card' },
            el('div', { class: 'kpi' }, el('span', { class: 'label' }, 'Camera off-axis'), el('span', { class: 'value' }, fmt((azimuth * 180) / Math.PI, '°'))),
            el('div', { class: 'kpi' }, el('span', { class: 'label' }, 'Camera tilt corrected'), el('span', { class: 'value' }, gravitySource === 'sensor' ? 'yes, from sensor' : 'assumed level')),
            el('div', { class: 'kpi' }, el('span', { class: 'label' }, 'Feed mirrored'), el('span', { class: 'value' }, mirrored ? 'yes' : 'no')),
            el('div', { class: 'kpi' }, el('span', { class: 'label' }, 'Shoulder width'), el('span', { class: 'value' }, fmt(refWidth * 100, ' cm'))),
          ),
          gravitySource !== 'sensor'
            ? el('div', { class: 'notice', style: 'margin-top:12px' },
                'No tilt sensor reading, so the app is assuming the camera is level. Shoulder-height numbers will carry whatever tilt the tripod has. Trends stay usable; absolute values do not.')
            : null,
          el('button', { class: 'primary block', style: 'margin-top:16px', onclick: () => navigate('#/session') }, 'Sit now'),
          el('button', { class: 'ghost block', style: 'margin-top:8px', onclick: () => navigate('#/') }, 'Back to start'));
    }
  }

  /* ------------------------------------------------------------- machinery */

  async function begin(): Promise<void> {
    try {
      stream = await startCamera(video, { facingMode: 'user' });
      landmarker = new PostureLandmarker({ sampleHz: 8, withSegmentation: true });
      await landmarker.load();
      landmarker.start(video, (r) => {
        latest = r.world;
        latestScreen = r.screen;
        if (stage === 'framing') {
          quality.push(toPhysics(r.world));
          updateFraming();
          updateQualityPanel();
        }
        drawOverlay(canvas, {
          frame: r.screen,
          contours: r.contours,
          style: 'outline',
          // Guides would distract from the one job here: get fully in frame.
          showGuides: false,
        });
        if (stage === 'mirror') render();
      });
    } catch (err) {
      statusText = err instanceof CameraError ? err.message : String(err);
      body.prepend(el('div', { class: 'notice bad' }, statusText));
    }
  }

  /**
   * Framing feedback, updated in place from the frame callback. Re-rendering
   * the whole screen at the capture rate would churn the DOM for no reason.
   */
  function updateFraming(): void {
    const ok = framingCheck();
    framingNotice.className = ok.ready ? 'notice good' : 'notice';
    framingNotice.textContent = ok.message;
    framingButton.disabled = !ok.ready;
  }

  /**
   * Live measurement quality, so setup choices can be tested rather than
   * guessed at. Changing the background, the light or the shirt moves the
   * jitter number within a few seconds.
   */
  function updateQualityPanel(): void {
    const r = quality.read(latestScreen);
    const tone = r.verdict === 'excellent' || r.verdict === 'good'
      ? 'good' : r.verdict === 'poor' ? 'bad' : 'warn';

    clear(qualityPanel);
    qualityPanel.append(
      el('div', { class: 'row spread', style: 'align-items:center' },
        el('h3', { style: 'margin:0' }, 'Signal quality'),
        el('span', { class: `badge ${tone}` }, r.verdict)),
      el('div', { class: 'kpi' },
        el('div', {},
          el('span', { class: 'label' }, 'Steadiness'),
          el('div', { class: 'hint' }, 'how much the shoulder reading wobbles while you hold still')),
        el('span', { class: 'value' },
          r.samples < 20 ? '…' : `±${r.jitterDeg.toFixed(2)}°`)),
      el('div', { class: 'kpi' },
        el('div', {},
          el('span', { class: 'label' }, 'Body visibility'),
          el('div', { class: 'hint' },
            r.worstVisibility < 0.6 && r.worstName ? `weakest: ${r.worstName}` : 'all key points seen')),
        el('span', { class: 'value' }, `${Math.round(r.visibility * 100)}%`)),
      el('div', { class: 'small muted', style: 'margin-top:6px' }, qualityAdvice(r)),
    );
  }

  /** Everything the KPIs need must be visible, and the body reasonably centred. */
  function framingCheck(): { ready: boolean; message: string } {
    if (!latestScreen) return { ready: false, message: 'Looking for you…' };
    const need = [PoseIdx.LeftShoulder, PoseIdx.RightShoulder, PoseIdx.LeftHip, PoseIdx.RightHip, PoseIdx.Nose];
    const missing = need.filter((i) => (latestScreen![i]?.visibility ?? 0) < 0.5);
    if (missing.length) {
      const hips = missing.some((i) => i === PoseIdx.LeftHip || i === PoseIdx.RightHip);
      return {
        ready: false,
        message: hips
          ? 'Your hips are not clearly visible. Move the camera back, or drape less over your lap — the lean and twist numbers depend on them.'
          : 'Move so your head, shoulders and hips are all in frame.',
      };
    }
    const ls = latestScreen[PoseIdx.LeftShoulder];
    const rs = latestScreen[PoseIdx.RightShoulder];
    const cx = (ls.x + rs.x) / 2;
    if (cx < 0.25 || cx > 0.75) return { ready: false, message: 'Shift so you sit nearer the middle of the frame.' };
    const width = Math.abs(ls.x - rs.x);
    if (width < 0.12) return { ready: false, message: 'You are rather far away. Move the tripod closer — around 1.5 m works well.' };
    if (width > 0.55) return { ready: false, message: 'Too close. Move the tripod back so your whole torso has room.' };
    return { ready: true, message: 'Good framing — head, shoulders and hips are all clearly visible.' };
  }

  async function measureLevel(): Promise<void> {
    const perm = motionPermissionState();
    if (perm === 'prompt') {
      statusText = 'Allow motion access so the app can measure the tripod’s tilt.';
      render();
      const granted = await requestMotionPermission();
      if (granted !== 'granted') {
        gravitySource = 'assumed-level';
        statusText = 'Motion access refused — assuming the camera is level.';
        render();
        window.setTimeout(() => { stage = 'mirror'; render(); void watchForRaisedHand(); }, 1400);
        return;
      }
    } else if (perm === 'unsupported') {
      gravitySource = 'assumed-level';
      stage = 'mirror';
      render();
      void watchForRaisedHand();
      return;
    }

    statusText = 'Hold still…';
    render();
    const reading = await readGravity(2200);

    if (!reading || reading.samples < 5) {
      gravitySource = 'assumed-level';
      statusText = 'No usable sensor reading — assuming level.';
    } else if (reading.stability > 1.2) {
      gravitySource = 'assumed-level';
      statusText = 'The rig was still moving. Assuming level; re-run calibration once it settles.';
    } else {
      // Resolve the accelerometer's sign against a body we can actually see.
      const frames: PoseFrame[] = [];
      for (let i = 0; i < 6 && latest; i++) {
        frames.push(toPhysics(latest));
        await new Promise((r) => window.setTimeout(r, 90));
      }
      const resolved = calibrateGravity({ reading: reading.vector, sampleFrames: frames });
      gravityDown = resolved.gravityDown;
      gravitySource = resolved.confident ? 'sensor' : 'assumed-level';
      const tiltDeg = (Math.acos(Math.min(1, Math.max(-1, -gravityDown.y))) * 180) / Math.PI;
      statusText = resolved.confident
        ? `Camera tilt measured: ${tiltDeg.toFixed(1)}° off level. It will be subtracted from every reading.`
        : 'Could not confirm the sensor against your body — assuming level.';
    }

    render();
    window.setTimeout(() => { stage = 'mirror'; render(); void watchForRaisedHand(); }, 1800);
  }

  /**
   * Settle mirroring by watching which wrist goes up. Under the current
   * `mirrored` assumption the raised wrist should be labelled the RIGHT one;
   * if the model says left, the assumption is backwards.
   */
  async function watchForRaisedHand(): Promise<void> {
    const deadline = Date.now() + 25_000;
    while (!disposed && stage === 'mirror' && Date.now() < deadline) {
      await new Promise((r) => window.setTimeout(r, 160));
      if (!latest) continue;

      const frame = applyMirror(toPhysics(latest), mirrored);
      const lw = frame[15];
      const rw = frame[16];
      const shoulderY = ((frame[PoseIdx.LeftShoulder]?.y ?? 0) + (frame[PoseIdx.RightShoulder]?.y ?? 0)) / 2;
      if (!lw || !rw) continue;

      const leftUp = lw.visibility > 0.6 && lw.y > shoulderY + 0.12;
      const rightUp = rw.visibility > 0.6 && rw.y > shoulderY + 0.12;
      if (leftUp === rightUp) continue;

      if (leftUp) {
        // They raised their right hand but the model called it left: flip.
        mirrored = !mirrored;
        statusText = 'Mirroring corrected.';
      } else {
        statusText = 'Left and right confirmed.';
      }
      render();
      window.setTimeout(() => { stage = 'reference'; render(); void captureReference(); }, 1200);
      return;
    }
    if (stage === 'mirror' && !disposed) {
      statusText = 'Skipped the hand check — keeping the current assumption.';
      stage = 'reference';
      render();
      void captureReference();
    }
  }

  /** Ten seconds of the meditator's own neutral, which becomes zero. */
  async function captureReference(): Promise<void> {
    const uprightFrames: PoseFrame[] = [];
    const widths: number[] = [];
    const trunks: number[] = [];
    const gm = gravityMatrix(gravityDown);

    for (let i = 0; i < 60 && !disposed; i++) {
      statusText = `Hold your neutral sit… ${Math.ceil((60 - i) / 6)}s`;
      if (i % 6 === 0) render();
      await new Promise((r) => window.setTimeout(r, 170));
      if (!latest) continue;

      const upright = rotateFrame(applyMirror(toPhysics(latest), mirrored), gm);
      const quality = Math.min(
        upright[PoseIdx.LeftShoulder]?.visibility ?? 0,
        upright[PoseIdx.RightShoulder]?.visibility ?? 0,
      );
      if (quality < 0.6) continue;

      uprightFrames.push(upright);
      widths.push(landmarkDistance(upright[PoseIdx.LeftShoulder], upright[PoseIdx.RightShoulder]));
      const t = trunkVector(upright);
      if (t) trunks.push(Math.hypot(t.x, t.y, t.z));
    }

    if (uprightFrames.length < 10) {
      statusText = 'Not enough clean frames. Check the light and the framing, then try again.';
      stage = 'framing';
      render();
      return;
    }

    const result = calibrateAzimuth(uprightFrames);
    azimuth = result.azimuth;
    refWidth = median(widths);
    refTrunk = median(trunks);

    const profile: CameraProfile = {
      id: newId(),
      name: `Setup ${new Date().toLocaleDateString()}`,
      createdAt: Date.now(),
      gravityDown,
      mirrored,
      azimuth,
      refShoulderWidth: refWidth,
      refTrunkLength: refTrunk,
      gravitySource,
    };
    await saveProfile(profile);
    const settings = await getSettings();
    await saveSettings({ ...settings, activeProfileId: profile.id });

    stage = 'done';
    render();
  }

  /* ----------------------------------------------------------------- mount */

  root.append(
    el('h1', {}, 'Set up the camera'),
    el('div', { class: 'stage', style: 'margin-bottom:16px' }, video, canvas),
    body,
  );
  render();

  return () => {
    disposed = true;
    landmarker?.close();
    stopCamera(stream);
  };
}
