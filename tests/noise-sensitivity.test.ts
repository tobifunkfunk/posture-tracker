/**
 * Probe: how does camera azimuth affect each KPI's accuracy?
 *
 * Landmark noise lives in the CAMERA frame, and depth (z) is far noisier than
 * the image plane (x, y). Azimuth rotates well-observed camera-x into the
 * body's depth axis, so the tripod angle trades accuracy between KPIs.
 */
import { describe, expect, it } from 'vitest';
import { makeBody, profileFor, project } from './synthetic';
import { toBodyFrame } from '../src/posture/frames';
import { computeMetrics } from '../src/posture/metrics';
import type { PoseFrame } from '../src/posture/types';

// Rough MediaPipe world-landmark error: ~1cm in the image plane, ~3cm in depth.
let SIGMA_XY = 0.010;
let SIGMA_Z = 0.030;
export function setSigma(xy: number, z: number) { SIGMA_XY = xy; SIGMA_Z = z; }

function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}
function gauss(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

/** Noise is added in the RAW camera frame, where the sensor error actually is. */
function addNoise(frame: PoseFrame, rnd: () => number): PoseFrame {
  return frame.map((p) => ({
    x: p.x + gauss(rnd) * SIGMA_XY,
    y: p.y + gauss(rnd) * SIGMA_XY,
    z: p.z + gauss(rnd) * SIGMA_Z,
    visibility: p.visibility,
  }));
}

describe('camera azimuth sensitivity', () => {
  it('reports RMS error per KPI across camera angles', () => {
    const truth = {
      lateralLean: 4,
      sagittalLean: 5,
      bodyYaw: 0,
      shoulderExtraYaw: 6,
      shoulderExtraTilt: 3,
    };
    const N = 4000;
    const angles = [0, 15, 25, 35, 45, 60, 90];
    const keys = ['shoulderTilt', 'shoulderOnlyTilt', 'lateralLean', 'sagittalLean', 'torsoTwist'] as const;

    const rows: string[] = [];
    rows.push(['azimuth', ...keys].map((s) => s.padStart(17)).join(''));

    for (const azimuthDeg of angles) {
      const setup = { azimuthDeg };
      const profile = profileFor(setup);
      const body = makeBody(truth);
      const clean = computeMetrics(toBodyFrame(project(body, setup), profile), profile);
      const rnd = lcg(12345 + azimuthDeg);

      const sq: Record<string, number> = {};
      for (const k of keys) sq[k] = 0;

      for (let i = 0; i < N; i++) {
        const noisy = computeMetrics(
          toBodyFrame(addNoise(project(body, setup), rnd), profile),
          profile,
        );
        for (const k of keys) {
          const d = (noisy[k] as number) - (clean[k] as number);
          if (Number.isFinite(d)) sq[k] += d * d;
        }
      }

      rows.push(
        [`${azimuthDeg}deg`, ...keys.map((k) => `${Math.sqrt(sq[k] / N).toFixed(2)}deg`)]
          .map((s) => s.padStart(17)).join(''),
      );
    }

    console.log('\nRMS error in degrees (lower is better)\n' + rows.join('\n') + '\n');
  });

  /**
   * These assertions pin the camera-placement advice. Landmark noise lives in
   * the camera frame and depth is the noisy axis, so the tripod angle decides
   * which KPIs get the well-observed image plane and which get depth.
   */
  it('confirms a frontal camera is best for shoulder height and lateral lean', () => {
    const rmsAt = (azimuthDeg: number, key: 'lateralLean' | 'sagittalLean' | 'shoulderOnlyTilt') => {
      const setup = { azimuthDeg };
      const profile = profileFor(setup);
      const body = makeBody({ lateralLean: 4, sagittalLean: 5, shoulderExtraTilt: 3 });
      const clean = computeMetrics(toBodyFrame(project(body, setup), profile), profile);
      const rnd = lcg(4242 + azimuthDeg);
      let sq = 0;
      const N = 3000;
      for (let i = 0; i < N; i++) {
        const noisy = computeMetrics(toBodyFrame(addNoise(project(body, setup), rnd), profile), profile);
        const d = (noisy[key] as number) - (clean[key] as number);
        if (Number.isFinite(d)) sq += d * d;
      }
      return Math.sqrt(sq / N);
    };

    // Lateral lean rides the image-plane x axis when the camera faces you.
    expect(rmsAt(0, 'lateralLean')).toBeLessThan(rmsAt(90, 'lateralLean'));
    expect(rmsAt(0, 'lateralLean')).toBeLessThan(rmsAt(35, 'lateralLean'));

    // Shoulder asymmetry inherits that, since it subtracts the lean.
    expect(rmsAt(0, 'shoulderOnlyTilt')).toBeLessThan(rmsAt(90, 'shoulderOnlyTilt'));

    // Forward lean is the exact opposite: it needs depth, so it wants a side view.
    expect(rmsAt(90, 'sagittalLean')).toBeLessThan(rmsAt(0, 'sagittalLean'));
  });

  it('confirms twist is only trustworthy as a session average', () => {
    const setup = { azimuthDeg: 35 };
    const profile = profileFor(setup);
    const body = makeBody({ shoulderExtraYaw: 6 });
    const clean = computeMetrics(toBodyFrame(project(body, setup), profile), profile);
    const rnd = lcg(31337);
    const N = 3000;
    let sq = 0;
    for (let i = 0; i < N; i++) {
      const noisy = computeMetrics(toBodyFrame(addNoise(project(body, setup), rnd), profile), profile);
      const d = noisy.torsoTwist - clean.torsoTwist;
      if (Number.isFinite(d)) sq += d * d;
    }
    const perFrame = Math.sqrt(sq / N);

    // Twist depends on the hip line, whose short baseline amplifies depth
    // noise. Per frame it is far larger than its own tolerance band, which is
    // why the live dial averages over 30s and the report uses session means.
    expect(perFrame).toBeGreaterThan(4);
    // Averaged over a 20 minute sit at 1Hz, the same error becomes usable.
    expect(perFrame / Math.sqrt(1200)).toBeLessThan(1);
  });

  it('shows how twist accuracy depends on the assumed depth noise', () => {
    // The twist conclusion rests entirely on sigma_z, which is a guess.
    // Sweep it so the conclusion can be read as conditional on that guess.
    const body = makeBody({ shoulderExtraYaw: 6 });
    const N = 3000;
    const rows: string[] = ['   sigma_z    twist RMS   session mean SE (1200 samples)'];

    for (const sz of [0.005, 0.010, 0.020, 0.030, 0.050]) {
      setSigma(0.010, sz);
      const setup = { azimuthDeg: 35 };
      const profile = profileFor(setup);
      const clean = computeMetrics(toBodyFrame(project(body, setup), profile), profile);
      const rnd = lcg(999);
      let sq = 0;
      for (let i = 0; i < N; i++) {
        const noisy = computeMetrics(toBodyFrame(addNoise(project(body, setup), rnd), profile), profile);
        const d = noisy.torsoTwist - clean.torsoTwist;
        if (Number.isFinite(d)) sq += d * d;
      }
      const rms = Math.sqrt(sq / N);
      rows.push(`   ${(sz * 100).toFixed(1)}cm      ${rms.toFixed(2)}deg        ${(rms / Math.sqrt(1200)).toFixed(2)}deg`);
    }
    setSigma(0.010, 0.030);
    console.log('\nTwist noise vs assumed depth error, camera at 35deg\n' + rows.join('\n') + '\n');
  });
});
