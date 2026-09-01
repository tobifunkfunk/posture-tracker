/**
 * Core types for the posture pipeline.
 *
 * Coordinate frames, in the order the pipeline applies them:
 *
 *  1. RAW (as MediaPipe emits `worldLandmarks`)
 *     Metres, origin at the hip midpoint, axes glued to the camera:
 *     +X image-right, +Y image-DOWN, +Z away from the camera.
 *
 *  2. PHYSICS (`toPhysics`)
 *     Same origin, but +Y up and +Z toward the camera, so the maths reads
 *     like maths: p = (x, -y, -z).
 *
 *  3. UPRIGHT (`gravityAlign`)
 *     Camera roll and pitch removed using the phone's gravity vector.
 *     +Y is now true vertical. Azimuth is still arbitrary.
 *
 *  4. BODY (`yawAlign`)
 *     Camera azimuth removed using the reference sit, giving a
 *     right-handed frame tied to the body:
 *       +X = the subject's LEFT
 *       +Y = up (gravity)
 *       +Z = the subject's reference facing direction
 *     All KPIs are computed here.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A landmark carries MediaPipe's per-point confidence alongside position. */
export interface Landmark extends Vec3 {
  /** 0..1 — how sure the model is that this point is where it says. */
  visibility: number;
}

/** MediaPipe Pose emits exactly 33 landmarks, indexed by `PoseIdx`. */
export type PoseFrame = Landmark[];

/** The subset of MediaPipe's 33 pose landmarks this app actually uses. */
export enum PoseIdx {
  Nose = 0,
  LeftEyeInner = 1,
  LeftEye = 2,
  LeftEyeOuter = 3,
  RightEyeInner = 4,
  RightEye = 5,
  RightEyeOuter = 6,
  LeftEar = 7,
  RightEar = 8,
  LeftShoulder = 11,
  RightShoulder = 12,
  LeftHip = 23,
  RightHip = 24,
}

/**
 * Left/right landmark pairs, used to undo a mirrored camera feed.
 * Fed a mirrored image, MediaPipe labels the body's apparent left as "left",
 * so the anatomical labels come back swapped and have to be swapped back.
 */
export const MIRROR_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 4], [2, 5], [3, 6],       // eyes
  [7, 8],                        // ears
  [9, 10],                       // mouth
  [11, 12], [13, 14], [15, 16],  // shoulders, elbows, wrists
  [17, 18], [19, 20], [21, 22],  // hands
  [23, 24], [25, 26], [27, 28],  // hips, knees, ankles
  [29, 30], [31, 32],            // feet
];

/**
 * Everything about one physical setup: where the tripod stands, how the
 * camera is tilted, and where the subject's neutral is. Sessions are only
 * comparable to each other within a single profile.
 */
export interface CameraProfile {
  id: string;
  name: string;
  createdAt: number;

  /**
   * Unit vector pointing toward the earth, expressed in the PHYSICS frame.
   * `{x: 0, y: -1, z: 0}` means the camera was perfectly level.
   */
  gravityDown: Vec3;

  /** True when the video feed is mirrored (front camera preview). */
  mirrored: boolean;

  /**
   * Camera azimuth in radians, measured from the reference sit: the angle
   * the shoulder line makes with the image X axis in the UPRIGHT frame.
   */
  azimuth: number;

  /** Median shoulder width (metres) during the reference sit. */
  refShoulderWidth: number;

  /** Median hip-to-shoulder trunk length (metres) during the reference sit. */
  refTrunkLength: number;

  /** Whether gravity came from a real sensor or was assumed level. */
  gravitySource: 'sensor' | 'manual' | 'assumed-level';

  /**
   * Whether the hips were actually visible during calibration. Sitting on a
   * bench or kneeling stool usually means no, in which case the depth and
   * pelvis KPIs are hidden rather than left showing dashes forever.
   */
  hipsUsable: boolean;
}

