import { describe, expect, it } from 'vitest';
import { makeBody, profileFor, project, gravityFor, DIMS } from './synthetic';
import { toBodyFrame, calibrateAzimuth, calibrateGravity, toPhysics, applyMirror, rotateFrame, gravityMatrix } from '../src/posture/frames';
import { computeMetrics } from '../src/posture/metrics';
import { correlate, summarize } from '../src/posture/aggregate';
import { OneEuroFilter } from '../src/posture/filter';
import { applyMat3, rotationBetween, normalize, vec, len, sub } from '../src/posture/vec';
import { PoseIdx, type Sample } from '../src/posture/types';

/** Run a body pose through a camera setup and back out to KPIs. */
function measure(pose: Parameters<typeof makeBody>[0], setup: Parameters<typeof project>[1] = {}) {
  const raw = project(makeBody(pose), setup);
  return computeMetrics(toBodyFrame(raw, profileFor(setup)), profileFor(setup));
}

describe('rotationBetween', () => {
  it('carries one unit vector onto another', () => {
    const from = normalize(vec(0.3, -0.9, 0.2));
    const to = normalize(vec(0, -1, 0));
    const r = applyMat3(rotationBetween(from, to), from);
    expect(len(sub(r, to))).toBeLessThan(1e-9);
  });

  it('is the identity for already-aligned vectors', () => {
    const v = normalize(vec(1, 2, 3));
    const r = applyMat3(rotationBetween(v, v), v);
    expect(len(sub(r, v))).toBeLessThan(1e-9);
  });

  it('handles exactly opposed vectors', () => {
    const from = normalize(vec(0, -1, 0));
    const to = normalize(vec(0, 1, 0));
    const r = applyMat3(rotationBetween(from, to), from);
    expect(len(sub(r, to))).toBeLessThan(1e-9);
  });
});

describe('a neutral body seen by a perfect camera', () => {
  it('reads zero on every angle', () => {
    const m = measure({});
    expect(m.shoulderTilt).toBeCloseTo(0, 6);
    expect(m.lateralLean).toBeCloseTo(0, 6);
    expect(m.sagittalLean).toBeCloseTo(0, 6);
    expect(m.torsoYaw).toBeCloseTo(0, 6);
    expect(m.torsoTwist).toBeCloseTo(0, 6);
    expect(m.shoulderDropMm).toBeCloseTo(0, 6);
    expect(m.hipsReliable).toBe(true);
  });
});

describe('camera bias cancellation', () => {
  it('cancels a 10 deg tripod roll', () => {
    const m = measure({}, { rollDeg: 10 });
    expect(m.shoulderTilt).toBeCloseTo(0, 6);
    expect(m.lateralLean).toBeCloseTo(0, 6);
  });

  it('cancels roll and pitch together', () => {
    const m = measure({}, { rollDeg: -7, pitchDeg: 12 });
    expect(m.shoulderTilt).toBeCloseTo(0, 6);
    expect(m.lateralLean).toBeCloseTo(0, 6);
    expect(m.sagittalLean).toBeCloseTo(0, 6);
  });

  it('cancels the 35 deg oblique placement', () => {
    const m = measure({}, { azimuthDeg: 35 });
    expect(m.torsoYaw).toBeCloseTo(0, 6);
    expect(m.shoulderTilt).toBeCloseTo(0, 6);
  });

  it('cancels a mirrored feed without swapping left and right', () => {
    const straight = measure({ shoulderExtraTilt: 4 });
    const mirrored = measure({ shoulderExtraTilt: 4 }, { mirrored: true });
    expect(mirrored.shoulderTilt).toBeCloseTo(straight.shoulderTilt, 6);
    expect(mirrored.shoulderTilt).toBeGreaterThan(0);
  });

  it('cancels everything at once', () => {
    const m = measure({}, { azimuthDeg: 35, rollDeg: 8, pitchDeg: -5, mirrored: true });
    expect(m.shoulderTilt).toBeCloseTo(0, 6);
    expect(m.lateralLean).toBeCloseTo(0, 6);
    expect(m.sagittalLean).toBeCloseTo(0, 6);
    expect(m.torsoYaw).toBeCloseTo(0, 6);
  });
});

describe('KPI 1/2 - shoulder height', () => {
  it('reports a pure shoulder tilt at its true magnitude', () => {
    const m = measure({ shoulderExtraTilt: 5 }, { azimuthDeg: 35 });
    expect(m.shoulderTilt).toBeCloseTo(5, 4);
  });

  it('signs a positive tilt as the left shoulder being higher', () => {
    const m = measure({ shoulderExtraTilt: 5 });
    expect(m.shoulderDropMm).toBeGreaterThan(0);
    // 5 deg across a 38cm shoulder span lifts the left shoulder ~17mm.
    expect(m.shoulderDropMm).toBeCloseTo(Math.sin((5 * Math.PI) / 180) * DIMS.SHOULDER_HALF * 2 * 1000, 1);
  });

  it('expresses the drop as a fraction of shoulder width', () => {
    const m = measure({ shoulderExtraTilt: 5 });
    expect(m.shoulderDropRatio).toBeCloseTo(Math.sin((5 * Math.PI) / 180), 4);
  });
});

