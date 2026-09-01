/**
 * Live overlay.
 *
 * The body outline is the friendly part — you recognise your own silhouette
 * instantly, where a stick figure has to be decoded. Drawn on top of it are
 * only the lines the KPIs actually measure: the shoulder line against true
 * horizontal, and the trunk axis against true vertical. Everything else the
 * pose model knows is left out, because showing ankles would imply the app
 * cares about them.
 */
import { PoseIdx, type PoseFrame } from '../posture/types';
import type { Polyline } from '../posture/contour';

export type OverlayStyle = 'outline' | 'skeleton' | 'both';

const SKELETON_BONES: Array<[number, number]> = [
  [PoseIdx.LeftShoulder, PoseIdx.RightShoulder],
  [PoseIdx.LeftHip, PoseIdx.RightHip],
  [PoseIdx.LeftShoulder, PoseIdx.LeftHip],
  [PoseIdx.RightShoulder, PoseIdx.RightHip],
  [PoseIdx.LeftEar, PoseIdx.RightEar],
];

const SKELETON_POINTS = [
  PoseIdx.Nose, PoseIdx.LeftEar, PoseIdx.RightEar,
  PoseIdx.LeftShoulder, PoseIdx.RightShoulder,
  PoseIdx.LeftHip, PoseIdx.RightHip,
];

export interface OverlayInput {
  frame: PoseFrame | null;
  contours: Polyline[] | null;
  style: OverlayStyle;
  /** Draw the shoulder line and trunk axis against their true references. */
  showGuides?: boolean;
}

export function drawOverlay(canvas: HTMLCanvasElement, input: OverlayInput): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);

  const { frame, contours, style, showGuides = true } = input;

  if ((style === 'outline' || style === 'both') && contours?.length) {
    drawContours(ctx, contours, w, h);
  }
  if ((style === 'skeleton' || style === 'both') && frame) {
    drawSkeletonLayer(ctx, frame, w, h);
  }
  if (showGuides && frame) {
    drawGuides(ctx, frame, w, h);
  }
}

/**
 * The silhouette: a soft fill so it reads as a body, and a brighter stroke so
 * the edge stays legible against a dim room.
 */
function drawContours(ctx: CanvasRenderingContext2D, contours: Polyline[], w: number, h: number): void {
  const path = new Path2D();
  for (const line of contours) {
    if (line.length < 2) continue;
    path.moveTo(line[0].x * w, line[0].y * h);
    for (let i = 1; i < line.length; i++) path.lineTo(line[i].x * w, line[i].y * h);
    path.closePath();
  }

  ctx.fillStyle = 'rgba(201, 162, 39, 0.10)';
  ctx.fill(path);

  ctx.strokeStyle = 'rgba(201, 162, 39, 0.85)';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // A soft glow keeps the outline readable over a busy background.
  ctx.shadowColor = 'rgba(201, 162, 39, 0.5)';
  ctx.shadowBlur = 8;
  ctx.stroke(path);
  ctx.shadowBlur = 0;
}

function drawSkeletonLayer(ctx: CanvasRenderingContext2D, frame: PoseFrame, w: number, h: number): void {
  const at = (i: number) => {
    const p = frame[i];
    return p ? { x: p.x * w, y: p.y * h, v: p.visibility } : null;
  };

  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (const [a, b] of SKELETON_BONES) {
    const pa = at(a);
    const pb = at(b);
    if (!pa || !pb) continue;
    // Fade a bone as confidence falls, so the overlay shows uncertainty
    // rather than hiding it behind a crisp line.
    const conf = Math.min(pa.v, pb.v);
    ctx.strokeStyle = `rgba(232, 226, 218, ${(0.2 + conf * 0.6).toFixed(2)})`;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  for (const i of SKELETON_POINTS) {
    const p = at(i);
    if (!p) continue;
    ctx.fillStyle = p.v > 0.5 ? 'rgba(232, 226, 218, 0.9)' : 'rgba(181, 92, 78, 0.9)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * The two references the eye needs: a true horizontal through the shoulder
 * midpoint, and a true vertical through the hips. Without something to judge
 * against, a 3 degree shoulder drop is invisible.
 */
function drawGuides(ctx: CanvasRenderingContext2D, frame: PoseFrame, w: number, h: number): void {
  const ls = frame[PoseIdx.LeftShoulder];
  const rs = frame[PoseIdx.RightShoulder];
  const lh = frame[PoseIdx.LeftHip];
  const rh = frame[PoseIdx.RightHip];

  if (ls && rs && Math.min(ls.visibility, rs.visibility) > 0.5) {
    const mx = ((ls.x + rs.x) / 2) * w;
    const my = ((ls.y + rs.y) / 2) * h;

    ctx.strokeStyle = 'rgba(154, 144, 138, 0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 6]);
    ctx.beginPath();
    ctx.moveTo(0, my);
    ctx.lineTo(w, my);
    ctx.stroke();
    ctx.setLineDash([]);

    // The actual shoulder line, so the gap against horizontal is the message.
    ctx.strokeStyle = 'rgba(232, 226, 218, 0.9)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(ls.x * w, ls.y * h);
    ctx.lineTo(rs.x * w, rs.y * h);
    ctx.stroke();

    if (lh && rh && Math.min(lh.visibility, rh.visibility) > 0.5) {
      const hx = ((lh.x + rh.x) / 2) * w;
      const hy = ((lh.y + rh.y) / 2) * h;

      ctx.strokeStyle = 'rgba(154, 144, 138, 0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 6]);
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(hx, my - (hy - my) * 0.1);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.strokeStyle = 'rgba(232, 226, 218, 0.9)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(mx, my);
      ctx.stroke();
    }
  }
}
