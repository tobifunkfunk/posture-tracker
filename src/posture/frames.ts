import {
  applyMat3, mulMat3, normalize, rotationBetween, rotY, scale, sub, vec,
  type Mat3,
} from './vec';
import { MIRROR_PAIRS, PoseIdx, type CameraProfile, type Landmark, type PoseFrame, type Vec3 } from './types';

/** Straight down in the PHYSICS frame — the target for gravity alignment. */
export const DOWN: Vec3 = vec(0, -1, 0);

/**
 * RAW -> PHYSICS. MediaPipe's world frame has +Y pointing down the image and
 * +Z pointing away from the camera; flip both so the maths reads normally.
 */
export function toPhysics(raw: PoseFrame): PoseFrame {
  return raw.map((p) => ({ x: p.x, y: -p.y, z: -p.z, visibility: p.visibility }));
}

/**
 * Undo a mirrored feed: reflect across the image's vertical axis and swap the
 * left/right landmark labels MediaPipe assigned to the reflected body.
 * A no-op when the profile says the feed is already true-handed.
 */
export function applyMirror(frame: PoseFrame, mirrored: boolean): PoseFrame {
  if (!mirrored) return frame;
  const out = frame.map((p) => ({ x: -p.x, y: p.y, z: p.z, visibility: p.visibility }));
  for (const [a, b] of MIRROR_PAIRS) {
    if (a < out.length && b < out.length) {
      const tmp = out[a];
      out[a] = out[b];
      out[b] = tmp;
    }
  }
  return out;
}

/**
 * The rotation taking the PHYSICS frame to the UPRIGHT frame, i.e. the one
 * that carries the measured gravity direction onto true down.
 */
export function gravityMatrix(gravityDown: Vec3): Mat3 {
  return rotationBetween(normalize(gravityDown, DOWN), DOWN);
}

/** The full PHYSICS -> BODY rotation for a profile: gravity first, then azimuth. */
export function bodyMatrix(profile: Pick<CameraProfile, 'gravityDown' | 'azimuth'>): Mat3 {
  return mulMat3(rotY(-profile.azimuth), gravityMatrix(profile.gravityDown));
}

/** Apply a rotation to every landmark, carrying visibility through untouched. */
export function rotateFrame(frame: PoseFrame, m: Mat3): PoseFrame {
  return frame.map((p) => {
    const r = applyMat3(m, p);
    return { x: r.x, y: r.y, z: r.z, visibility: p.visibility };
  });
}

/**
 * The whole correction chain: RAW MediaPipe world landmarks in, BODY-frame
 * landmarks out, ready for `computeMetrics`.
 */
export function toBodyFrame(raw: PoseFrame, profile: CameraProfile): PoseFrame {
  const physics = toPhysics(raw);
  const unmirrored = applyMirror(physics, profile.mirrored);
  return rotateFrame(unmirrored, bodyMatrix(profile));
}

/**
 * Map the device's gravity reading into the PHYSICS frame.
 *
 * `accelerationIncludingGravity` is the classic cross-browser sign trap: at
 * rest some engines report gravity, others report the specific force that
 * opposes it. Rather than guess, `calibrateGravity` resolves the sign against
 * a body it can see, using the fact that a seated person's shoulders are
 * above their hips.
 */
export function deviceGravityToPhysics(a: { x: number; y: number; z: number }): Vec3 {
  // Screen axes line up with image axes in portrait: device +x is image right,
  // device +y is image up. Depth does not affect roll, which is what matters.
  return normalize(vec(a.x, a.y, a.z), DOWN);
}

export interface GravityCalibrationInput {
  /** Averaged device accelerometer reading while the tripod was still. */
  reading: { x: number; y: number; z: number };
  /** A few PHYSICS-frame frames of the subject sitting, for the sign check. */
  sampleFrames: PoseFrame[];
}

