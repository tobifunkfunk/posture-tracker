/**
 * Trunk axis from the body silhouette, replacing the hip landmarks.
 *
 * Hips are the wrong tool for seated meditation. On a bench or kneeling stool
 * they are occluded, oddly posed, or simply not where the model expects, and
 * MediaPipe's estimate degrades accordingly. Every KPI that hung off the
 * hip midpoint inherited that.
 *
 * The silhouette does the same job better. Taking the horizontal centroid of
 * the body at each height across the chest gives a centre line fitted from
 * thousands of pixels rather than two guessed points, and it lives in the
 * image plane — the axis the camera observes best.
 *
 * What it cannot do is depth: forward lean and pelvis rotation are simply not
 * visible in a frontal outline, and are dropped rather than faked.
 */

export interface TrunkAxis {
  /**
   * Lean from true vertical, in degrees, already corrected for camera roll.
   * Positive leans toward image-right.
   */
  leanImageDeg: number;
  /** Fraction of the requested band that yielded a usable row, 0..1. */
  coverage: number;
  /**
   * Root-mean-square residual of the centre-line fit, in image widths. A
   * straight trunk fits tightly; an arm swinging out inflates this.
   */
  residual: number;
  rows: number;
}

export interface TrunkAxisOptions {
  threshold?: number;
  /** Rows are sampled every `step` pixels. */
  step?: number;
  /**
   * Camera roll in radians, from the gravity vector. Subtracted so the result
   * is lean from true vertical rather than from the image's edge.
   */
  cameraRollRad?: number;
}

/**
 * Fit the body's centre line between two heights.
 *
 * `yStart` and `yEnd` are normalised 0..1 image coordinates, top-down. The
 * caller picks a band across the chest: below the shoulder line, above where
 * the hands rest, so neither the shoulders' width nor the lap distorts it.
 */
export function trunkAxisFromMask(
  mask: Float32Array,
  width: number,
  height: number,
  yStart: number,
  yEnd: number,
  opts: TrunkAxisOptions = {},
): TrunkAxis | null {
  const threshold = opts.threshold ?? 0.5;
  const step = Math.max(1, Math.floor(opts.step ?? 2));

  const y0 = Math.max(0, Math.min(height - 1, Math.round(yStart * (height - 1))));
  const y1 = Math.max(0, Math.min(height - 1, Math.round(yEnd * (height - 1))));
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  if (bottom - top < 4) return null;

  const ys: number[] = [];
  const xs: number[] = [];
  const weights: number[] = [];
  let requested = 0;

  for (let y = top; y <= bottom; y += step) {
    requested++;
    let sum = 0;
    let weighted = 0;
    for (let x = 0; x < width; x++) {
      const v = mask[y * width + x];
      if (v >= threshold) {
        sum += v;
        weighted += v * x;
      }
    }
    // A row holding almost nothing is background, not body.
    if (sum < 3) continue;
    ys.push(y);
    xs.push(weighted / sum);
    // Wider rows carry more evidence about where the centre is.
    weights.push(sum);
  }

  if (ys.length < 4) return null;

  // Weighted least squares of x against y: x = a*y + b.
  let sw = 0;
  let sy = 0;
  let sx = 0;
  for (let i = 0; i < ys.length; i++) {
    sw += weights[i];
    sy += weights[i] * ys[i];
    sx += weights[i] * xs[i];
  }
  const my = sy / sw;
  const mx = sx / sw;

  let num = 0;
  let den = 0;
  for (let i = 0; i < ys.length; i++) {
    num += weights[i] * (ys[i] - my) * (xs[i] - mx);
    den += weights[i] * (ys[i] - my) ** 2;
  }
  if (den < 1e-9) return null;
  const a = num / den;

  let sq = 0;
  for (let i = 0; i < ys.length; i++) {
    const predicted = mx + a * (ys[i] - my);
    sq += weights[i] * (xs[i] - predicted) ** 2;
  }
  const residual = Math.sqrt(sq / sw) / width;

  /*
   * `a` is dx per dy in pixels, with y running downward. Moving one pixel up
   * the body therefore shifts x by -a, so the axis pointing up the trunk is
   * (-a, -1). Its signed angle from straight up (0, -1) is atan2(-a, 1),
   * positive when the top of the trunk sits to the image right.
   */
  const leanImageRad = -Math.atan(a);
  const corrected = leanImageRad - (opts.cameraRollRad ?? 0);

  return {
    leanImageDeg: (corrected * 180) / Math.PI,
    coverage: requested > 0 ? ys.length / requested : 0,
    residual,
    rows: ys.length,
  };
}

/**
 * Camera roll from the gravity vector, in radians.
 *
 * `gravityDown` is in the PHYSICS frame (+X image-right, +Y up), so image-down
 * is (g.x, -g.y) and the roll is how far that has swung from straight down.
 */
export function cameraRollFromGravity(gravityDown: { x: number; y: number }): number {
  return Math.atan2(gravityDown.x, -gravityDown.y);
}

/**
 * The band of the body to fit the centre line over, derived from the shoulders.
 *
 * Starts below the shoulder line so the shoulders' own width does not pull the
 * centroid, and stops above where a meditator's hands rest, since a lap full
 * of hands is not part of the trunk.
 */
export function chestBand(
  shoulderYNorm: number,
  shoulderWidthNorm: number,
): { yStart: number; yEnd: number } {
  return {
    yStart: shoulderYNorm + shoulderWidthNorm * 0.18,
    yEnd: shoulderYNorm + shoulderWidthNorm * 0.95,
  };
}