/** The KPIs, computed per frame in the BODY frame. Angles in degrees. */
export interface PostureMetrics {
  /** KPI 1 — shoulder line vs horizontal. + = left shoulder higher. */
  shoulderTilt: number;
  /** KPI 2 — vertical gap between the shoulders, millimetres. + = left higher. */
  shoulderDropMm: number;
  /** KPI 2b — the same gap as a fraction of shoulder width, for cross-session use. */
  shoulderDropRatio: number;
  /** KPI 3 — trunk vs vertical in the frontal plane. + = leaning to the subject's left. */
  lateralLean: number;
  /**
   * KPI 4 — shoulder tilt with whole-body lean removed: the asymmetry that
   * is *not* explained by the trunk listing. This is the honest
   * "is one shoulder actually lower" number.
   */
  shoulderOnlyTilt: number;
  /** KPI 5 — trunk vs vertical in the sagittal plane. + = leaning forward. */
  sagittalLean: number;
  /** KPI 6 — shoulder line rotation about vertical. + = turning to the subject's left. */
  torsoYaw: number;
  /** KPI 7 — the same for the hip line. */
  pelvisYaw: number;
  /** KPI 8 — shoulders rotated relative to hips. A rotated cushion cancels out here. */
  torsoTwist: number;
  /**
   * KPI 9b — head roll, fused from the eye line and the ear line weighted by
   * how well each is seen. + = left side higher.
   */
  headRoll: number;
  /** Head roll from the outer eye corners alone. Short baseline, but eyes are
   *  rarely occluded and the model localises them well. */
  headRollEyes: number;
  /** Head roll from the ear line alone. Longer baseline, but hair hides ears. */
  headRollEars: number;
  /** KPI 9b relative to the shoulders — head tilted independently of the trunk. */
  headRollVsShoulders: number;
  /** KPI 10 — head rotation about vertical, relative to the shoulder line. */
  headYawVsShoulders: number;
  /** KPI 11 — nose sideways offset from the shoulder midline, as a width fraction. */
  headLateralOffset: number;

  /** Lowest visibility among the landmarks feeding the shoulder/head KPIs. */
  upperQuality: number;
  /** Lowest visibility among the hip landmarks, which cross-legged sitting often hides. */
  hipQuality: number;
  /** False when hip quality is too low to trust forward lean or pelvis yaw. */
  hipsReliable: boolean;
  /**
   * Where the trunk axis came from. The silhouette is preferred: it fits a
   * centre line through thousands of pixels in the well-observed image plane,
   * where the hip landmarks are two guessed points that a bench or kneeling
   * stool hides completely.
   */
  leanSource: 'silhouette' | 'hips' | 'none';
}

/**
 * Metrics that need a trunk axis, from either source. Gated on `leanSource`.
 */
export const LEAN_DEPENDENT_METRICS = ['lateralLean', 'shoulderOnlyTilt'] as const;

/**
 * Metrics that need the hip landmarks specifically, because they measure
 * depth or pelvis rotation that no frontal silhouette can show. Unavailable
 * on a bench or kneeling stool, and reported as such rather than guessed.
 */
export const HIP_ONLY_METRICS = ['sagittalLean', 'pelvisYaw', 'torsoTwist'] as const;

/** Every metric key, in display order. */
export const METRIC_KEYS = [
  'shoulderTilt',
  'shoulderDropMm',
  'shoulderDropRatio',
  'lateralLean',
  'shoulderOnlyTilt',
  'sagittalLean',
  'torsoYaw',
  'pelvisYaw',
  'torsoTwist',
  'headRoll',
  'headRollEyes',
  'headRollEars',
  'headRollVsShoulders',
  'headYawVsShoulders',
  'headLateralOffset',
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

/** One recorded instant: the metrics plus when they happened. */
export interface Sample {
  /** Milliseconds since session start. */
  t: number;
  metrics: PostureMetrics;
}