describe('KPI 3/4 - separating a dropped shoulder from a listing trunk', () => {
  it('reads a whole-body lean as lean, not as shoulder asymmetry', () => {
    const m = measure({ lateralLean: 6 }, { azimuthDeg: 35 });
    expect(m.lateralLean).toBeCloseTo(6, 4);
    // The shoulder line tilts with the body, but the asymmetry KPI removes it.
    expect(m.shoulderTilt).toBeCloseTo(-6, 4);
    expect(m.shoulderOnlyTilt).toBeCloseTo(0, 4);
  });

  it('reads a genuinely uneven shoulder girdle as asymmetry, not lean', () => {
    const m = measure({ shoulderExtraTilt: 4 }, { azimuthDeg: 35 });
    expect(m.lateralLean).toBeCloseTo(0, 4);
    expect(m.shoulderOnlyTilt).toBeCloseTo(4, 4);
  });

  it('separates the two when both happen together', () => {
    const m = measure({ lateralLean: 6, shoulderExtraTilt: 4 }, { azimuthDeg: 35 });
    expect(m.lateralLean).toBeCloseTo(6, 3);
    expect(m.shoulderOnlyTilt).toBeCloseTo(4, 3);
  });
});

describe('KPI 5 - forward lean', () => {
  it('recovers a forward slump from the oblique camera', () => {
    const m = measure({ sagittalLean: 8 }, { azimuthDeg: 35 });
    expect(m.sagittalLean).toBeCloseTo(8, 4);
  });

  it('signs leaning back as negative', () => {
    expect(measure({ sagittalLean: -8 }).sagittalLean).toBeCloseTo(-8, 4);
  });
});

describe('KPI 6/7/8 - rotation and twist', () => {
  it('reports a whole-body turn as yaw with no twist', () => {
    const m = measure({ bodyYaw: 12 }, { azimuthDeg: 35 });
    expect(m.torsoYaw).toBeCloseTo(12, 4);
    expect(m.pelvisYaw).toBeCloseTo(12, 4);
    // A cushion sitting at an angle turns shoulders and hips together.
    expect(m.torsoTwist).toBeCloseTo(0, 4);
  });

  it('reports shoulders turned against the hips as twist', () => {
    const m = measure({ shoulderExtraYaw: 9 }, { azimuthDeg: 35 });
    expect(m.pelvisYaw).toBeCloseTo(0, 4);
    expect(m.torsoTwist).toBeCloseTo(9, 4);
  });

  it('separates a turned cushion from a real twist', () => {
    const m = measure({ bodyYaw: 12, shoulderExtraYaw: 9 }, { azimuthDeg: 35 });
    expect(m.pelvisYaw).toBeCloseTo(12, 4);
    expect(m.torsoTwist).toBeCloseTo(9, 4);
  });
});

describe('KPI 9/10 - head', () => {
  it('reports head rotation relative to the shoulders', () => {
    const m = measure({ headYaw: 10 }, { azimuthDeg: 35 });
    expect(m.headYawVsShoulders).toBeCloseTo(10, 3);
  });

  it('does not blame the head when the whole body turns', () => {
    const m = measure({ bodyYaw: 15 }, { azimuthDeg: 35 });
    expect(m.headYawVsShoulders).toBeCloseTo(0, 3);
  });

  it('reports head roll relative to the shoulders', () => {
    const m = measure({ headRoll: 7 }, { azimuthDeg: 35 });
    expect(m.headRollVsShoulders).toBeCloseTo(7, 3);
  });

  it('measures the nose offset from the shoulder midline', () => {
    const straight = measure({});
    expect(straight.headLateralOffset).toBeCloseTo(0, 4);
    expect(measure({ headRoll: 20 }).headLateralOffset).not.toBeCloseTo(0, 2);
  });
});

describe('hip gating', () => {
  it('flags hips as unreliable when the cushion hides them', () => {
    const body = makeBody({});
    body[PoseIdx.LeftHip].visibility = 0.2;
    body[PoseIdx.RightHip].visibility = 0.3;
    const m = computeMetrics(toBodyFrame(project(body), profileFor()), profileFor());
    expect(m.hipsReliable).toBe(false);
    // Shoulder KPIs stay usable even when the hips are hidden.
    expect(m.upperQuality).toBeGreaterThan(0.6);
    expect(Number.isFinite(m.shoulderTilt)).toBe(true);
  });
});

