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

/**
 * Combine two estimates of the same angle, weighted by how well each source
 * was seen. Falls back to whichever is usable when the other is not.
 *
 * The ear baseline is roughly 1.7x the eye baseline, so when both are equally
 * visible the ear estimate is given proportionally more weight.
 */
function fuse(a: number, visA: number, b: number, visB: number): number {
  const okA = Number.isFinite(a) && visA > 0.5;
  const okB = Number.isFinite(b) && visB > 0.5;
  if (okA && okB) {
    const wa = visA * 1.7;
    const wb = visB;
    return (a * wa + b * wb) / (wa + wb);
  }
  if (okA) return a;
  if (okB) return b;
  return Number.isFinite(a) ? a : b;
}

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

/** Euclidean length of a line vector. */
function lineLength(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
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
export interface MetricOverrides {
  /**
   * Trunk lean measured from the silhouette, in degrees, already in the body
   * convention (+ = leaning to the subject's left). Preferred over the
   * hip-derived value whenever it is available.
   */
  lateralLean?: number;
}

export function computeMetrics(
  frame: PoseFrame,
  profile: CameraProfile,
  overrides: MetricOverrides = {},
): PostureMetrics {
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

  /*
   * Lean prefers the silhouette. Its centre line is fitted from thousands of
   * pixels in the image plane, where the hip-derived version rests on two
   * landmarks that a meditation bench hides entirely.
   */
  const hipLean = trunk && hipsReliable ? tiltFromVertical(trunk, 'x') : NaN;
  const silhouetteLean = overrides.lateralLean;
  const lateralLean = Number.isFinite(silhouetteLean) ? (silhouetteLean as number) : hipLean;
  const leanSource: PostureMetrics['leanSource'] = Number.isFinite(silhouetteLean)
    ? 'silhouette'
    : Number.isFinite(hipLean) ? 'hips' : 'none';

  // Depth is invisible in a frontal outline, so forward lean still needs hips.
  const sagittalLean = trunk && hipsReliable ? tiltFromVertical(trunk, 'z') : NaN;

  /*
   * Roll the whole rigid body left by alpha and the shoulder line tilts by
   * -alpha while the trunk leans by +alpha, so the two cancel. What survives
   * the sum is asymmetry the trunk does not explain: one shoulder genuinely
   * riding higher than the other rather than the whole torso listing.
   */
  const shoulderOnlyTilt =
    shoulderLine && Number.isFinite(lateralLean) ? shoulderTilt + lateralLean : NaN;

  const torsoYaw = shoulderLine ? yawOfLine(shoulderLine) : NaN;
  const pelvisYaw = hipLine && hipsReliable ? yawOfLine(hipLine) : NaN;
  // A cushion sitting at an angle turns shoulders and hips together and
  // vanishes here; only a real twist between them survives.
  const torsoTwist =
    shoulderLine && hipLine && hipsReliable ? torsoYaw - pelvisYaw : NaN;

  /*
   * Head roll is measured twice, because the two available baselines fail in
   * opposite ways. The ear line is long (~15cm), which suppresses angular
   * noise, but hair and hoods hide ears constantly. The eye line is short
   * (~9cm across the outer corners), so the same positional error becomes a
   * bigger angle — but eyes are almost always visible and the model localises
   * them well. Fusing by visibility uses whichever is actually working.
   */
  const earLineRaw = le && re ? sub(le, re) : null;
  const earLine = earLineRaw && lineLength(earLineRaw) > 0.02 ? earLineRaw : null;
  const headRollEars = earLine ? tiltOfLine(earLine) : NaN;

  // Outer corners rather than eye centres: a wider baseline for the same
  // landmark error is a directly better angle.
  const leo = frame[PoseIdx.LeftEyeOuter];
  const reo = frame[PoseIdx.RightEyeOuter];
  const lec = frame[PoseIdx.LeftEye];
  const rec = frame[PoseIdx.RightEye];
  const eyeA = leo && leo.visibility > 0.5 ? leo : lec;
  const eyeB = reo && reo.visibility > 0.5 ? reo : rec;
  const eyeLine = eyeA && eyeB ? sub(eyeA, eyeB) : null;
  // A degenerate line has no angle to report, whatever visibility claims.
  const headRollEyes = eyeLine && lineLength(eyeLine) > 0.02 ? tiltOfLine(eyeLine) : NaN;

  const earVis = Math.min(le?.visibility ?? 0, re?.visibility ?? 0);
  const eyeVis = Math.min(eyeA?.visibility ?? 0, eyeB?.visibility ?? 0);
  const headRoll = fuse(headRollEars, earVis, headRollEyes, eyeVis);

  const headRollVsShoulders =
    Number.isFinite(headRoll) && shoulderLine ? headRoll - shoulderTilt : NaN;

  // Yaw still comes from the ears: it depends on the depth axis, and the eyes
  // are too close together in depth to resolve a rotation from.
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
    headRollEyes,
    headRollEars,
    headRollVsShoulders,
    headYawVsShoulders,
    headLateralOffset,
    upperQuality,
    hipQuality,
    hipsReliable,
    leanSource,
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
  headRoll: { label: 'Head tilt', unit: '°', short: 'Head tilt', positive: 'left side higher', negative: 'right side higher', hipDependent: false },
  headRollEyes: { label: 'Head tilt (eyes)', unit: '°', short: 'Eyes', positive: 'left eye higher', negative: 'right eye higher', hipDependent: false },
  headRollEars: { label: 'Head tilt (ears)', unit: '°', short: 'Ears', positive: 'left ear higher', negative: 'right ear higher', hipDependent: false },
  headRollVsShoulders: { label: 'Head tilt vs shoulders', unit: '°', short: 'Head tilt rel.', positive: 'left side higher', negative: 'right side higher', hipDependent: false },
  headYawVsShoulders: { label: 'Head rotation vs shoulders', unit: '°', short: 'Head yaw rel.', positive: 'turned left', negative: 'turned right', hipDependent: false },
  headLateralOffset: { label: 'Head sideways offset', unit: '×width', short: 'Head offset', positive: 'to the left', negative: 'to the right', hipDependent: false },
};
