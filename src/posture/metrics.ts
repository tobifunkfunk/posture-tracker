import { PoseIdx, type CameraProfile, type PoseFrame, type PostureMetrics, type Vec3 } from './types';
import { landmarkDistance } from './frames';
import { mid, sub, toDeg } from './vec';

/**
 * Below this MediaPipe visibility a landmark is treated as guessed rather
 * than seen. Cross-legged sitting hides the hips often enough that gating on
 * this — instead of quietly averaging in fabricated points — is the
 * difference between a trend you can trust and one you cannot.
 */
export const HIP_VISIBILITY_FLOOR = 0.5;
export const UPPER_VISIBILITY_FLOOR = 0.6;

/** Angle of `v` away from vertical, in the plane spanned by `axis` and up. */
function tiltFromVertical(v: Vec3, axis: 'x' | 'z'): number {
  return toDeg(Math.atan2(v[axis], v.y));
}

/**
 * Rotation of a left-right body line about the vertical axis.
 * Negated so that positive means turning to the subject's left: rotating the
 * body left by beta sends the shoulder vector's z component negative.
 */
function yawOfLine(line: Vec3): number {
  return -toDeg(Math.atan2(line.z, line.x));
}

/** Tilt of a left-right body line away from horizontal. + = left end higher. */
function tiltOfLine(line: Vec3): number {
  return toDeg(Math.atan2(line.y, Math.hypot(line.x, line.z)));
}

/**
 * Compute every KPI from one BODY-frame pose.
 *
 * `frame` must already have been through `toBodyFrame`, otherwise the numbers
 * describe the camera as much as the meditator.
 */
export function computeMetrics(frame: PoseFrame, profile: CameraProfile): PostureMetrics {
  const ls = frame[PoseIdx.LeftShoulder];
  const rs = frame[PoseIdx.RightShoulder];
  const lh = frame[PoseIdx.LeftHip];
  const rh = frame[PoseIdx.RightHip];
  const nose = frame[PoseIdx.Nose];
  const le = frame[PoseIdx.LeftEar];
  const re = frame[PoseIdx.RightEar];

  const upperQuality = Math.min(
    ls?.visibility ?? 0,
    rs?.visibility ?? 0,
  );
  const hipQuality = Math.min(lh?.visibility ?? 0, rh?.visibility ?? 0);
  const hipsReliable = hipQuality >= HIP_VISIBILITY_FLOOR;

  const shoulderLine = ls && rs ? sub(ls, rs) : null;
  const hipLine = lh && rh ? sub(lh, rh) : null;
  const shoulderMid = ls && rs ? mid(ls, rs) : null;
  const hipMid = lh && rh ? mid(lh, rh) : null;
  const trunk = shoulderMid && hipMid ? sub(shoulderMid, hipMid) : null;

  // Prefer the calibrated width: it is measured over a whole reference sit and
  // so is far steadier than any single frame's estimate.
  const frameWidth = landmarkDistance(ls, rs);
  const width = Number.isFinite(profile.refShoulderWidth) && profile.refShoulderWidth > 0.05
    ? profile.refShoulderWidth
    : frameWidth;

  const shoulderTilt = shoulderLine ? tiltOfLine(shoulderLine) : NaN;
  const shoulderDropMm = ls && rs ? (ls.y - rs.y) * 1000 : NaN;
  const shoulderDropRatio = ls && rs && width > 0 ? (ls.y - rs.y) / width : NaN;

  const lateralLean = trunk ? tiltFromVertical(trunk, 'x') : NaN;
  const sagittalLean = trunk ? tiltFromVertical(trunk, 'z') : NaN;

  /*
   * Roll the whole rigid body left by alpha and the shoulder line tilts by
   * -alpha while the trunk leans by +alpha, so the two cancel. What survives
   * the sum is asymmetry the trunk does not explain: one shoulder genuinely
   * riding higher than the other rather than the whole torso listing.
   */
  const shoulderOnlyTilt = shoulderLine && trunk ? shoulderTilt + lateralLean : NaN;

  const torsoYaw = shoulderLine ? yawOfLine(shoulderLine) : NaN;
  const pelvisYaw = hipLine ? yawOfLine(hipLine) : NaN;
  // A cushion sitting at an angle turns shoulders and hips together and
  // vanishes here; only a real twist between them survives.
  const torsoTwist = shoulderLine && hipLine ? torsoYaw - pelvisYaw : NaN;

  const earLine = le && re ? sub(le, re) : null;
  const headRoll = earLine ? tiltOfLine(earLine) : NaN;
  const headRollVsShoulders = earLine && shoulderLine ? headRoll - shoulderTilt : NaN;
  const headYaw = earLine ? yawOfLine(earLine) : NaN;
  const headYawVsShoulders = earLine && shoulderLine ? headYaw - torsoYaw : NaN;

  const headLateralOffset =
    nose && shoulderMid && width > 0 ? (nose.x - shoulderMid.x) / width : NaN;

  return {
    shoulderTilt,
    shoulderDropMm,
    shoulderDropRatio,
    lateralLean,
    shoulderOnlyTilt,
    sagittalLean,
    torsoYaw,
    pelvisYaw,
    torsoTwist,
    headRoll,
    headRollVsShoulders,
    headYawVsShoulders,
    headLateralOffset,
    upperQuality,
    hipQuality,
    hipsReliable,
  };
}

