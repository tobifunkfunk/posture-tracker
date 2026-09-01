/**
 * Synthetic pose generator: builds a body with known posture angles, then
 * projects it through a known camera so tests can assert the pipeline
 * recovers exactly what went in. This is the forward model — the precise
 * inverse of `toBodyFrame`.
 */
import { applyMat3, mulMat3, normalize, rotX, rotY, rotZ, vec, type Mat3 } from '../src/posture/vec';
import { gravityMatrix, toPhysics } from '../src/posture/frames';
import { MIRROR_PAIRS, PoseIdx, type CameraProfile, type PoseFrame, type Vec3 } from '../src/posture/types';

/** Neutral seated skeleton in the BODY frame, metres, hip midpoint at origin. */
const SHOULDER_HALF = 0.19;
const HIP_HALF = 0.09;
const TRUNK = 0.55;
const NECK = 0.25;
const EAR_HALF = 0.075;
const EYE_OUTER_HALF = 0.045;
const EYE_CENTRE_HALF = 0.032;
const EYE_INNER_HALF = 0.018;
const EYE_RISE = 0.02;
const EYE_FORWARD = 0.08;

export interface BodyPose {
  /** Whole-trunk roll, degrees. Positive leans to the subject's LEFT. */
  lateralLean?: number;
  /** Whole-trunk pitch, degrees. Positive leans FORWARD. */
  sagittalLean?: number;
  /** Rotation of the whole body about vertical, degrees. Positive = turning left. */
  bodyYaw?: number;
  /** Extra shoulder-girdle rotation on top of `bodyYaw` — this creates twist. */
  shoulderExtraYaw?: number;
  /** Extra shoulder-line tilt independent of the trunk, degrees. + = left higher. */
  shoulderExtraTilt?: number;
  /** Head rotation about vertical relative to the shoulders, degrees. */
  headYaw?: number;
  /** Head roll relative to the shoulders, degrees. */
  headRoll?: number;
}

const d2r = (d: number) => (d * Math.PI) / 180;

function put(frame: PoseFrame, idx: number, p: Vec3, visibility = 0.95): void {
  frame[idx] = { x: p.x, y: p.y, z: p.z, visibility };
}

/** Build a BODY-frame pose with the requested angles baked in. */
export function makeBody(pose: BodyPose = {}, visibility = 0.95): PoseFrame {
  const {
    lateralLean = 0, sagittalLean = 0, bodyYaw = 0,
    shoulderExtraYaw = 0, shoulderExtraTilt = 0, headYaw = 0, headRoll = 0,
  } = pose;

  const frame: PoseFrame = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility }));

  // Trunk transform: yaw about vertical, then lean. A positive `lateralLean`
  // must tip the trunk toward +X, and rotZ(a) sends the trunk to -sin(a), so
  // the sign is inverted here.
  const yaw = rotY(d2r(bodyYaw));
  const roll = rotZ(-d2r(lateralLean));
  const pitch = rotX(d2r(sagittalLean));
  const trunkM = mulMat3(yaw, mulMat3(roll, pitch));

  // Hips ride the trunk transform alone.
  put(frame, PoseIdx.LeftHip, applyMat3(trunkM, vec(HIP_HALF, 0, 0)), visibility);
  put(frame, PoseIdx.RightHip, applyMat3(trunkM, vec(-HIP_HALF, 0, 0)), visibility);

  // Shoulders sit at the top of the trunk and may carry extra rotation/tilt.
  const shoulderMid = applyMat3(trunkM, vec(0, TRUNK, 0));
  const girdle = mulMat3(rotY(d2r(shoulderExtraYaw)), rotZ(d2r(shoulderExtraTilt)));
  const shoulderM = mulMat3(trunkM, girdle);
  const lsOff = applyMat3(shoulderM, vec(SHOULDER_HALF, 0, 0));
  const rsOff = applyMat3(shoulderM, vec(-SHOULDER_HALF, 0, 0));
  put(frame, PoseIdx.LeftShoulder, vec(shoulderMid.x + lsOff.x, shoulderMid.y + lsOff.y, shoulderMid.z + lsOff.z), visibility);
  put(frame, PoseIdx.RightShoulder, vec(shoulderMid.x + rsOff.x, shoulderMid.y + rsOff.y, shoulderMid.z + rsOff.z), visibility);

  // Head sits above the shoulders, carrying its own rotation on top.
  const neckTop = applyMat3(shoulderM, vec(0, NECK, 0));
  const headOrigin = vec(shoulderMid.x + neckTop.x, shoulderMid.y + neckTop.y, shoulderMid.z + neckTop.z);
  const headM = mulMat3(shoulderM, mulMat3(rotY(d2r(headYaw)), rotZ(d2r(headRoll))));
  const leOff = applyMat3(headM, vec(EAR_HALF, 0, 0));
  const reOff = applyMat3(headM, vec(-EAR_HALF, 0, 0));
  const noseOff = applyMat3(headM, vec(0, 0.02, 0.11));

  // Eyes sit forward of the ear axis and slightly above it. Outer corners are
  // the widest reliable pair, which is what the roll metric prefers.
  const eye = (dx: number) => applyMat3(headM, vec(dx, EYE_RISE, EYE_FORWARD));
  const eyePoints: Array<[number, number]> = [
    [PoseIdx.LeftEyeOuter, EYE_OUTER_HALF],
    [PoseIdx.LeftEye, EYE_CENTRE_HALF],
    [PoseIdx.LeftEyeInner, EYE_INNER_HALF],
    [PoseIdx.RightEyeOuter, -EYE_OUTER_HALF],
    [PoseIdx.RightEye, -EYE_CENTRE_HALF],
    [PoseIdx.RightEyeInner, -EYE_INNER_HALF],
  ];
  for (const [idx, dx] of eyePoints) {
    const off = eye(dx);
    put(frame, idx, vec(headOrigin.x + off.x, headOrigin.y + off.y, headOrigin.z + off.z), visibility);
  }
  put(frame, PoseIdx.LeftEar, vec(headOrigin.x + leOff.x, headOrigin.y + leOff.y, headOrigin.z + leOff.z), visibility);
  put(frame, PoseIdx.RightEar, vec(headOrigin.x + reOff.x, headOrigin.y + reOff.y, headOrigin.z + reOff.z), visibility);
  put(frame, PoseIdx.Nose, vec(headOrigin.x + noseOff.x, headOrigin.y + noseOff.y, headOrigin.z + noseOff.z), visibility);

  return frame;
}

