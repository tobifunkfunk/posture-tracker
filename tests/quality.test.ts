import { describe, expect, it } from 'vitest';
import { QualityMeter, qualityAdvice } from '../src/posture/quality';
import { makeBody } from './synthetic';
import { PoseIdx, type PoseFrame } from '../src/posture/types';

function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296 - 0.5;
  };
}

/** A still body with a given amount of positional noise, in metres. */
function noisyFrames(count: number, sigma: number, seed = 7): PoseFrame[] {
  const rnd = lcg(seed);
  const base = makeBody({});
  return Array.from({ length: count }, () =>
    base.map((p) => ({
      x: p.x + rnd() * sigma * 2,
      y: p.y + rnd() * sigma * 2,
      z: p.z + rnd() * sigma * 2,
      visibility: p.visibility,
    })));
}

describe('QualityMeter', () => {
  it('says it is still measuring before it has enough samples', () => {
    const m = new QualityMeter();
    for (const f of noisyFrames(5, 0.002)) m.push(f);
    expect(m.read(null).verdict).toBe('measuring');
  });

  it('rates a clean, still setup as excellent', () => {
    const m = new QualityMeter();
    const frames = noisyFrames(60, 0.0008);
    for (const f of frames) m.push(f);
    const r = m.read(frames[0]);
    expect(r.jitterDeg).toBeLessThan(0.3);
    expect(r.verdict).toBe('excellent');
  });

  it('rates a noisy setup as poor and says so', () => {
    const m = new QualityMeter();
    const frames = noisyFrames(60, 0.02);
    for (const f of frames) m.push(f);
    const r = m.read(frames[0]);
    expect(r.jitterDeg).toBeGreaterThan(1.2);
    expect(r.verdict).toBe('poor');
    expect(qualityAdvice(r)).toMatch(/jumping around/);
  });

  it('reports more jitter as landmark noise grows', () => {
    const read = (sigma: number) => {
      const m = new QualityMeter();
      const frames = noisyFrames(60, sigma, 11);
      for (const f of frames) m.push(f);
      return m.read(frames[0]).jitterDeg;
    };
    // The whole point of the meter: worse input must read as worse.
    expect(read(0.001)).toBeLessThan(read(0.005));
    expect(read(0.005)).toBeLessThan(read(0.02));
  });

  it('names the worst-seen landmark so the advice is actionable', () => {
    const m = new QualityMeter();
    const frames = noisyFrames(40, 0.001);
    for (const f of frames) m.push(f);
    const probe = frames[0].map((p) => ({ ...p }));
    probe[PoseIdx.LeftHip].visibility = 0.2;
    const r = m.read(probe);
    expect(r.worstName).toBe('left hip');
    expect(r.worstVisibility).toBeCloseTo(0.2, 2);
  });

  it('calls a barely-visible body poor regardless of jitter', () => {
    const m = new QualityMeter();
    const frames = noisyFrames(60, 0.0008).map((f) =>
      f.map((p) => ({ ...p, visibility: 0.2 })));
    for (const f of frames) m.push(f);
    const r = m.read(frames[0]);
    expect(r.verdict).toBe('poor');
    expect(qualityAdvice(r)).toMatch(/barely being seen/);
  });

  it('forgets old frames so a fixed setup shows its current quality', () => {
    const m = new QualityMeter(30);
    for (const f of noisyFrames(40, 0.03, 3)) m.push(f);
    const bad = m.read(null).jitterDeg;
    // Now the setup improves; the window should flush the old noise out.
    for (const f of noisyFrames(40, 0.0008, 4)) m.push(f);
    expect(m.read(null).jitterDeg).toBeLessThan(bad / 3);
  });
});
