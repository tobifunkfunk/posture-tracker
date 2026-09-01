/**
 * Turns a stream of raw MediaPipe frames into a session: corrects the frames,
 * computes KPIs, smooths them, and decimates to 1Hz for storage.
 *
 * Decimation matters twice over. It keeps an hour-long session down to a few
 * thousand points, and averaging five samples per second cuts landmark noise
 * by another factor of roughly two on top of the One Euro filter.
 */
import { METRIC_KEYS, type CameraProfile, type PoseFrame, type PostureMetrics, type Sample } from './types';
import { toBodyFrame } from './frames';
import { computeMetrics } from './metrics';
import { MetricFilterBank } from './filter';

export interface LiveState {
  /** Smoothed metrics for the current instant, for gauges and nudges. */
  metrics: PostureMetrics;
  /** Samples recorded so far. */
  count: number;
  elapsedMs: number;
}

export class SessionRecorder {
  private readonly filters = new MetricFilterBank();
  private readonly stored: Sample[] = [];
  private bucketStartMs = 0;
  private bucket: PostureMetrics[] = [];
  private startedAt = 0;
  private lastLive: PostureMetrics | null = null;
  private usableFrames = 0;
  private hipFrames = 0;
  private totalFrames = 0;

  constructor(private readonly profile: CameraProfile) {}

  begin(nowMs = performance.now()): void {
    this.startedAt = nowMs;
    this.bucketStartMs = 0;
  }

  /**
   * Feed one raw MediaPipe world frame. Returns the smoothed live state, or
   * null before the session has begun.
   */
  push(world: PoseFrame, nowMs = performance.now()): LiveState | null {
    if (!this.startedAt) return null;

    const elapsedMs = nowMs - this.startedAt;
    const body = toBodyFrame(world, this.profile);
    const raw = computeMetrics(body, this.profile);
    const smoothed = this.filters.filter(raw, elapsedMs / 1000, METRIC_KEYS);

    this.totalFrames++;
    if (smoothed.upperQuality >= 0.6) this.usableFrames++;
    if (smoothed.hipsReliable) this.hipFrames++;

    this.lastLive = smoothed;
    this.bucket.push(smoothed);

    // Close the one-second bucket and store its average.
    const bucketIndex = Math.floor(elapsedMs / 1000);
    if (bucketIndex > this.bucketStartMs) {
      this.flushBucket(this.bucketStartMs * 1000);
      this.bucketStartMs = bucketIndex;
    }

    return { metrics: smoothed, count: this.stored.length, elapsedMs };
  }

  private flushBucket(tMs: number): void {
    if (!this.bucket.length) return;
    const averaged = averageMetrics(this.bucket);
    this.stored.push({ t: tMs, metrics: averaged });
    this.bucket = [];
  }

  /** Close the final bucket and hand back everything recorded. */
  end(nowMs = performance.now()): { samples: Sample[]; durationMs: number; quality: number; hipQuality: number } {
    this.flushBucket(this.bucketStartMs * 1000);
    return {
      samples: this.stored,
      durationMs: this.startedAt ? nowMs - this.startedAt : 0,
      quality: this.totalFrames ? this.usableFrames / this.totalFrames : 0,
      hipQuality: this.totalFrames ? this.hipFrames / this.totalFrames : 0,
    };
  }

  get live(): PostureMetrics | null {
    return this.lastLive;
  }

  get samples(): readonly Sample[] {
    return this.stored;
  }
}

/**
 * Mean of a bucket of metrics, skipping non-finite entries per key so a
 * momentarily lost landmark does not poison the whole second.
 */
export function averageMetrics(bucket: PostureMetrics[]): PostureMetrics {
  const out = { ...bucket[bucket.length - 1] } as PostureMetrics & Record<string, unknown>;
  for (const key of METRIC_KEYS) {
    const vals = bucket
      .map((m) => m[key])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    out[key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
  }
  out.upperQuality = mean(bucket.map((m) => m.upperQuality));
  out.hipQuality = mean(bucket.map((m) => m.hipQuality));
  // A second counts as hip-reliable only if most of its frames were.
  out.hipsReliable = bucket.filter((m) => m.hipsReliable).length > bucket.length / 2;
  return out;
}

function mean(xs: number[]): number {
  const ok = xs.filter((v) => Number.isFinite(v));
  return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : 0;
}