/** Transpose of a rotation matrix, i.e. its inverse. */
function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export interface CameraSetup {
  /** Camera azimuth in degrees. 35 means the tripod stands 35 deg off-axis. */
  azimuthDeg?: number;
  /** Camera roll in degrees — an unlevel tripod. */
  rollDeg?: number;
  /** Camera pitch in degrees — the camera looking up or down. */
  pitchDeg?: number;
  mirrored?: boolean;
}

/** The gravity-down direction a camera with this roll/pitch would report. */
export function gravityFor(setup: CameraSetup): Vec3 {
  const roll = rotZ(d2r(setup.rollDeg ?? 0));
  const pitch = rotX(d2r(setup.pitchDeg ?? 0));
  return normalize(applyMat3(mulMat3(roll, pitch), vec(0, -1, 0)));
}

/**
 * Project a BODY-frame pose out into RAW MediaPipe world landmarks, exactly
 * inverting the pipeline: azimuth, then camera orientation, then the mirror,
 * then MediaPipe's y-down/z-away axis convention.
 */
export function project(body: PoseFrame, setup: CameraSetup = {}): PoseFrame {
  const azimuth = d2r(setup.azimuthDeg ?? 0);
  const gInv = transpose(gravityMatrix(gravityFor(setup)));
  const m = mulMat3(gInv, rotY(azimuth));

  let out: PoseFrame = body.map((p) => {
    const r = applyMat3(m, p);
    return { x: r.x, y: r.y, z: r.z, visibility: p.visibility };
  });

  if (setup.mirrored) {
    out = out.map((p) => ({ x: -p.x, y: p.y, z: p.z, visibility: p.visibility }));
    for (const [a, b] of MIRROR_PAIRS) {
      const tmp = out[a];
      out[a] = out[b];
      out[b] = tmp;
    }
  }

  // PHYSICS -> RAW is the same involution as RAW -> PHYSICS.
  return toPhysics(out);
}

/** A profile matching a given camera setup, as calibration would produce it. */
export function profileFor(setup: CameraSetup = {}): CameraProfile {
  return {
    id: 'test',
    name: 'test',
    createdAt: 0,
    gravityDown: gravityFor(setup),
    mirrored: setup.mirrored ?? false,
    azimuth: d2r(setup.azimuthDeg ?? 0),
    refShoulderWidth: SHOULDER_HALF * 2,
    refTrunkLength: TRUNK,
    gravitySource: 'sensor',
    hipsUsable: true,
  };
}

export const DIMS = { SHOULDER_HALF, HIP_HALF, TRUNK, NECK, EAR_HALF, EYE_OUTER_HALF };