/**
 * Resolve the accelerometer's sign convention by testing both candidates and
 * keeping whichever leaves the subject's shoulders above their hips. A person
 * sitting upside-down in front of the tripod is not a case worth supporting.
 */
export function calibrateGravity({ reading, sampleFrames }: GravityCalibrationInput): {
  gravityDown: Vec3;
  flipped: boolean;
  confident: boolean;
} {
  const candidate = deviceGravityToPhysics(reading);
  const options: Array<{ g: Vec3; flipped: boolean }> = [
    { g: candidate, flipped: false },
    { g: scale(candidate, -1), flipped: true },
  ];

  let best = options[0];
  let bestScore = -Infinity;
  for (const opt of options) {
    const m = gravityMatrix(opt.g);
    // Mean trunk rise (shoulder midpoint above hip midpoint) under this hypothesis.
    let score = 0;
    let n = 0;
    for (const f of sampleFrames) {
      const t = trunkVector(rotateFrame(f, m));
      if (t) {
        score += t.y;
        n++;
      }
    }
    if (n === 0) continue;
    score /= n;
    if (score > bestScore) {
      bestScore = score;
      best = opt;
    }
  }

  return {
    gravityDown: best.g,
    flipped: best.flipped,
    // A real seated trunk rises ~40-60cm; anything less means we could not tell.
    confident: bestScore > 0.15,
  };
}

/** Hip midpoint -> shoulder midpoint, or null when a landmark is missing. */
export function trunkVector(frame: PoseFrame): Vec3 | null {
  const ls = frame[PoseIdx.LeftShoulder];
  const rs = frame[PoseIdx.RightShoulder];
  const lh = frame[PoseIdx.LeftHip];
  const rh = frame[PoseIdx.RightHip];
  if (!ls || !rs || !lh || !rh) return null;
  const shoulderMid = scale({ x: ls.x + rs.x, y: ls.y + rs.y, z: ls.z + rs.z }, 0.5);
  const hipMid = scale({ x: lh.x + rh.x, y: lh.y + rh.y, z: lh.z + rh.z }, 0.5);
  return sub(shoulderMid, hipMid);
}

/**
 * Derive the camera azimuth from the reference sit: the angle the shoulder
 * line makes with the image X axis once gravity has been removed, signed so
 * that positive means the tripod stands to the subject's right. Feeding
 * this back through `rotY(-azimuth)` puts the subject's neutral at zero
 * rotation, which is what makes "am I twisted compared to my own normal?"
 * answerable from a single off-axis camera.
 */
export function calibrateAzimuth(upright: PoseFrame[]): { azimuth: number; spreadDeg: number } {
  const angles: number[] = [];
  for (const f of upright) {
    const ls = f[PoseIdx.LeftShoulder];
    const rs = f[PoseIdx.RightShoulder];
    if (!ls || !rs) continue;
    // Negated to match `yawOfLine`: positive is a turn to the subject's left,
    // which is what `bodyMatrix`'s rotY(-azimuth) expects to undo.
    angles.push(-Math.atan2(ls.z - rs.z, ls.x - rs.x));
  }
  if (angles.length === 0) return { azimuth: 0, spreadDeg: NaN };

  // Circular mean, then circular spread as a stability check on the sit.
  let sx = 0;
  let sy = 0;
  for (const a of angles) {
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  const azimuth = Math.atan2(sy, sx);
  const r = Math.hypot(sx, sy) / angles.length;
  const spreadDeg = (Math.sqrt(Math.max(0, -2 * Math.log(Math.max(r, 1e-9)))) * 180) / Math.PI;
  return { azimuth, spreadDeg };
}

/**
 * Straight-line distance between two landmarks, in metres.
 * Used for shoulder width and trunk length, which anchor the ratio metrics.
 */
export function landmarkDistance(a: Landmark | undefined, b: Landmark | undefined): number {
  if (!a || !b) return NaN;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export { applyMat3, rotY };
