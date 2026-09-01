import type { Vec3 } from './types';

export const vec = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const add = (a: Vec3, b: Vec3): Vec3 => vec(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => vec(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, k: number): Vec3 => vec(a.x * k, a.y * k, a.z * k);
export const mid = (a: Vec3, b: Vec3): Vec3 => scale(add(a, b), 0.5);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: Vec3, b: Vec3): Vec3 =>
  vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

/** Normalise, falling back to a supplied default when the vector is degenerate. */
export function normalize(a: Vec3, fallback: Vec3 = vec(0, 1, 0)): Vec3 {
  const l = len(a);
  return l < 1e-9 ? fallback : scale(a, 1 / l);
}

export const DEG = 180 / Math.PI;
export const toDeg = (rad: number): number => rad * DEG;
export const toRad = (deg: number): number => deg / DEG;

/** Row-major 3x3 matrix. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function applyMat3(m: Mat3, v: Vec3): Vec3 {
  return vec(
    m[0] * v.x + m[1] * v.y + m[2] * v.z,
    m[3] * v.x + m[4] * v.y + m[5] * v.z,
    m[6] * v.x + m[7] * v.y + m[8] * v.z,
  );
}

export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out as unknown as Mat3;
}

/** Rotation about +Y by `rad`, right-hand rule (+Z rotates toward +X). */
export function rotY(rad: number): Mat3 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

/** Rotation about +Z by `rad`, right-hand rule (+X rotates toward +Y). */
export function rotZ(rad: number): Mat3 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** Rotation about +X by `rad`, right-hand rule (+Y rotates toward +Z). */
export function rotX(rad: number): Mat3 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

/**
 * The minimal rotation carrying unit vector `from` onto unit vector `to`
 * (Rodrigues). Using the minimal rotation matters: it corrects the camera's
 * roll and pitch while leaving azimuth untouched, which is exactly the split
 * the pipeline wants — azimuth is resolved separately from the reference sit.
 */
export function rotationBetween(from: Vec3, to: Vec3): Mat3 {
  const a = normalize(from);
  const b = normalize(to);
  const v = cross(a, b);
  const c = dot(a, b);

  // Already aligned.
  if (c > 1 - 1e-9) return IDENTITY3;

  // Exactly opposed: any 180 deg rotation about a perpendicular axis will do.
  if (c < -1 + 1e-9) {
    const seed = Math.abs(a.x) < 0.9 ? vec(1, 0, 0) : vec(0, 1, 0);
    const axis = normalize(cross(a, seed));
    const { x, y, z } = axis;
    return [
      2 * x * x - 1, 2 * x * y, 2 * x * z,
      2 * x * y, 2 * y * y - 1, 2 * y * z,
      2 * x * z, 2 * y * z, 2 * z * z - 1,
    ];
  }

  const { x, y, z } = v;
  const k = 1 / (1 + c);
  return [
    1 - (y * y + z * z) * k, -z + x * y * k, y + x * z * k,
    z + x * y * k, 1 - (x * x + z * z) * k, -x + y * z * k,
    -y + x * z * k, x + y * z * k, 1 - (x * x + y * y) * k,
  ];
}

/** Circular mean of angles in degrees — the right way to average a heading. */
export function meanAngleDeg(values: number[]): number {
  if (values.length === 0) return NaN;
  let sx = 0;
  let sy = 0;
  for (const v of values) {
    sx += Math.cos(toRad(v));
    sy += Math.sin(toRad(v));
  }
  return toDeg(Math.atan2(sy / values.length, sx / values.length));
}

/** Median of a numeric list. Returns NaN for an empty list. */
export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Component-wise median of a list of vectors — robust to landmark dropouts. */
export function medianVec(values: Vec3[]): Vec3 {
  return vec(
    median(values.map((v) => v.x)),
    median(values.map((v) => v.y)),
    median(values.map((v) => v.z)),
  );
}