describe('calibration', () => {
  it('recovers the camera azimuth from a reference sit', () => {
    const setup = { azimuthDeg: 35 };
    const upright = Array.from({ length: 20 }, () => {
      const raw = project(makeBody({}), setup);
      return rotateFrame(applyMirror(toPhysics(raw), false), gravityMatrix(gravityFor(setup)));
    });
    const { azimuth, spreadDeg } = calibrateAzimuth(upright);
    expect((azimuth * 180) / Math.PI).toBeCloseTo(35, 3);
    expect(spreadDeg).toBeLessThan(1);
  });

  it('resolves the accelerometer sign against the visible body', () => {
    const setup = { rollDeg: 6 };
    const frames = Array.from({ length: 5 }, () => toPhysics(project(makeBody({}), setup)));
    const g = gravityFor(setup);

    const right = calibrateGravity({ reading: g, sampleFrames: frames });
    expect(right.flipped).toBe(false);
    expect(right.confident).toBe(true);

    // Feed the opposite convention: it must flip back to the same answer.
    const wrong = calibrateGravity({ reading: { x: -g.x, y: -g.y, z: -g.z }, sampleFrames: frames });
    expect(wrong.flipped).toBe(true);
    expect(wrong.gravityDown.y).toBeCloseTo(g.y, 6);
  });
});

describe('One Euro filter', () => {
  /** Deterministic pseudo-random jitter, so the test cannot flake. */
  function jitter(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return (s / 4294967296 - 0.5) * 2;
    };
  }

  const sd = (xs: number[]) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  };

  it('suppresses landmark jitter while sitting still', () => {
    // +/-1 degree of noise at 5Hz, which is roughly what MediaPipe delivers
    // on a motionless subject.
    const rand = jitter(42);
    const f = new OneEuroFilter();
    const inputs: number[] = [];
    const outputs: number[] = [];
    for (let i = 0; i < 300; i++) {
      const x = rand();
      inputs.push(x);
      outputs.push(f.filter(x, i / 5));
    }
    // A first-order filter at these settings should roughly halve the noise;
    // the 1Hz decimation downstream then averages five of these again.
    expect(sd(outputs.slice(-200))).toBeLessThan(sd(inputs.slice(-200)) * 0.5);
  });

  it('does not bias the signal it smooths', () => {
    const rand = jitter(7);
    const f = new OneEuroFilter();
    const outputs: number[] = [];
    for (let i = 0; i < 500; i++) outputs.push(f.filter(3 + rand(), i / 5));
    const tail = outputs.slice(-300);
    const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
    expect(mean).toBeCloseTo(3, 1);
  });

  it('still tracks a real postural change within a couple of seconds', () => {
    const f = new OneEuroFilter();
    for (let i = 0; i < 50; i++) f.filter(0, i / 5);
    // 10 degrees of correction, held. Ten samples is two seconds at 5Hz.
    let v = 0;
    for (let i = 50; i < 60; i++) v = f.filter(10, i / 5);
    expect(v).toBeGreaterThan(5);
    for (let i = 60; i < 150; i++) v = f.filter(10, i / 5);
    expect(v).toBeGreaterThan(9.5);
  });
});

describe('session aggregation', () => {
  const mk = (t: number, tilt: number): Sample => ({
    t,
    metrics: { ...measure({}), shoulderTilt: tilt, lateralLean: 0 },
  });

  it('measures drift per 10 minutes', () => {
    // 6 degrees of collapse over 30 minutes = 2 deg per 10 min.
    const samples = Array.from({ length: 181 }, (_, i) => mk(i * 10_000, (i / 180) * 6));
    const s = summarize(samples);
    expect(s.shoulderTilt.driftPer10Min).toBeCloseTo(2, 3);
    expect(s.shoulderTilt.startEndDelta).toBeGreaterThan(0);
  });

  it('counts sustained excursions and ignores brief ones', () => {
    const samples: Sample[] = [];
    for (let i = 0; i < 120; i++) {
      // One 30s excursion, and one 2s blip that should not count.
      const t = i * 1000;
      const inExcursion = t >= 20_000 && t < 50_000;
      const blip = t >= 80_000 && t < 82_000;
      samples.push(mk(t, inExcursion || blip ? 6 : 0));
    }
    const s = summarize(samples, { tolerance: { shoulderTilt: 2 } });
    expect(s.shoulderTilt.excursions).toBe(1);
    expect(s.shoulderTilt.timeInTolerance).toBeLessThan(1);
  });

  it('excludes hip-dependent metrics when the hips were not visible', () => {
    const samples: Sample[] = Array.from({ length: 100 }, (_, i) => ({
      t: i * 1000,
      metrics: { ...measure({}), hipsReliable: i < 20, lateralLean: 3 },
    }));
    const s = summarize(samples);
    expect(s.lateralLean.n).toBe(20);
    expect(s.lateralLean.lowConfidence).toBe(true);
    // The shoulder KPI does not depend on the hips and keeps every sample.
    expect(s.shoulderTilt.n).toBe(100);
    expect(s.shoulderTilt.lowConfidence).toBe(false);
  });

  it('correlates tilt with lean so linked problems are visible', () => {
    const samples: Sample[] = Array.from({ length: 60 }, (_, i) => ({
      t: i * 1000,
      metrics: { ...measure({}), shoulderTilt: i * 0.1, lateralLean: -i * 0.1 },
    }));
    expect(correlate(samples, 'shoulderTilt', 'lateralLean').r).toBeCloseTo(-1, 6);
  });
});
