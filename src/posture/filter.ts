/**
 * One Euro filter — smooths hard when you are still and backs off when you
 * actually move. That asymmetry is what makes it right for meditation: a
 * fixed EMA either lets landmark jitter through during forty still minutes,
 * or lags visibly when you correct your posture in live mode.
 *
 * Casiez, Roussel & Vogel (2012).
 */
export interface OneEuroOptions {
  /** Cutoff at zero speed, Hz. Lower = smoother when still. */
  minCutoff?: number;
  /**
   * How aggressively the cutoff rises with speed. Higher = less lag when
   * moving, but at 5Hz a value above ~0.05 lets per-sample landmark jitter
   * drive the cutoff up and defeats the smoothing entirely.
   */
  beta?: number;
  /** Cutoff for the derivative estimate, Hz. */
  dCutoff?: number;
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(opts: OneEuroOptions = {}) {
    this.minCutoff = opts.minCutoff ?? 0.3;
    this.beta = opts.beta ?? 0.02;
    this.dCutoff = opts.dCutoff ?? 1.0;
  }

  /** Feed a sample at time `t` (seconds). Returns the filtered value. */
  filter(x: number, t: number): number {
    if (!Number.isFinite(x)) return this.xPrev ?? NaN;

    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = t;
      return x;
    }

    const dt = Math.max(t - this.tPrev, 1e-3);
    this.tPrev = t;

    const dx = (x - this.xPrev) / dt;
    const dxHat = this.dxPrev + alpha(this.dCutoff, dt) * (dx - this.dxPrev);
    this.dxPrev = dxHat;

    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const xHat = this.xPrev + alpha(cutoff, dt) * (x - this.xPrev);
    this.xPrev = xHat;
    return xHat;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = 0;
  }
}

/** One filter per metric key, created lazily so new keys need no wiring. */
export class MetricFilterBank {
  private readonly filters = new Map<string, OneEuroFilter>();

  constructor(private readonly opts: OneEuroOptions = {}) {}

  filter<T extends object>(metrics: T, tSeconds: number, keys: readonly string[]): T {
    const source = metrics as Record<string, unknown>;
    const out: Record<string, unknown> = { ...source };
    for (const key of keys) {
      const raw = source[key];
      if (typeof raw !== 'number') continue;
      let f = this.filters.get(key);
      if (!f) {
        f = new OneEuroFilter(this.opts);
        this.filters.set(key, f);
      }
      out[key] = f.filter(raw, tSeconds);
    }
    return out as T;
  }

  reset(): void {
    for (const f of this.filters.values()) f.reset();
  }
}

/**
 * A plain moving average over a fixed time window.
 *
 * Rotation KPIs depend on the depth axis, which MediaPipe estimates far less
 * precisely than the image plane. Simulation puts per-frame twist error at
 * 3.6-21 degrees across the plausible range of depth noise, so a live twist
 * readout smoothed like a tilt readout would be showing almost pure noise.
 * Averaging over ~30s cuts that by the square root of the sample count and
 * brings it back to something worth looking at. Posture drifts slowly enough
 * that the lag costs nothing.
 */
export class RollingMean {
  private readonly values: number[] = [];
  private readonly times: number[] = [];

  constructor(private readonly windowSeconds = 30) {}

  push(value: number, tSeconds: number): number {
    if (Number.isFinite(value)) {
      this.values.push(value);
      this.times.push(tSeconds);
    }
    const cutoff = tSeconds - this.windowSeconds;
    while (this.times.length && this.times[0] < cutoff) {
      this.times.shift();
      this.values.shift();
    }
    return this.mean;
  }

  get mean(): number {
    if (!this.values.length) return NaN;
    return this.values.reduce((a, b) => a + b, 0) / this.values.length;
  }

  /** How full the window is, 0..1 — lets the UI say "still settling". */
  fillFraction(tSeconds: number): number {
    if (!this.times.length) return 0;
    return Math.min(1, (tSeconds - this.times[0]) / this.windowSeconds);
  }

  reset(): void {
    this.values.length = 0;
    this.times.length = 0;
  }
}
