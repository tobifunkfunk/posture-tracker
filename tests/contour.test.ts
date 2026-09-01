import { describe, expect, it } from 'vitest';
import { chaikin, contourBounds, extractContours, type Polyline } from '../src/posture/contour';

/** Build a mask by evaluating a predicate over a w x h grid. */
function mask(w: number, h: number, inside: (x: number, y: number) => boolean): Float32Array {
  const m = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) m[y * w + x] = inside(x, y) ? 1 : 0;
  }
  return m;
}

const perimeter = (line: Polyline): number => {
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    total += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
  }
  return total;
};

describe('extractContours', () => {
  it('finds nothing in an empty mask', () => {
    expect(extractContours(mask(64, 64, () => false), 64, 64)).toHaveLength(0);
  });

  it('finds nothing in a fully filled mask', () => {
    // Every cell is inside, so no edge is ever crossed.
    expect(extractContours(mask(64, 64, () => true), 64, 64)).toHaveLength(0);
  });

  it('traces a rectangle at the right place', () => {
    const m = mask(100, 100, (x, y) => x >= 20 && x < 60 && y >= 30 && y < 80);
    const contours = extractContours(m, 100, 100, { step: 1, smoothIterations: 0 });

    expect(contours.length).toBeGreaterThanOrEqual(1);
    const bounds = contourBounds(contours)!;
    // Normalised against width-1, and the boundary sits between the last
    // inside pixel and the first outside one.
    expect(bounds.x0).toBeCloseTo(19.5 / 99, 3);
    expect(bounds.x1).toBeCloseTo(59.5 / 99, 3);
    expect(bounds.y0).toBeCloseTo(29.5 / 99, 3);
    expect(bounds.y1).toBeCloseTo(79.5 / 99, 3);
  });

  it('produces a closed loop for a closed shape', () => {
    const m = mask(80, 80, (x, y) => Math.hypot(x - 40, y - 40) < 25);
    const [contour] = extractContours(m, 80, 80, { step: 1, smoothIterations: 0 });

    expect(contour).toBeDefined();
    const first = contour[0];
    const last = contour[contour.length - 1];
    expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeLessThan(0.05);
  });

  it('separates two disjoint blobs into two contours', () => {
    const m = mask(120, 60, (x, y) =>
      Math.hypot(x - 25, y - 30) < 15 || Math.hypot(x - 95, y - 30) < 15);
    const contours = extractContours(m, 120, 60, { step: 1, smoothIterations: 0 });
    expect(contours).toHaveLength(2);
  });

  it('drops specks below minPoints', () => {
    const m = mask(100, 100, (x, y) =>
      (x >= 20 && x < 70 && y >= 20 && y < 70) || (x === 90 && y === 90));
    const contours = extractContours(m, 100, 100, { step: 1, minPoints: 12, smoothIterations: 0 });
    expect(contours).toHaveLength(1);
  });

  it('interpolates a soft edge to sub-pixel position', () => {
    // A ramp crossing 0.5 exactly between columns 49 and 50.
    const w = 100;
    const m = new Float32Array(w * 10);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < w; x++) m[y * w + x] = x < 50 ? 1 : 0;
    }
    const contours = extractContours(m, w, 10, { step: 1, smoothIterations: 0, minPoints: 2 });
    const bounds = contourBounds(contours)!;
    // Values are 1 at x=49 and 0 at x=50, so the 0.5 crossing is at x=49.5.
    expect(bounds.x0 * (w - 1)).toBeCloseTo(49.5, 1);
  });

  it('gives the same shape at a coarser step', () => {
    const m = mask(200, 200, (x, y) => Math.hypot(x - 100, y - 100) < 60);
    const fine = contourBounds(extractContours(m, 200, 200, { step: 1, smoothIterations: 0 }))!;
    const coarse = contourBounds(extractContours(m, 200, 200, { step: 4, smoothIterations: 0 }))!;
    expect(coarse.x0).toBeCloseTo(fine.x0, 1);
    expect(coarse.x1).toBeCloseTo(fine.x1, 1);
  });

  it('handles a body-like shape with a head', () => {
    // Torso plus a narrower head on top — the silhouette this actually traces.
    const m = mask(120, 160, (x, y) => {
      const head = Math.hypot(x - 60, y - 30) < 18;
      const neck = x >= 52 && x < 68 && y >= 45 && y < 60;
      const torso = x >= 30 && x < 90 && y >= 55 && y < 150;
      return head || neck || torso;
    });
    const contours = extractContours(m, 120, 160, { step: 1, smoothIterations: 0 });
    // Head and torso overlap into one silhouette.
    expect(contours).toHaveLength(1);
    const bounds = contourBounds(contours)!;
    expect(bounds.y0).toBeLessThan(0.1);   // top of the head
    expect(bounds.y1).toBeGreaterThan(0.9); // bottom of the torso
  });
});

describe('chaikin', () => {
  it('rounds corners without moving the outline far', () => {
    const square: Polyline = [
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0 },
    ];
    const smoothed = chaikin(square, 2);
    expect(smoothed.length).toBeGreaterThan(square.length);
    const bounds = contourBounds([smoothed])!;
    expect(bounds.x0).toBeGreaterThanOrEqual(0);
    expect(bounds.x1).toBeLessThanOrEqual(1);
    // Corner cutting shortens the path.
    expect(perimeter(smoothed)).toBeLessThan(perimeter(square));
  });

  it('leaves degenerate lines alone', () => {
    expect(chaikin([{ x: 0, y: 0 }], 3)).toHaveLength(1);
    expect(chaikin([], 3)).toHaveLength(0);
  });
});
