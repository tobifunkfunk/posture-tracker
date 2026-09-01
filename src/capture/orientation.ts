/**
 * Access to the phone's gravity vector, which is what lets the app tell a
 * crooked tripod from a crooked meditator. Without it a 3 degree camera roll
 * is indistinguishable from a 3 degree shoulder tilt.
 */
import type { Vec3 } from '../posture/types';

type PermissionState = 'unsupported' | 'granted' | 'denied' | 'prompt';

interface MotionEventCtor {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

/** iOS gates the motion sensors behind an explicit user gesture. */
export function motionPermissionState(): PermissionState {
  if (typeof DeviceMotionEvent === 'undefined') return 'unsupported';
  const ctor = DeviceMotionEvent as unknown as MotionEventCtor;
  return typeof ctor.requestPermission === 'function' ? 'prompt' : 'granted';
}

/** Must be called from inside a click/tap handler or iOS rejects it outright. */
export async function requestMotionPermission(): Promise<PermissionState> {
  const state = motionPermissionState();
  if (state !== 'prompt') return state;
  try {
    const ctor = DeviceMotionEvent as unknown as MotionEventCtor;
    const result = await ctor.requestPermission!();
    return result === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

export interface GravityReading {
  vector: Vec3;
  /** Samples collected. Under ~10 the average is not worth trusting. */
  samples: number;
  /** Spread across samples, m/s^2. Large means the tripod was still moving. */
  stability: number;
}

/**
 * Average `accelerationIncludingGravity` while the rig sits still.
 * The sign convention differs between engines, so this deliberately returns
 * the raw averaged vector; `calibrateGravity` resolves the sign by checking
 * it against a body it can actually see.
 */
export function readGravity(durationMs = 2000): Promise<GravityReading | null> {
  return new Promise((resolve) => {
    if (typeof DeviceMotionEvent === 'undefined') {
      resolve(null);
      return;
    }

    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];

    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x === null || a.y === null || a.z === null) return;
      xs.push(a.x);
      ys.push(a.y);
      zs.push(a.z);
    };

    window.addEventListener('devicemotion', onMotion);
    window.setTimeout(() => {
      window.removeEventListener('devicemotion', onMotion);
      if (xs.length === 0) {
        resolve(null);
        return;
      }
      const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
      const sd = (v: number[]) => {
        if (v.length < 2) return 0;
        const m = mean(v);
        return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
      };
      resolve({
        vector: { x: mean(xs), y: mean(ys), z: mean(zs) },
        samples: xs.length,
        stability: Math.max(sd(xs), sd(ys), sd(zs)),
      });
    }, durationMs);
  });
}

/**
 * Watch for the tripod being knocked mid-session. A shifted camera silently
 * rebases every angle, so the session gets flagged rather than trusted.
 */
export class TripodWatcher {
  private baseline: Vec3 | null = null;
  private last: Vec3 | null = null;
  private handler: ((e: DeviceMotionEvent) => void) | null = null;

  start(baseline: Vec3): void {
    this.baseline = baseline;
    this.handler = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x === null || a.y === null || a.z === null) return;
      this.last = { x: a.x, y: a.y, z: a.z };
    };
    window.addEventListener('devicemotion', this.handler);
  }

  /** Degrees the camera has moved since the baseline, or null if unknown. */
  driftDegrees(): number | null {
    if (!this.baseline || !this.last) return null;
    const norm = (v: Vec3) => Math.hypot(v.x, v.y, v.z) || 1;
    const a = this.baseline;
    const b = this.last;
    const cos = (a.x * b.x + a.y * b.y + a.z * b.z) / (norm(a) * norm(b));
    return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
  }

  stop(): void {
    if (this.handler) window.removeEventListener('devicemotion', this.handler);
    this.handler = null;
  }
}
