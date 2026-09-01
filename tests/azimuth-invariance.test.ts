import { describe, expect, it } from 'vitest';
import { makeBody, profileFor, project } from './synthetic';
import { toBodyFrame } from '../src/posture/frames';
import { computeMetrics } from '../src/posture/metrics';
import { METRIC_KEYS } from '../src/posture/types';

/**
 * Which KPIs actually depend on the azimuth calibration?
 *
 * The reference sit exists only to pin the azimuth. Anything invariant to it
 * needs no calibration ritual at all, so this establishes exactly what that
 * ritual is buying.
 */
describe('azimuth dependence', () => {
  it('reports which metrics change when the assumed azimuth is wrong', () => {
    const pose = { lateralLean: 4, shoulderExtraTilt: 3, shoulderExtraYaw: 5, headRoll: 6, headYaw: 7 };
    const setup = { azimuthDeg: 0 };
    const body = makeBody(pose);
    const raw = project(body, setup);

    const correct = computeMetrics(toBodyFrame(raw, profileFor(setup)), profileFor(setup));
    // Same data, but the calibration is off by 20 degrees.
    const wrongProfile = { ...profileFor(setup), azimuth: (20 * Math.PI) / 180 };
    const wrong = computeMetrics(toBodyFrame(raw, wrongProfile), wrongProfile);

    const affected: string[] = [];
    const invariant: string[] = [];
    for (const k of METRIC_KEYS) {
      const a = correct[k] as number;
      const b = wrong[k] as number;
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      (Math.abs(a - b) > 0.05 ? affected : invariant).push(k);
    }
    console.log('\n  affected by a wrong azimuth:', affected.join(', '));
    console.log('  invariant to azimuth:      ', invariant.join(', '), '\n');

    // The headline KPIs must not care, or per-session baselining is impossible.
    expect(invariant).toContain('shoulderTilt');
    expect(invariant).toContain('shoulderDropMm');
    expect(invariant).toContain('headRoll');
  });

  it('makes lean azimuth-invariant too once it comes from the silhouette', () => {
    const pose = { lateralLean: 4, shoulderExtraTilt: 3 };
    const setup = { azimuthDeg: 0 };
    const raw = project(makeBody(pose), setup);
    const override = { lateralLean: 4 };

    const correct = computeMetrics(toBodyFrame(raw, profileFor(setup)), profileFor(setup), override);
    const wrongProfile = { ...profileFor(setup), azimuth: (20 * Math.PI) / 180 };
    const wrong = computeMetrics(toBodyFrame(raw, wrongProfile), wrongProfile, override);

    // The silhouette measures lean in the image plane, so it never passes
    // through the azimuth rotation at all.
    expect(wrong.lateralLean).toBeCloseTo(correct.lateralLean, 9);
    expect(wrong.shoulderOnlyTilt).toBeCloseTo(correct.shoulderOnlyTilt, 9);
  });

  it('leaves torso rotation as the only headline KPI needing a reference', () => {
    const pose = { shoulderExtraYaw: 5 };
    const setup = { azimuthDeg: 0 };
    const raw = project(makeBody(pose), setup);
    const override = { lateralLean: 0 };

    const correct = computeMetrics(toBodyFrame(raw, profileFor(setup)), profileFor(setup), override);
    const wrongProfile = { ...profileFor(setup), azimuth: (20 * Math.PI) / 180 };
    const wrong = computeMetrics(toBodyFrame(raw, wrongProfile), wrongProfile, override);

    // Yaw is exactly offset by the calibration error, which is what makes a
    // post-hoc correction possible: it is linear in the azimuth.
    expect(wrong.torsoYaw - correct.torsoYaw).toBeCloseTo(-20, 4);
  });
});
