import { describe, expect, it } from 'vitest';
import { SessionRecorder } from '../src/posture/recorder';
import { makeBody, profileFor, project } from './synthetic';
import type { TrunkAxis } from '../src/posture/silhouette';

const axis = (leanImageDeg: number, over: Partial<TrunkAxis> = {}): TrunkAxis => ({
  leanImageDeg,
  coverage: 0.95,
  residual: 0.01,
  rows: 50,
  ...over,
});

describe('SessionRecorder silhouette lean', () => {
  it('maps image-right lean to the subject leaning left', () => {
    // Unmirrored, the subject's left is on the image right, so a trunk whose
    // top sits image-right is a body leaning to its own left.
    const r = new SessionRecorder(profileFor({ mirrored: false }));
    r.begin(0);
    const live = r.push(project(makeBody({})), 100, axis(5))!;
    expect(live.metrics.leanSource).toBe('silhouette');
    expect(live.metrics.lateralLean).toBeCloseTo(5, 4);
  });

  it('flips the sense for a mirrored feed', () => {
    const r = new SessionRecorder(profileFor({ mirrored: true }));
    r.begin(0);
    const live = r.push(project(makeBody({}), { mirrored: true }), 100, axis(5))!;
    expect(live.metrics.lateralLean).toBeCloseTo(-5, 4);
  });

  it('discards a fit spoiled by an arm swung out', () => {
    const r = new SessionRecorder(profileFor());
    r.begin(0);
    // A large residual means the centre line did not describe a trunk.
    const live = r.push(project(makeBody({})), 100, axis(5, { residual: 0.2 }))!;
    expect(live.metrics.leanSource).toBe('hips');
  });

  it('discards a fit covering too little of the chest', () => {
    const r = new SessionRecorder(profileFor());
    r.begin(0);
    const live = r.push(project(makeBody({})), 100, axis(5, { coverage: 0.2 }))!;
    expect(live.metrics.leanSource).toBe('hips');
  });

  it('falls back to the hips when no silhouette is supplied', () => {
    const r = new SessionRecorder(profileFor());
    r.begin(0);
    const live = r.push(project(makeBody({ lateralLean: 3 })), 100, null)!;
    expect(live.metrics.leanSource).toBe('hips');
    expect(live.metrics.lateralLean).toBeCloseTo(3, 3);
  });

  it('records with the hips fully hidden, as on a bench', () => {
    const body = makeBody({ shoulderExtraTilt: 4 });
    for (const i of [23, 24]) body[i].visibility = 0.05;
    const r = new SessionRecorder(profileFor());
    r.begin(0);

    let live = r.push(project(body), 100, axis(0))!;
    expect(live.metrics.hipsReliable).toBe(false);
    expect(live.metrics.shoulderOnlyTilt).toBeCloseTo(4, 3);

    // Push past a second so a bucket closes and gets stored.
    for (let t = 200; t <= 1400; t += 200) live = r.push(project(body), t, axis(0))!;
    const result = r.end(1500);
    expect(result.samples.length).toBeGreaterThan(0);
    expect(result.samples[0].metrics.leanSource).toBe('silhouette');
  });
});
