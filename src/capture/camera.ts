/**
 * Camera plumbing. Kept deliberately thin: frames go straight from the video
 * element into MediaPipe and are never copied, stored or uploaded.
 */

export interface CameraOptions {
  facingMode?: 'user' | 'environment';
  width?: number;
  height?: number;
}

export class CameraError extends Error {
  constructor(message: string, readonly kind: 'denied' | 'unavailable' | 'insecure' | 'unknown') {
    super(message);
    this.name = 'CameraError';
  }
}

/** A secure context is required for getUserMedia; plain http silently has no camera. */
export function isSecureContextOk(): boolean {
  return window.isSecureContext || location.hostname === 'localhost';
}

export async function startCamera(video: HTMLVideoElement, opts: CameraOptions = {}): Promise<MediaStream> {
  if (!isSecureContextOk()) {
    throw new CameraError('The camera needs HTTPS. Open this page over https or on localhost.', 'insecure');
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('This browser exposes no camera API.', 'unavailable');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: opts.facingMode ?? 'user',
        width: { ideal: opts.width ?? 960 },
        height: { ideal: opts.height ?? 1280 },
      },
    });
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new CameraError('Camera permission was refused.', 'denied');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new CameraError('No usable camera was found.', 'unavailable');
    }
    throw new CameraError((err as Error)?.message ?? 'The camera could not be started.', 'unknown');
  }

  video.srcObject = stream;
  video.playsInline = true;
  video.muted = true;

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(
      // iOS in standalone PWA mode sometimes hands back a stream that never
      // produces frames. Time out rather than hang on a black screen forever.
      () => reject(new CameraError('The camera stream never started. Try opening this page in Safari instead of the installed app.', 'unknown')),
      8000,
    );
    video.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      video.play().then(() => resolve(), reject);
    };
  });

  return stream;
}

export function stopCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

/**
 * Whether the feed is mirrored, which decides if MediaPipe's anatomical
 * left/right labels come back swapped. Not derivable from the stream, so it
 * is settled by the "raise your right hand" check during calibration.
 */
export function guessMirrored(facingMode: 'user' | 'environment'): boolean {
  return facingMode === 'user';
}

/** Keep the screen awake for the length of a session. */
export class ScreenLock {
  private sentinel: WakeLockSentinel | null = null;
  private onVisibility: (() => void) | null = null;

  async acquire(): Promise<boolean> {
    if (!('wakeLock' in navigator)) return false;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      // The lock is dropped whenever the tab is backgrounded, so retake it.
      this.onVisibility = () => {
        if (document.visibilityState === 'visible' && this.sentinel?.released !== false) {
          void this.acquire();
        }
      };
      document.addEventListener('visibilitychange', this.onVisibility);
      return true;
    } catch {
      return false;
    }
  }

  async release(): Promise<void> {
    if (this.onVisibility) document.removeEventListener('visibilitychange', this.onVisibility);
    this.onVisibility = null;
    try {
      await this.sentinel?.release();
    } catch {
      /* releasing a already-released lock is not worth surfacing */
    }
    this.sentinel = null;
  }
}
