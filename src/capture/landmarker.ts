/**
 * MediaPipe wrapper. Inference runs on a fixed low-rate timer rather than
 * every animation frame: meditation is near-static, and at 5Hz a 45 minute
 * session stays well clear of thermal throttling on a phone.
 */
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark, PoseFrame } from '../posture/types';
import { extractContours, type Polyline } from '../posture/contour';

const WASM_PATH = `${import.meta.env.BASE_URL}wasm`;
const POSE_MODEL = `${import.meta.env.BASE_URL}models/pose_landmarker_lite.task`;

export interface LandmarkerOptions {
  /** Inference rate in Hz. 5 is plenty for posture and kind to the battery. */
  sampleHz?: number;
  /** GPU is much faster; CPU is the fallback when WebGL is unavailable. */
  delegate?: 'GPU' | 'CPU';
  /**
   * Produce a body outline from the segmentation mask. Costs noticeably more
   * per frame, so it is only worth enabling when something is actually drawn:
   * calibration framing and live mode, never a blind sit.
   */
  withSegmentation?: boolean;
}

export interface CaptureResult {
  /** RAW MediaPipe world landmarks, in metres, hips at the origin. */
  world: PoseFrame;
  /** Normalised image-space landmarks, used only for drawing the overlay. */
  screen: PoseFrame;
  /**
   * Body outline in normalised image coordinates, when segmentation is on.
   * Already extracted from the mask, because an MPMask must not outlive the
   * callback that produced it.
   */
  contours: Polyline[] | null;
  /** Wall-clock milliseconds spent inside `detectForVideo`. */
  inferenceMs: number;
  timestamp: number;
}

function toFrame(points: Array<{ x: number; y: number; z: number; visibility?: number }>): PoseFrame {
  return points.map(
    (p): Landmark => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? 1 }),
  );
}

export class PostureLandmarker {
  private pose: PoseLandmarker | null = null;
  private timer: number | null = null;
  private lastVideoTime = -1;
  private running = false;

  constructor(private opts: LandmarkerOptions = {}) {}

  /**
   * Rebuild with different options. `outputSegmentationMasks` is fixed at
   * creation, so switching it off for a blind sit means a new instance —
   * a one-off cost at the start that pays back over forty minutes of frames.
   */
  async reconfigure(
    opts: Partial<LandmarkerOptions>,
    video: HTMLVideoElement,
    onResult: (r: CaptureResult) => void,
  ): Promise<void> {
    this.stop();
    this.pose?.close();
    this.pose = null;
    this.lastVideoTime = -1;
    this.opts = { ...this.opts, ...opts };
    await this.load();
    this.start(video, onResult);
  }

  async load(): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    const delegate = this.opts.delegate ?? 'GPU';

    this.pose = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      outputSegmentationMasks: this.opts.withSegmentation ?? false,
      // Nudged above the defaults: a meditator is stationary and well framed,
      // so weak detections are far more likely to be noise than a real body.
      minPoseDetectionConfidence: 0.6,
      minPosePresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
    });
  }

  /** Begin sampling. `onResult` fires at roughly `sampleHz`. */
  start(video: HTMLVideoElement, onResult: (r: CaptureResult) => void): void {
    if (!this.pose) throw new Error('Call load() before start().');
    this.running = true;
    const intervalMs = 1000 / (this.opts.sampleHz ?? 5);

    const tick = () => {
      if (!this.running) return;
      const now = performance.now();

      // MediaPipe rejects a repeated timestamp, so skip until a new frame lands.
      if (video.currentTime !== this.lastVideoTime && video.readyState >= 2) {
        this.lastVideoTime = video.currentTime;
        const t0 = performance.now();
        try {
          const poseResult = this.pose!.detectForVideo(video, now);
          const world = poseResult.worldLandmarks?.[0];
          const screen = poseResult.landmarks?.[0];

          /*
           * Masks hold GPU/CPU buffers that MediaPipe expects back before the
           * next frame. Trace the outline here and close the mask in a finally,
           * or a 45 minute session leaks one buffer every 200ms.
           */
          let contours: Polyline[] | null = null;
          const mask = poseResult.segmentationMasks?.[0];
          if (mask) {
            try {
              contours = extractContours(
                mask.getAsFloat32Array(),
                mask.width,
                mask.height,
                { threshold: 0.5, step: 2, minPoints: 24, smoothIterations: 2 },
              );
            } finally {
              mask.close();
            }
          }

          if (world && screen) {
            onResult({
              world: toFrame(world),
              screen: toFrame(screen),
              contours,
              inferenceMs: performance.now() - t0,
              timestamp: now,
            });
          }
        } catch (err) {
          // A dropped frame is not worth tearing the session down for.
          console.warn('inference failed', err);
        }
      }

      this.timer = window.setTimeout(tick, intervalMs);
    };

    tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  close(): void {
    this.stop();
    this.pose?.close();
    this.pose = null;
  }
}

/** Rolling performance counters, surfaced during the phase-0 thermal check. */
export class PerfMeter {
  private readonly times: number[] = [];
  private readonly stamps: number[] = [];

  record(inferenceMs: number, at: number): void {
    this.times.push(inferenceMs);
    this.stamps.push(at);
    if (this.times.length > 60) {
      this.times.shift();
      this.stamps.shift();
    }
  }

  get meanInferenceMs(): number {
    if (!this.times.length) return NaN;
    return this.times.reduce((a, b) => a + b, 0) / this.times.length;
  }

  get effectiveHz(): number {
    if (this.stamps.length < 2) return NaN;
    const span = this.stamps[this.stamps.length - 1] - this.stamps[0];
    return span > 0 ? ((this.stamps.length - 1) / span) * 1000 : NaN;
  }
}
