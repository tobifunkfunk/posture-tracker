/**
 * Trends across sessions. The point of the whole app: one sit tells you
 * almost nothing, twenty tell you what your body actually does.
 */
import { el, clear, fmtDate, fmtDuration, fmtPercent, fmtSigned } from '../dom';
import { NOISE_FLOOR_DEG, summarize } from '../../posture/aggregate';
import { METRIC_META } from '../../posture/metrics';
import { getSession, listProfiles, listSessions, type SessionRecord } from '../../store/db';
import type { CameraProfile, MetricKey } from '../../posture/types';
import { sparkline } from '../charts/line';
import { navigate } from '../../router';

const TRENDED: MetricKey[] = ['shoulderOnlyTilt', 'lateralLean', 'torsoYaw', 'headRollVsShoulders'];

export function historyScreen(root: HTMLElement): () => void {
  let disposed = false;

  void (async () => {
    const [records, profiles] = await Promise.all([listSessions(), listProfiles()]);
    if (disposed) return;

    clear(root);
    root.append(el('h1', {}, 'History'));

    if (!records.length) {
      root.append(el('p', { class: 'muted' }, 'No sessions yet.'));
      return;
    }

    // Only sessions from one setup can be compared, so trends are computed
    // within the most-used profile rather than across everything.
    const byProfile = new Map<string, SessionRecord[]>();
    for (const r of records) {
      if (!byProfile.has(r.profileId)) byProfile.set(r.profileId, []);
      byProfile.get(r.profileId)!.push(r);
    }
    const [mainProfileId, mainSessions] = [...byProfile.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    const mainProfile = profiles.find((p) => p.id === mainProfileId);

    root.append(el('p', { class: 'sub' },
      `${records.length} session${records.length === 1 ? '' : 's'}${byProfile.size > 1 ? ` across ${byProfile.size} camera setups` : ''}.`));

    if (byProfile.size > 1) {
      root.append(el('div', { class: 'notice' },
        `Trends below cover only "${mainProfile?.name ?? 'your main setup'}" (${mainSessions.length} sessions). Angles from a different camera position are not comparable.`));
    }

    root.append(await trendSection(mainSessions, mainProfile));
    root.append(el('h2', {}, 'All sessions'));
    const list = el('div', { class: 'card' });
    for (const r of records) list.append(sessionRow(r));
    root.append(list);
  })();

  return () => { disposed = true; };
}

async function trendSection(records: SessionRecord[], profile: CameraProfile | undefined): Promise<HTMLElement> {
  const wrap = el('div');
  // Oldest first, and capped so a long history stays quick to open.
  const chronological = [...records].sort((a, b) => a.startedAt - b.startedAt).slice(-30);

  const loaded = await Promise.all(chronological.map((r) => getSession(r.id)));
  const perSession = loaded
    .filter((d): d is NonNullable<typeof d> => d !== null && d.samples.length > 20)
    .map((d) => ({ record: d.record, summary: summarize(d.samples) }));

  if (perSession.length < 2) {
    wrap.append(el('h2', {}, 'Trends'),
      el('div', { class: 'card muted small' }, 'Two or more sessions of a minute or more are needed before trends mean anything.'));
    return wrap;
  }

  wrap.append(el('h2', {}, `Trends over ${perSession.length} sessions`));

  for (const key of TRENDED) {
    const meta = METRIC_META[key];
    const values = perSession.map((s) => s.summary[key].mean);
    const finite = values.filter(Number.isFinite);
    if (finite.length < 2) continue;

    const overall = finite.reduce((a, b) => a + b, 0) / finite.length;
    const tol = perSession[0].summary[key].tolerance;

    wrap.append(el('div', { class: 'card' },
      el('div', { class: 'row spread' },
        el('h3', { style: 'margin:0' }, meta.label),
        el('span', { class: 'small muted' }, `average ${fmtSigned(overall, meta.unit)}`)),
      sparkline(values, tol),
      el('div', { class: 'small muted' }, lateralitySentence(key, finite, overall))));
  }

  // The averaged drift curve: whether collapse is a habit or a one-off.
  const drifts = perSession.map((s) => s.summary.shoulderOnlyTilt.driftPer10Min).filter(Number.isFinite);
  if (drifts.length >= 3) {
    const meanDrift = drifts.reduce((a, b) => a + b, 0) / drifts.length;
    wrap.append(el('div', { class: 'card' },
      el('h3', {}, 'Collapse over a sit'),
      el('p', { class: 'small', style: 'margin:0' },
        Math.abs(meanDrift) < 0.3
          ? 'Your posture holds steady through a sit — no consistent drift.'
          : `On average your shoulder asymmetry moves ${fmtSigned(meanDrift, '°')} per 10 minutes, ${meanDrift > 0 ? 'toward the left side rising' : 'toward the right side rising'}. Over a 30-minute sit that is about ${fmtSigned(meanDrift * 3, '°')}.`)));
  }

  if (profile?.gravitySource !== 'sensor') {
    wrap.append(el('div', { class: 'notice' },
      'This setup was calibrated without a tilt sensor. The shape of these trends is meaningful; their absolute offset includes the tripod’s own lean.'));
  }

  return wrap;
}

/** Say the thing the sparkline is showing, in words, on the correct side. */
function lateralitySentence(key: MetricKey, values: number[], overall: number): string {
  const meta = METRIC_META[key];
  if (Math.abs(overall) < NOISE_FLOOR_DEG) return 'Centred, with no consistent side.';

  // The direction has to follow the sign of the average, not default to the
  // metric's positive label — a -2.4 degree mean is the negative side.
  const direction = overall > 0 ? meta.positive : meta.negative;
  const sideCount = values.filter((v) => Math.sign(v) === Math.sign(overall)).length;
  const consistent = sideCount === values.length;

  return `${direction.replace(/^./, (c) => c.toUpperCase())} in ${sideCount} of ${values.length} sessions${consistent ? ' — consistently.' : '.'}`;
}

function sessionRow(r: SessionRecord): HTMLElement {
  return el('div', { class: 'session-row', onclick: () => navigate(`#/report/${r.id}`) },
    el('div', {},
      el('div', {}, fmtDate(r.startedAt)),
      el('div', { class: 'small muted' },
        `${fmtDuration(r.durationMs)} · ${r.mode} · body seen ${fmtPercent(r.quality)}`)),
    el('div', { class: 'row', style: 'gap:6px' },
      r.tripodMoved ? el('span', { class: 'badge bad' }, 'camera moved') : null,
      r.setupChanged ? el('span', { class: 'badge warn' }, 'new angle') : null,
      r.hipQuality < 0.5 ? el('span', { class: 'badge warn' }, 'hips hidden') : null,
      el('span', { class: 'muted' }, '›')));
}
