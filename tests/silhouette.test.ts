import { describe, expect, it } from 'vitest';
import { cameraRollFromGravity, chestBand, trunkAxisFromMask } from '../src/posture/silhouette';

const W = 200;
const H = 300;

/**
 * A seated body silhouette leaning by `leanDeg` (positive = top toward image
 * right), rotated about the hips at the bottom. Optionally with one arm
 * sticking out, which is the realistic way this fit gets confused.
 */
function bodyMask(leanDeg: number, opts: { armOut?: boolean; noise?: boolean } = {}): Float32Array {
  const m = new Float32Array(W * H);
  const pivotX = W / 2;
  const pivotY = 260;
  const t = (leanDeg * Math.PI) / 180;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Rotate the sample point back into the body's own upright frame.
      const dx = x - pivotX;
      const dy = y - pivotY;
      const bx = dx * Math.cos(-t) - dy * Math.sin(-t);
      const by = dx * Math.sin(-t) + dy * Math.cos(-t);

      const head = Math.hypot(bx / 26, (by + 190) / 30) < 1;
      const torso = Math.abs(bx) < 42 && by > -150 && by < 0;
      const arm = opts.armOut && bx > 30 && bx < 78 && by > -110 && by < -70;
      m[y * W + x] = head || torso || arm ? 1 : 0;
    }
  }

  if (opts.noise) {
    // Speckle, as a real segmentation mask has at its edges.
    let seed = 5;
    for (let i = 0; i < m.length; i++) {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      if (seed / 4294967296 < 0.01) m[i] = m[i] > 0.5 ? 0 : 1;
    }
  }
  return m;
}

// The torso spans roughly y = 110..260 for an upright body.
const BAND = { yStart: 120 / (H - 1), yEnd: 240 / (H - 1) };

describe('trunkAxisFromMask', () => {
  it('reads an upright trunk as vertical', () => {
    const r = trunkAxisFromMask(bodyMask(0), W, H, BAND.yStart, BAND.yEnd)!;
    expect(r).not.toBeNull();
    expect(r.leanImageDeg).toBeCloseTo(0, 1);
    expect(r.coverage).toBeGreaterThan(0.9);
  });

  it('recovers the lean angle and its sign', () => {
    for (const lean of [-12, -6, -3, 3, 6, 12]) {
      const r = trunkAxisFromMask(bodyMask(lean), W, H, BAND.yStart, BAND.yEnd)!;
      expect(r.leanImageDeg).toBeCloseTo(lean, 0);
    }
  });

  it('resolves a lean far smaller than the noise floor of hip landmarks', () => {
    // 1.5 degrees is below what two noisy hip points could ever resolve.
    const r = trunkAxisFromMask(bodyMask(1.5), W, H, BAND.yStart, BAND.yEnd)!;
    expect(r.leanImageDeg).toBeGreaterThan(1.0);
    expect(r.leanImageDeg).toBeLessThan(2.0);
  });

  it('subtracts camera roll so the result is lean from true vertical', () => {
    // An upright body seen by a camera rolled 8 degrees.
    const rolled = trunkAxisFromMask(bodyMask(8), W, H, BAND.yStart, BAND.yEnd, {
      cameraRollRad: (8 * Math.PI) / 180,
    })!;
    expect(rolled.leanImageDeg).toBeCloseTo(0, 1);
  });

  it('survives speckle noise in the mask', () => {
    const clean = trunkAxisFromMask(bodyMask(5), W, H, BAND.yStart, BAND.yEnd)!;
    const noisy = trunkAxisFromMask(bodyMask(5, { noise: true }), W, H, BAND.yStart, BAND.yEnd)!;
    expect(noisy.leanImageDeg).toBeCloseTo(clean.leanImageDeg, 0);
  });

  it('flags a poor fit when an arm juts out', () => {
    const clean = trunkAxisFromMask(bodyMask(0), W, H, BAND.yStart, BAND.yEnd)!;
    const withArm = trunkAxisFromMask(bodyMask(0, { armOut: true }), W, H, BAND.yStart, BAND.yEnd)!;
    // The residual is the tell: the caller can distrust the reading.
    expect(withArm.residual).toBeGreaterThan(clean.residual * 2);
  });

  it('returns null when the band holds no body', () => {
    expect(trunkAxisFromMask(new Float32Array(W * H), W, H, 0.2, 0.6)).toBeNull();
  });

  it('returns null for a degenerate band', () => {
    expect(trunkAxisFromMask(bodyMask(0), W, H, 0.5, 0.5)).toBeNull();
  });

  it('gives the same answer at a coarser row step', () => {
    const fine = trunkAxisFromMask(bodyMask(7), W, H, BAND.yStart, BAND.yEnd, { step: 1 })!;
    const coarse = trunkAxisFromMask(bodyMask(7), W, H, BAND.yStart, BAND.yEnd, { step: 4 })!;
    expect(coarse.leanImageDeg).toBeCloseTo(fine.leanImageDeg, 0);
  });
});

describe('cameraRollFromGravity', () => {
  it('reads a level camera as zero roll', () => {
    expect(cameraRollFromGravity({ x: 0, y: -1 })).toBeCloseTo(0, 9);
  });

  it('reads the roll angle and its sign', () => {
    const deg = 10;
    const t = (deg * Math.PI) / 180;
    // Gravity as reported by a camera rolled by `deg`: straight down (0, -1)
    // in the physics frame, swung round by the roll.
    const g = { x: Math.sin(t), y: -Math.cos(t) };
    expect((cameraRollFromGravity(g) * 180) / Math.PI).toBeCloseTo(deg, 6);
  });

  it('cancels exactly against a lean measured from the mask', () => {
    // The two must share a sign convention, or the correction doubles the
    // error instead of removing it.
    const deg = 6;
    const t = (deg * Math.PI) / 180;
    const roll = cameraRollFromGravity({ x: Math.sin(t), y: -Math.cos(t) });
    const r = trunkAxisFromMask(bodyMask(deg), W, H, BAND.yStart, BAND.yEnd, {
      cameraRollRad: roll,
    })!;
    expect(r.leanImageDeg).toBeCloseTo(0, 1);
  });
});

describe('chestBand', () => {
  it('sits below the shoulders and above the lap', () => {
    const band = chestBand(0.3, 0.25);
    expect(band.yStart).toBeGreaterThan(0.3);
    expect(band.yEnd).toBeGreaterThan(band.yStart);
    // Stays clear of where a meditator's hands rest.
    expect(band.yEnd).toBeLessThan(0.3 + 0.25);
  });
});
