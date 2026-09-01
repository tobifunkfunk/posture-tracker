/**
 * Traces the outline of a segmentation mask.
 *
 * A silhouette reads far better than a stick figure — you recognise your own
 * shape instantly, where a skeleton has to be decoded. This turns MediaPipe's
 * per-pixel person mask into smooth polylines that can be stroked on a canvas.
 *
 * Marching squares with linear interpolation along each crossed edge, so the
 * outline is sub-pixel smooth rather than staircased.
 */

export interface Point {
  x: number;
  y: number;
}

/** A contour, in normalised 0..1 image coordinates. Closed loops repeat no point. */
export type Polyline = Point[];

export interface ContourOptions {
  /** Mask value above which a pixel counts as body. */
  threshold?: number;
  /**
   * Grid subsampling. 2 quarters the work and slightly smooths the result;
   * the mask is far finer than the outline needs to be.
   */
  step?: number;
  /** Drop contours shorter than this — specks of misclassified background. */
  minPoints?: number;
  /** Chaikin smoothing passes. Two is enough to remove the marching-squares facets. */
  smoothIterations?: number;
}

/**
 * Extract outlines from a single-channel mask.
 *
 * `mask` is row-major, `width * height` long, values 0..1.
 */
export function extractContours(
  mask: Float32Array,
  width: number,
  height: number,
  opts: ContourOptions = {},
): Polyline[] {
  const threshold = opts.threshold ?? 0.5;
  const step = Math.max(1, Math.floor(opts.step ?? 2));
  const minPoints = opts.minPoints ?? 12;
  const smoothIterations = opts.smoothIterations ?? 2;

  if (width < 2 || height < 2 || mask.length < width * height) return [];

  // Grid of sample points, sized so the last sample never runs past the edge.
  const gw = Math.floor((width - 1) / step) + 1;
  const gh = Math.floor((height - 1) / step) + 1;
  if (gw < 2 || gh < 2) return [];

  const at = (gx: number, gy: number): number => mask[gy * step * width + gx * step];

  /*
   * Each crossing is identified by the grid edge it sits on rather than by its
   * coordinates. Neighbouring cells then agree exactly on shared crossings,
   * which makes linking segments into loops robust instead of a
   * float-comparison guessing game.
   */
  const H = (gx: number, gy: number): number => ((gy * gw + gx) << 1);
  const V = (gx: number, gy: number): number => (((gy * gw + gx) << 1) | 1);

  const adjacency = new Map<number, number[]>();
  const link = (a: number, b: number): void => {
    let listA = adjacency.get(a);
    if (!listA) adjacency.set(a, (listA = []));
    listA.push(b);
    let listB = adjacency.get(b);
    if (!listB) adjacency.set(b, (listB = []));
    listB.push(a);
  };

  for (let gy = 0; gy < gh - 1; gy++) {
    for (let gx = 0; gx < gw - 1; gx++) {
      const tl = at(gx, gy) >= threshold ? 1 : 0;
      const tr = at(gx + 1, gy) >= threshold ? 2 : 0;
      const br = at(gx + 1, gy + 1) >= threshold ? 4 : 0;
      const bl = at(gx, gy + 1) >= threshold ? 8 : 0;
      const code = tl | tr | br | bl;
      if (code === 0 || code === 15) continue;

      const T = H(gx, gy);
      const B = H(gx, gy + 1);
      const L = V(gx, gy);
      const R = V(gx + 1, gy);

      switch (code) {
        case 1: link(L, T); break;
        case 2: link(T, R); break;
        case 3: link(L, R); break;
        case 4: link(R, B); break;
        case 6: link(T, B); break;
        case 7: link(L, B); break;
        case 8: link(B, L); break;
        case 9: link(T, B); break;
        case 11: link(R, B); break;
        case 12: link(R, L); break;
        case 13: link(T, R); break;
        case 14: link(T, L); break;
        // Saddle cells: two diagonal corners inside. Resolve by the cell's
        // average so the pairing follows whichever way the body actually runs.
        case 5: {
          const avg = (at(gx, gy) + at(gx + 1, gy) + at(gx + 1, gy + 1) + at(gx, gy + 1)) / 4;
          if (avg >= threshold) { link(L, B); link(T, R); } else { link(L, T); link(R, B); }
          break;
        }
        case 10: {
          const avg = (at(gx, gy) + at(gx + 1, gy) + at(gx + 1, gy + 1) + at(gx, gy + 1)) / 4;
          if (avg >= threshold) { link(L, T); link(R, B); } else { link(L, B); link(T, R); }
          break;
        }
        default: break;
      }
    }
  }

  /** Interpolated position of a crossing, normalised to 0..1. */
  const pointOf = (key: number): Point => {
    const vertical = key & 1;
    const cell = key >> 1;
    const gx = cell % gw;
    const gy = (cell / gw) | 0;

    if (!vertical) {
      const va = at(gx, gy);
      const vb = at(gx + 1, gy);
      const t = crossing(va, vb, threshold);
      return { x: ((gx + t) * step) / (width - 1), y: (gy * step) / (height - 1) };
    }
    const va = at(gx, gy);
    const vb = at(gx, gy + 1);
    const t = crossing(va, vb, threshold);
    return { x: (gx * step) / (width - 1), y: ((gy + t) * step) / (height - 1) };
  };

  // Walk the adjacency graph into polylines, consuming each segment once.
  const used = new Set<number>();
  const segKey = (a: number, b: number): number => (a < b ? a * 0x8000000 + b : b * 0x8000000 + a);

  const walk = (start: number): Polyline => {
    const line: Polyline = [];
    let current = start;
    let previous = -1;

    for (;;) {
      line.push(pointOf(current));
      const neighbours = adjacency.get(current);
      if (!neighbours) break;

      let next = -1;
      for (const n of neighbours) {
        if (n === previous && neighbours.length > 1) continue;
        const k = segKey(current, n);
        if (used.has(k)) continue;
        used.add(k);
        next = n;
        break;
      }
      if (next === -1) break;
      previous = current;
      current = next;
      // Closed the loop.
      if (current === start) break;
    }
    return line;
  };

  const contours: Polyline[] = [];

  // Open contours first — starting mid-loop on one would split it in two.
  const starts = [...adjacency.keys()].sort(
    (a, b) => (adjacency.get(a)!.length) - (adjacency.get(b)!.length),
  );

  for (const key of starts) {
    const neighbours = adjacency.get(key)!;
    const hasUnused = neighbours.some((n) => !used.has(segKey(key, n)));
    if (!hasUnused) continue;
    const line = walk(key);
    if (line.length >= minPoints) contours.push(line);
  }

  return smoothIterations > 0
    ? contours.map((c) => chaikin(c, smoothIterations))
    : contours;
}

function crossing(va: number, vb: number, threshold: number): number {
  const d = vb - va;
  if (Math.abs(d) < 1e-9) return 0.5;
  return Math.min(1, Math.max(0, (threshold - va) / d));
}

/**
 * Chaikin corner cutting. Each pass replaces every corner with two points a
 * quarter and three quarters along, which rounds the marching-squares facets
 * without pulling the outline away from the body.
 */
export function chaikin(points: Polyline, iterations = 1): Polyline {
  let out = points;
  for (let i = 0; i < iterations && out.length > 2; i++) {
    const next: Polyline = [out[0]];
    for (let j = 0; j < out.length - 1; j++) {
      const a = out[j];
      const b = out[j + 1];
      next.push(
        { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 },
        { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 },
      );
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

/** Bounding box of a set of contours, or null when there are none. */
export function contourBounds(contours: Polyline[]): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of contours) {
    for (const p of c) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}
