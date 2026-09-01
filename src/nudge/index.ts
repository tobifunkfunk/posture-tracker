/**
 * Feedback modalities. The governing constraint is that a nudge must never
 * become nagging: every channel is gated behind a sustained out-of-band
 * period and then silenced by a cooldown, so a single restless minute cannot
 * produce a stream of interruptions.
 */
import type { MetricKey, PostureMetrics } from '../posture/types';
import { DEFAULT_TOLERANCE } from '../posture/aggregate';
import type { NudgeSettings } from '../store/db';

export interface NudgeDecision {
  /** True while at least one watched metric sits outside its band. */
  outOfBand: boolean;
  /** 0..1, how far out of band the worst metric is — drives the glow. */
  severity: number;
  /** Set on the instant a nudge should fire. */
  fire: boolean;
  /** The metric responsible, for the live readout. */
  worst: MetricKey | null;
}

export class NudgeEngine {
  private outSince: number | null = null;
  private lastFiredAt = -Infinity;

  constructor(
    private settings: NudgeSettings,
    private tolerance: Partial<Record<MetricKey, number>> = {},
  ) {}

  update(settings: NudgeSettings, tolerance: Partial<Record<MetricKey, number>>): void {
    this.settings = settings;
    this.tolerance = tolerance;
  }

  evaluate(metrics: PostureMetrics, nowMs: number): NudgeDecision {
    let severity = 0;
    let worst: MetricKey | null = null;

    for (const key of this.settings.metrics) {
      const value = metrics[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      // Do not scold someone over hips the model could not see.
      if (HIP_DEPENDENT.has(key) && !metrics.hipsReliable) continue;

      const tol = this.tolerance[key] ?? DEFAULT_TOLERANCE[key];
      const excess = (Math.abs(value) - tol) / Math.max(tol, 1e-6);
      if (excess > severity) {
        severity = excess;
        worst = key;
      }
    }

    const outOfBand = severity > 0;
    if (!outOfBand) {
      this.outSince = null;
      return { outOfBand: false, severity: 0, fire: false, worst: null };
    }

    if (this.outSince === null) this.outSince = nowMs;
    const heldSec = (nowMs - this.outSince) / 1000;
    const cooledSec = (nowMs - this.lastFiredAt) / 1000;
    const fire = heldSec >= this.settings.minOutOfBandSec && cooledSec >= this.settings.cooldownSec;
    if (fire) this.lastFiredAt = nowMs;

    return { outOfBand: true, severity: Math.min(1, severity), fire, worst };
  }

  reset(): void {
    this.outSince = null;
    this.lastFiredAt = -Infinity;
  }
}

const HIP_DEPENDENT = new Set<MetricKey>([
  'lateralLean', 'shoulderOnlyTilt', 'sagittalLean', 'pelvisYaw', 'torsoTwist',
]);

/**
 * A soft synthesised tone. Generated rather than sampled so the PWA carries
 * no audio assets, and shaped with a long attack and release so it arrives
 * as a suggestion rather than an alarm.
 */
export class Chime {
  private ctx: AudioContext | null = null;

  /** Must run inside a user gesture; browsers start audio suspended. */
  async unlock(): Promise<void> {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  play(volume = 0.25, freq = 528): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;

    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.25);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 2.4);

    // A fundamental plus a quiet fifth: warmer than a bare sine.
    for (const [f, mix] of [[freq, 1], [freq * 1.5, 0.35]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = mix;
      osc.connect(g).connect(gain);
      osc.start(now);
      osc.stop(now + 2.5);
    }
  }

  /** The session bell: lower and longer than a posture nudge. */
  bell(volume = 0.3): void {
    this.play(volume, 288);
  }

  close(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}

/**
 * An edge tint that rises with severity. Designed to be legible through
 * almost-closed eyes, which is what makes it the only visual channel that
 * suits sitting with a soft gaze.
 */
export class AmbientGlow {
  private readonly el: HTMLDivElement;
  private current = 0;
  private raf: number | null = null;

  constructor(parent: HTMLElement = document.body) {
    this.el = document.createElement('div');
    this.el.className = 'ambient-glow';
    this.el.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.el);
  }

  /** `severity` 0..1. `side` tints the edge you are drifting toward. */
  set(severity: number, side: 'left' | 'right' | 'both' = 'both'): void {
    const target = Math.max(0, Math.min(1, severity));
    this.el.dataset.side = side;
    if (this.raf !== null) return;

    const step = () => {
      // Ease toward the target so the tint breathes instead of flickering.
      this.current += (target - this.current) * 0.06;
      this.el.style.opacity = String(this.current.toFixed(3));
      if (Math.abs(target - this.current) > 0.002) {
        this.raf = requestAnimationFrame(step);
      } else {
        this.raf = null;
      }
    };
    this.raf = requestAnimationFrame(step);
  }

  clear(): void {
    this.set(0);
  }

  destroy(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.el.remove();
  }
}
