import { describe, expect, it } from 'vitest';
import {
  AutoCalibrator, applyYawCorrection, poolAzimuth, sessionAzimuthEstimate,
  SETUP_CHANGE_THRESHOLD_DEG,
} from '../src/posture/autocalibrate';
import { toDeg, toRad } from '../src/posture/vec';
import type { Sample } from '../src/posture/types';
import { makeBody, profileFor, project } from './synthetic';
import { toBodyFrame } from '../src/posture/frames';
import { computeMetrics } from '../src/posture/metrics';

const yaws = (centre: number, n = 60, spread = 2) =>
  Array.from({ length: n }, (_, i) => centre + Math.sin(i * 1.7) * spread);

describe('sessionAzimuthEstimate', () => {
  it('needs enough samples before it will guess', () => {
    expect(sessionAzimuthEstimate(0, [1, 2, 3])).toBeNull();
  });

  it('reads a consistent yaw offset as the azimuth being wrong', () => {
    const e = sessionAzimuthEstimate(0, yaws(8))!;
    expect(toDeg(e.azimuth)).toBeCloseTo(8, 0);
    expect(e.medianYawDeg).toBeCloseTo(8, 0);
  });

  it('adds the offset to whatever azimuth was in use', () => {
    const e = sessionAzimuthEstimate(toRad(30), yaws(5))!;
    expect(toDeg(e.azimuth)).toBeCloseTo(35, 0);
  });

  it('reports how much the sitter moved', () => {
    expect(sessionAzimuthEstimate(0, yaws(0, 60, 1))!.spreadDeg)
      .toBeLessThan(sessionAzimuthEstimate(0, yaws(0, 60, 10))!.spreadDeg);
  });

  it('is unmoved by a few wild readings', () => {
    const withOutliers = [...yaws(6), 90, -80, 120];
    expect(toDeg(sessionAzimuthEstimate(0, withOutliers)!.azimuth)).toBeCloseTo(6, 0);
  });
});

describe('poolAzimuth', () => {
  it('takes the first session at face value', () => {
    const e = sessionAzimuthEstimate(0, yaws(12))!;
    const r = poolAzimuth(0, 0, e);
    expect(toDeg(r.azimuth)).toBeCloseTo(12, 0);
    expect(r.setupChanged).toBe(false);
  });

  it('moves the running estimate only partway', () => {
    const e = sessionAzimuthEstimate(0, yaws(10))!;
    const r = poolAzimuth(0, 4, e);
    // Fifth session: a fifth of the way, not all of it.
    expect(toDeg(r.azimuth)).toBeCloseTo(2, 0);
  });

  it('settles as sessions accumulate but stays able to follow a nudge', () => {
    let azimuth = 0;
    // The camera actually sits at 12 degrees; repeated sessions should converge.
    for (let i = 0; i < 40; i++) {
      const e = sessionAzimuthEstimate(azimuth, yaws(toDeg(toRad(12) - azimuth)))!;
      azimuth = poolAzimuth(azimuth, i, e).azimuth;
    }
    expect(toDeg(azimuth)).toBeCloseTo(12, 0);
  });

  it('treats a large jump as a moved camera rather than averaging it in', () => {
    const e = sessionAzimuthEstimate(0, yaws(SETUP_CHANGE_THRESHOLD_DEG + 15))!;
    const r = poolAzimuth(0, 20, e);
    expect(r.setupChanged).toBe(true);
    // Adopts the new geometry outright: averaging two setups helps neither.
    expect(toDeg(r.azimuth)).toBeCloseTo(SETUP_CHANGE_THRESHOLD_DEG + 15, 0);
  });

  it('does not cry setup-change on the very first session', () => {
    const e = sessionAzimuthEstimate(0, yaws(60))!;
    expect(poolAzimuth(0, 0, e).setupChanged).toBe(false);
  });
});

describe('applyYawCorrection', () => {
  const sample = (yaw: number, pelvis: number, twist: number): Sample => ({
    t: 0,
    metrics: { ...makeMetrics(), torsoYaw: yaw, pelvisYaw: pelvis, torsoTwist: twist },
  });
  const makeMetrics = () =>
    computeMetrics(toBodyFrame(project(makeBody({})), profileFor()), profileFor());

  it('shifts absolute yaws by the correction', () => {
    const samples = [sample(10, 8, 2), sample(12, 9, 3)];
    applyYawCorrection(samples, 5);
    expect(samples[0].metrics.torsoYaw).toBeCloseTo(5, 6);
    expect(samples[1].metrics.pelvisYaw).toBeCloseTo(4, 6);
  });

  it('leaves differences of two yaws alone', () => {
    const samples = [sample(10, 8, 2)];
    applyYawCorrection(samples, 5);
    // Twist is shoulders minus hips, so the offset already cancelled.
    expect(samples[0].metrics.torsoTwist).toBeCloseTo(2, 6);
  });

  it('does nothing for a zero or invalid correction', () => {
    const samples = [sample(10, 8, 2)];
    applyYawCorrection(samples, 0);
    applyYawCorrection(samples, NaN);
    expect(samples[0].metrics.torsoYaw).toBeCloseTo(10, 6);
  });
});

describe('AutoCalibrator', () => {
  it('accumulates a session and estimates from it', () => {
    const c = new AutoCalibrator(0);
    for (const y of yaws(7)) c.observe(y, 0.38, true);
    const e = c.estimate()!;
    expect(toDeg(e.azimuth)).toBeCloseTo(7, 0);
    expect(c.shoulderWidth).toBeCloseTo(0.38, 3);
    expect(c.hipsUsable).toBe(true);
  });

  it('marks hips unusable when they were mostly missing, as on a bench', () => {
    const c = new AutoCalibrator(0);
    yaws(0).forEach((y, i) => c.observe(y, 0.38, i < 5));
    expect(c.hipsUsable).toBe(false);
  });

  it('declines to estimate from too little data', () => {
    const c = new AutoCalibrator(0);
    c.observe(5, 0.38, true);
    expect(c.estimate()).toBeNull();
  });
});