/**
 * Head pose from FaceLandmarker's 4x4 transformation matrix, which is far
 * more accurate than inferring rotation from the ear line. Column-major, as
 * MediaPipe emits it. Returns degrees in the camera's own frame; the caller
 * rotates it into the BODY frame before comparing against the torso.
 */
export function headPoseFromMatrix(m: number[]): { yaw: number; pitch: number; roll: number } | null {
  if (!m || m.length < 16) return null;
  // Column-major 4x4 -> rotation entries r[row][col].
  const r00 = m[0]; const r10 = m[1];
  const r11 = m[5];
  const r02 = m[8]; const r12 = m[9]; const r22 = m[10];

  // Y-X-Z (yaw-pitch-roll) extraction, guarding the gimbal-lock pole.
  const sy = Math.hypot(r00, r10);
  if (sy < 1e-6) {
    return {
      yaw: toDeg(Math.atan2(-r02, r22)),
      pitch: toDeg(Math.atan2(-r12, sy)),
      roll: 0,
    };
  }
  return {
    yaw: toDeg(Math.atan2(r02, r22)),
    pitch: toDeg(Math.atan2(-r12, Math.hypot(r02, r22))),
    roll: toDeg(Math.atan2(r10, r11)),
  };
}

/** Human-readable names and units, shared by gauges, reports and CSV export. */
export const METRIC_META: Record<string, { label: string; unit: string; short: string; positive: string; negative: string; hipDependent: boolean }> = {
  shoulderTilt: { label: 'Shoulder tilt', unit: '°', short: 'Tilt', positive: 'left higher', negative: 'right higher', hipDependent: false },
  shoulderDropMm: { label: 'Shoulder height difference', unit: 'mm', short: 'Drop', positive: 'left higher', negative: 'right higher', hipDependent: false },
  shoulderDropRatio: { label: 'Shoulder drop / width', unit: '', short: 'Drop ratio', positive: 'left higher', negative: 'right higher', hipDependent: false },
  lateralLean: { label: 'Lateral lean', unit: '°', short: 'Lean', positive: 'leaning left', negative: 'leaning right', hipDependent: true },
  shoulderOnlyTilt: { label: 'Shoulder asymmetry (lean removed)', unit: '°', short: 'Asymmetry', positive: 'left higher', negative: 'right higher', hipDependent: true },
  sagittalLean: { label: 'Forward lean', unit: '°', short: 'Slump', positive: 'forward', negative: 'back', hipDependent: true },
  torsoYaw: { label: 'Torso rotation', unit: '°', short: 'Torso yaw', positive: 'turned left', negative: 'turned right', hipDependent: false },
  pelvisYaw: { label: 'Pelvis rotation', unit: '°', short: 'Pelvis yaw', positive: 'turned left', negative: 'turned right', hipDependent: true },
  torsoTwist: { label: 'Twist (shoulders vs hips)', unit: '°', short: 'Twist', positive: 'twisted left', negative: 'twisted right', hipDependent: true },
  headRoll: { label: 'Head roll', unit: '°', short: 'Head roll', positive: 'left ear higher', negative: 'right ear higher', hipDependent: false },
  headRollVsShoulders: { label: 'Head roll vs shoulders', unit: '°', short: 'Head roll rel.', positive: 'left ear higher', negative: 'right ear higher', hipDependent: false },
  headYawVsShoulders: { label: 'Head rotation vs shoulders', unit: '°', short: 'Head yaw rel.', positive: 'turned left', negative: 'turned right', hipDependent: false },
  headLateralOffset: { label: 'Head sideways offset', unit: '×width', short: 'Head offset', positive: 'to the left', negative: 'to the right', hipDependent: false },
};
