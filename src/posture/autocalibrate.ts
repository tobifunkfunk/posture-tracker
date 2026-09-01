/**
 * Calibration without the ritual.
 *
 * The reference sit existed to pin one number: the camera's azimuth. Once the
 * trunk axis came from the silhouette, almost nothing depended on it any more.
 * Shoulder tilt, shoulder height, lean, asymmetry and every head-tilt measure
 * are referenced to gravity, which the phone reports directly — they are
 * absolute, and comparable across sessions with no baseline at all.
 *
 * Torso rotation is the exception, and it is exactly offset by any azimuth
 * error. Being linear, it can be corrected after the fact: record with
 * whatever azimuth is currently believed, then re-express the stored values
 * against a better estimate once the session has supplied one.
 *
 * That leaves a genuine ambiguity no single camera can resolve: a camera
 * standing 10 degrees off-axis and a person sitting rotated 10 degrees look
 * identical. Pooling across sessions is the honest way through it. Where the
 * camera sits is fixed, while how the person sits varies, so the pooled
 * estimate converges on the camera and each session's departure from it is
 * the person. What survives is change over time, not absolute rotation.
 */
import type { Sample } from './types';
import { median, toDeg, toRad } from './vec';

export interface AzimuthEstimate {
  /** The session's own estimate of the true camera azimuth, radians. */
  azimuth: number;
  /** Median yaw seen during the session, degrees, under the azimuth used. */
  medianYawDeg: number;
  /** Spread of the yaw readings — large means the sitter kept turning. */
  spreadDeg: number;
  samples: number;
}

/**
 * Estimate the camera azimuth from a session's yaw readings.
 *
 * Assumes the sitter faced their habitual direction on average, so a non-zero
 * median yaw is read as the calibration being off rather than as a person who
 * spent the whole sit rotated.
 */
export function sessionAzimuthEstimate(
  usedAzimuthRad: number,
  yawSamplesDeg: number[],
): AzimuthEstimate | null {
  const usable = yawSamplesDeg.filter((v) => Number.isFinite(v));
  if (usable.length < 10) return null;

  const medianYawDeg = median(usable);
  const deviations = usable.map((v) => Math.abs(v - medianYawDeg)).sort((a, b) => a - b);
  // Median absolute deviation, scaled to compare with a standard deviation.
  const spreadDeg = median(deviations) * 1.4826;

  return {
    azimuth: usedAzimuthRad + toRad(medianYawDeg),
    medianYawDeg,
    spreadDeg,
    samples: usable.length,
  };
}

/**
 * Beyond this, the new estimate is not the same setup any more. Pooling it in
 * would quietly corrupt the profile and make old sessions incomparable, so it
 * is treated as a moved camera instead.
 */
export const SETUP_CHANGE_THRESHOLD_DEG = 25;

export interface PoolResult {
  azimuth: number;
  /** True when the estimate was too far off to belong to the same setup. */
  setupChanged: boolean;
  /** How far this session's estimate sat from the running one, degrees. */
  deviationDeg: number;
}

/**
 * Fold a session's estimate into the running one.
 *
 * The weight decays as sessions accumulate but never below a tenth, so the
 * profile settles quickly yet can still follow a tripod that was nudged
 * slightly and left there.
 */
export function poolAzimuth(
  currentRad: number,
  sessionCount: number,
  estimate: AzimuthEstimate,
): PoolResult {
  const deviationDeg = toDeg(estimate.azimuth - currentRad);

  if (sessionCount > 0 && Math.abs(deviationDeg) > SETUP_CHANGE_THRESHOLD_DEG) {
    // Adopt the new geometry rather than averaging two different setups.
    return { azimuth: estimate.azimuth, setupChanged: true, deviationDeg };
  }

  if (sessionCount <= 0) {
    return { azimuth: estimate.azimuth, setupChanged: false, deviationDeg };
  }

  const weight = Math.max(1 / (sessionCount + 1), 0.1);
  return {
    azimuth: currentRad + (estimate.azimuth - currentRad) * weight,
    setupChanged: false,
    deviationDeg,
  };
}

/**
 * Re-express stored yaw readings against a different azimuth.
 *
 * Yaw is offset exactly by the azimuth error, so this is a subtraction rather
 * than a re-derivation — which is what lets a session record immediately and
 * be corrected once it ends, with no settling period to sit through.
 */
export function applyYawCorrection(samples: Sample[], correctionDeg: number): void {
  if (!Number.isFinite(correctionDeg) || Math.abs(correctionDeg) < 1e-9) return;
  for (const s of samples) {
    if (Number.isFinite(s.metrics.torsoYaw)) s.metrics.torsoYaw -= correctionDeg;
    if (Number.isFinite(s.metrics.pelvisYaw)) s.metrics.pelvisYaw -= correctionDeg;
    // Twist and head-vs-shoulders are differences of two yaws, so the offset
    // has already cancelled and must not be applied twice.
  }
}

/** Accumulates what a session reveals about its own setup. */
export class AutoCalibrator {
  private readonly yaws: number[] = [];
  private readonly widths: number[] = [];
  private hipFrames = 0;
  private total = 0;

  constructor(private readonly usedAzimuthRad: number) {}

  observe(torsoYawDeg: number, shoulderWidth: number, hipsReliable: boolean): void {
    this.total++;
    if (Number.isFinite(torsoYawDeg)) this.yaws.push(torsoYawDeg);
    if (Number.isFinite(shoulderWidth) && shoulderWidth > 0.05) this.widths.push(shoulderWidth);
    if (hipsReliable) this.hipFrames++;
  }

  estimate(): AzimuthEstimate | null {
    return sessionAzimuthEstimate(this.usedAzimuthRad, this.yaws);
  }

  get shoulderWidth(): number {
    return this.widths.length ? median(this.widths) : NaN;
  }

  /** Hips are only worth relying on if they were there most of the time. */
  get hipsUsable(): boolean {
    return this.total > 0 && this.hipFrames / this.total > 0.6;
  }
}
