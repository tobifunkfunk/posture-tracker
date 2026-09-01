/**
 * Skeleton overlay for live mode. Draws only the landmarks the KPIs actually
 * use — showing all 33 would imply the app cares about ankles it never reads.
 */
import { PoseIdx, type PoseFrame } from '../posture/types';

const BONES: Array<[number, number]> = [
  [PoseIdx.LeftShoulder, PoseIdx.RightShoulder],
  [PoseIdx.LeftHip, PoseIdx.RightHip],
  [PoseIdx.LeftShoulder, PoseIdx.LeftHip],
  [PoseIdx.RightShoulder, PoseIdx.RightHip],
  [PoseIdx.LeftEar, PoseIdx.RightEar],
];

const POINTS = [
  PoseIdx.Nose, PoseIdx.LeftEar, PoseIdx.RightEar,
  PoseIdx.LeftShoulder, PoseIdx.RightShoulder,
  PoseIdx.LeftHip, PoseIdx.RightHip,
];

export function drawSkeleton(canvas: HTMLCanvasElement, frame: PoseFrame | null): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  if (!frame) return;

  const at = (i: number) => {
    const p = frame[i];
    return p ? { x: p.x * w, y: p.y * h, v: p.visibility } : null;
  };

  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (const [a, b] of BONES) {
    const pa = at(a);
    const pb = at(b);
    if (!pa || !pb) continue;
    // Fade a bone out as the model's confidence in it falls, so the overlay
    // shows uncertainty rather than hiding it behind a crisp line.
    const conf = Math.min(pa.v, pb.v);
    ctx.strokeStyle = `rgba(201, 162, 39, ${(0.25 + conf * 0.65).toFixed(2)})`;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  for (const i of POINTS) {
    const p = at(i);
    if (!p) continue;
    ctx.fillStyle = p.v > 0.5 ? 'rgba(232, 226, 218, 0.9)' : 'rgba(181, 92, 78, 0.9)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // True horizontal through the shoulder midpoint: the reference the eye
  // needs to judge the shoulder line against.
  const ls = at(PoseIdx.LeftShoulder);
  const rs = at(PoseIdx.RightShoulder);
  if (ls && rs) {
    const my = (ls.y + rs.y) / 2;
    ctx.strokeStyle = 'rgba(154, 144, 138, 0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 6]);
    ctx.beginPath();
    ctx.moveTo(0, my);
    ctx.lineTo(w, my);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
