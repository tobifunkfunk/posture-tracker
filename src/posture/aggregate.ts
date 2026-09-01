import { METRIC_KEYS, type MetricKey, type Sample } from './types';
import { median } from './vec';

/** Default tolerance bands, in each metric's own unit. Overridable in settings. */
export const DEFAULT_TOLERANCE: Record<MetricKey, number> = {
  shoulderTilt: 2,
  // 2 degrees across a typical 38cm shoulder span; kept consistent with
  // shoulderTilt so the two views of the same measurement agree.
  shoulderDropMm: 13,
  // sin(2 degrees), so all three views of shoulder height agree.
  shoulderDropRatio: 0.035,
  lateralLean: 3,
  shoulderOnlyTilt: 2,
  sagittalLean: 4,
  torsoYaw: 5,
  pelvisYaw: 5,
  torsoTwist: 4,
  headRoll: 3,
  headRollEyes: 3,
  headRollEars: 3,
  headRollVsShoulders: 3,
  headYawVsShoulders: 6,
  headLateralOffset: 0.08,
};

/**
 * Angles below this are noise, not posture. MediaPipe's landmarks are joint
 * centres inferred from a silhouette, so sub-degree precision is not real and
 * the UI should never imply it.
 */
export const NOISE_FLOOR_DEG = 1.0;

export interface MetricSummary {
  key: MetricKey;
  n: number;
  /** Habitual bias over the session. */
  mean: number;
  median: number;
  /** Steadiness. */
  sd: number;
  min: number;
  max: number;
  /** Least-squares slope, expressed per 10 minutes — the "am I collapsing?" number. */
  driftPer10Min: number;
  /** Mean over the first 3 minutes. */
  startMean: number;
  /** Mean over the last 3 minutes. */
  endMean: number;
  /** endMean - startMean. */
  startEndDelta: number;
  /** Fraction of samples inside the tolerance band, 0..1. */
  timeInTolerance: number;
  tolerance: number;
  /** Episodes outside the band lasting longer than `minExcursionMs`. */
  excursions: number;
  /** Mean absolute change per minute — a fidget index. */
  movementPerMin: number;
  /** True when hip quality forced most samples to be dropped. */
  lowConfidence: boolean;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function sd(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Ordinary least-squares slope of y against t. */
function slope(ts: number[], ys: number[]): number {
  const n = ts.length;
  if (n < 2) return NaN;
  const mt = mean(ts);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (ts[i] - mt) * (ys[i] - my);
    den += (ts[i] - mt) ** 2;
  }
  return den === 0 ? NaN : num / den;
}

export interface SummaryOptions {
  tolerance?: Partial<Record<MetricKey, number>>;
  /** An out-of-band stretch shorter than this is a shift in the seat, not a slump. */
  minExcursionMs?: number;
  /** Window at each end used for the start/end comparison. */
  edgeWindowMs?: number;
}

/**
 * Reduce one session's samples to per-metric summaries.
 * Samples whose hips were unreliable are dropped from hip-dependent metrics
 * rather than averaged in, so a session spent with the hips occluded reports
 * a small `n` and a `lowConfidence` flag instead of a confident wrong answer.
 */
export function summarize(samples: Sample[], opts: SummaryOptions = {}): Record<MetricKey, MetricSummary> {
  const minExcursionMs = opts.minExcursionMs ?? 10_000;
  const edgeWindowMs = opts.edgeWindowMs ?? 180_000;
  const out = {} as Record<MetricKey, MetricSummary>;

  const duration = samples.length ? samples[samples.length - 1].t : 0;

  for (const key of METRIC_KEYS) {
    const hipDependent = HIP_DEPENDENT.has(key);
    const usable = samples.filter((s) => {
      const v = s.metrics[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) return false;
      return hipDependent ? s.metrics.hipsReliable : true;
    });

    const ys = usable.map((s) => s.metrics[key] as number);
    const ts = usable.map((s) => s.t);
    const tol = opts.tolerance?.[key] ?? DEFAULT_TOLERANCE[key];

    const startYs = usable.filter((s) => s.t <= edgeWindowMs).map((s) => s.metrics[key] as number);
    const endYs = usable
      .filter((s) => s.t >= duration - edgeWindowMs)
      .map((s) => s.metrics[key] as number);

    // Slope in units per millisecond, rescaled to the per-10-minute figure
    // people can actually reason about.
    const perMs = slope(ts, ys);
    const driftPer10Min = Number.isFinite(perMs) ? perMs * 600_000 : NaN;

    let excursions = 0;
    let runStart: number | null = null;
    for (const s of usable) {
      const outside = Math.abs(s.metrics[key] as number) > tol;
      if (outside && runStart === null) {
        runStart = s.t;
      } else if (!outside && runStart !== null) {
        if (s.t - runStart >= minExcursionMs) excursions++;
        runStart = null;
      }
    }
    if (runStart !== null && duration - runStart >= minExcursionMs) excursions++;

    let totalDelta = 0;
    for (let i = 1; i < ys.length; i++) totalDelta += Math.abs(ys[i] - ys[i - 1]);
    const minutes = duration / 60_000;

    const startMean = mean(startYs);
    const endMean = mean(endYs);

    out[key] = {
      key,
      n: ys.length,
      mean: mean(ys),
      median: median(ys),
      sd: sd(ys),
      min: ys.length ? Math.min(...ys) : NaN,
      max: ys.length ? Math.max(...ys) : NaN,
      driftPer10Min,
      startMean,
      endMean,
      startEndDelta: endMean - startMean,
      timeInTolerance: ys.length ? ys.filter((v) => Math.abs(v) <= tol).length / ys.length : NaN,
      tolerance: tol,
      excursions,
      movementPerMin: minutes > 0 ? totalDelta / minutes : NaN,
      lowConfidence: samples.length > 0 && ys.length < samples.length * 0.5,
    };
  }

  return out;
}

const HIP_DEPENDENT = new Set<MetricKey>([
  'lateralLean',
  'shoulderOnlyTilt',
  'sagittalLean',
  'pelvisYaw',
  'torsoTwist',
]);

/**
 * Pearson correlation between two metrics across a session — the direct
 * answer to "these are of course related": it quantifies how much of the
 * shoulder drop travels with the trunk lean rather than living on its own.
 */
export function correlate(samples: Sample[], a: MetricKey, b: MetricKey): { r: number; n: number } {
  const pairs = samples
    .map((s) => [s.metrics[a], s.metrics[b]] as [unknown, unknown])
    .filter((p): p is [number, number] =>
      typeof p[0] === 'number' && typeof p[1] === 'number' &&
      Number.isFinite(p[0]) && Number.isFinite(p[1]));

  if (pairs.length < 3) return { r: NaN, n: pairs.length };

  const xs = pairs.map((p) => p[0]);
  const ys = pairs.map((p) => p[1]);
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return { r: den === 0 ? NaN : num / den, n: pairs.length };
}

/** Fraction of samples where the pose was detected well enough to use. */
export function sessionQuality(samples: Sample[]): { upper: number; hips: number; overall: number } {
  if (!samples.length) return { upper: 0, hips: 0, overall: 0 };
  const upper = samples.filter((s) => s.metrics.upperQuality >= 0.6).length / samples.length;
  const hips = samples.filter((s) => s.metrics.hipsReliable).length / samples.length;
  return { upper, hips, overall: Math.min(upper, (upper + hips) / 2) };
}
