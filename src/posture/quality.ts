/**
 * Live measurement-quality readout.
 *
 * Whether a white sheet, a patterned shirt or a different lamp actually helps
 * is not answerable from first principles — it depends on the room, the
 * camera and the person. What is answerable is how noisy the measurements are
 * right now, which is exactly the number to optimise against. This turns
 * setup choices into an experiment the user can run themselves.
 */
import { PoseIdx, type PoseFrame } from './types';
import { toDeg } from './vec';

/** Landmarks every KPI depends on, so their visibility is the one that counts. */
const KEY_LANDMARKS = [
  PoseIdx.LeftShoulder, PoseIdx.RightShoulder,
  PoseIdx.LeftHip, PoseIdx.RightHip,
  PoseIdx.LeftEye, PoseIdx.RightEye,
];

export interface QualityReading {
  /** Mean visibility across the landmarks the KPIs need, 0..1. */
  visibility: number;
  /** Lowest visibility among them — one bad landmark spoils its KPI. */
  worstVisibility: number;
  /** Which landmark is worst, for an actionable hint. */
  worstName: string;
  /**
   * Standard deviation of the shoulder-tilt reading while holding still, in
   * degrees. This is the headline number: it is roughly the precision the
   * session will have.
   */
  jitterDeg: number;
  /** Samples behind the jitter figure. Under ~20 it means little. */
  samples: number;
  verdict: 'excellent' | 'good' | 'usable' | 'poor' | 'measuring';
}

const NAMES: Record<number, string> = {
  [PoseIdx.LeftShoulder]: 'left shoulder',
  [PoseIdx.RightShoulder]: 'right shoulder',
  [PoseIdx.LeftHip]: 'left hip',
  [PoseIdx.RightHip]: 'right hip',
  [PoseIdx.LeftEye]: 'left eye',
  [PoseIdx.RightEye]: 'right eye',
};

export class QualityMeter {
  private readonly tilts: number[] = [];
  private readonly visibilities: number[] = [];

  constructor(private readonly window = 60) {}

  /**
   * Feed a frame. Any frame will do — jitter is a spread, so it does not care
   * that the camera has not been calibrated yet.
   */
  push(frame: PoseFrame): void {
    const ls = frame[PoseIdx.LeftShoulder];
    const rs = frame[PoseIdx.RightShoulder];
    if (!ls || !rs) return;

    const tilt = toDeg(Math.atan2(ls.y - rs.y, Math.hypot(ls.x - rs.x, ls.z - rs.z)));
    if (Number.isFinite(tilt)) {
      this.tilts.push(tilt);
      if (this.tilts.length > this.window) this.tilts.shift();
    }

    const vis = KEY_LANDMARKS.map((i) => frame[i]?.visibility ?? 0);
    this.visibilities.push(vis.reduce((a, b) => a + b, 0) / vis.length);
    if (this.visibilities.length > this.window) this.visibilities.shift();
  }

  read(frame: PoseFrame | null): QualityReading {
    let worst = 1;
    let worstName = '';
    if (frame) {
      for (const i of KEY_LANDMARKS) {
        const v = frame[i]?.visibility ?? 0;
        if (v < worst) {
          worst = v;
          worstName = NAMES[i] ?? '';
        }
      }
    }

    const visibility = this.visibilities.length
      ? this.visibilities.reduce((a, b) => a + b, 0) / this.visibilities.length
      : 0;

    const jitterDeg = sd(this.tilts);
    const samples = this.tilts.length;

    return {
      visibility,
      worstVisibility: frame ? worst : 0,
      worstName,
      jitterDeg,
      samples,
      verdict: verdictFor(jitterDeg, visibility, samples),
    };
  }

  reset(): void {
    this.tilts.length = 0;
    this.visibilities.length = 0;
  }
}

/**
 * Thresholds anchored to what the KPIs need. Shoulder tilt is reported to a
 * 1 degree noise floor and flagged against a 2 degree band, so jitter much
 * above half a degree starts eating the signal.
 */
function verdictFor(jitter: number, visibility: number, samples: number): QualityReading['verdict'] {
  if (samples < 20 || !Number.isFinite(jitter)) return 'measuring';
  if (visibility < 0.5) return 'poor';
  if (jitter < 0.3 && visibility > 0.85) return 'excellent';
  if (jitter < 0.6 && visibility > 0.7) return 'good';
  if (jitter < 1.2) return 'usable';
  return 'poor';
}

function sd(values: number[]): number {
  if (values.length < 2) return NaN;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
}

/** A concrete thing to try next, based on what is actually failing. */
export function qualityAdvice(r: QualityReading): string {
  if (r.verdict === 'measuring') return 'Hold still while this settles.';
  if (r.visibility < 0.5 || r.worstVisibility < 0.4) {
    return `The ${r.worstName || 'body'} is barely being seen. Try more even light from the front, and clothing that contrasts with what is behind you.`;
  }
  if (r.jitterDeg > 1.2) {
    return 'Readings are jumping around. The usual causes are dim light, a busy background behind you, or loose clothing shifting the shoulder points.';
  }
  if (r.jitterDeg > 0.6) {
    return 'Workable, but a plainer background or brighter, more even light would tighten it up.';
  }
  return 'Good signal. Keep this setup, and note where the tripod and cushion sit.';
}
