/**
 * Post-session report. Ordered so the two questions worth asking come first:
 * what is my habitual bias, and did it get worse as I sat?
 */
import { el, clear, fmtDate, fmtDuration, fmtPercent, fmtSigned } from '../dom';
import { correlate, summarize, sessionQuality, NOISE_FLOOR_DEG, type MetricSummary } from '../../posture/aggregate';
import { METRIC_META } from '../../posture/metrics';
import { getSession, deleteSession, getProfile, type SessionRecord } from '../../store/db';
import type { MetricKey, Sample } from '../../posture/types';
import { lineChart, scatterChart } from '../charts/line';
import { navigate } from '../../router';

/** The metrics worth leading with; the rest live under "everything else". */
const HEADLINE: MetricKey[] = ['shoulderOnlyTilt', 'shoulderDropMm', 'lateralLean', 'torsoYaw', 'headRollVsShoulders'];
const SECONDARY: MetricKey[] = ['shoulderTilt', 'headRollEyes', 'headRollEars', 'headLateralOffset', 'shoulderDropRatio'];
/** Only meaningful when the hips are visible, which a bench or stool prevents. */
const HIP_ONLY: MetricKey[] = ['sagittalLean', 'pelvisYaw', 'torsoTwist'];

export function reportScreen(root: HTMLElement, id: string): () => void {
  let disposed = false;

  void (async () => {
    const data = await getSession(id);
    if (disposed) return;
    if (!data) {
      root.append(el('h1', {}, 'Report'), el('p', { class: 'muted' }, 'That session no longer exists.'));
      return;
    }
    const profile = await getProfile(data.record.profileId);
    if (disposed) return;
    clear(root);
    root.append(...renderReport(
      data.record, data.samples,
      profile?.gravitySource ?? 'assumed-level',
      profile?.hipsUsable ?? false,
    ));
  })();

  return () => { disposed = true; };
}

export function renderReport(
  record: SessionRecord,
  samples: Sample[],
  gravitySource: string,
  hipsUsable: boolean,
): HTMLElement[] {
  const summary = summarize(samples);
  const quality = sessionQuality(samples);

  const nodes: HTMLElement[] = [
    el('h1', {}, 'Session report'),
    el('p', { class: 'sub' },
      `${fmtDate(record.startedAt)} · ${fmtDuration(record.durationMs)} · ${record.mode === 'blind' ? 'blind' : 'live feedback'}`),
  ];

  /* Anything that makes the numbers less trustworthy goes at the very top,
   * before the reader has a chance to believe them. */
  if (record.tripodMoved) {
    nodes.push(el('div', { class: 'notice bad' },
      `The camera moved about ${record.tripodDriftDeg?.toFixed(1)}° during this session. Its angles are not comparable with your others.`));
  }
  if (gravitySource !== 'sensor') {
    nodes.push(el('div', { class: 'notice' },
      'This setup was calibrated without a tilt sensor, so any lean in the tripod is baked into these angles. Compare within this setup, not across setups.'));
  }
  if (quality.lean < 0.7) {
    nodes.push(el('div', { class: 'notice' },
      `A trunk axis could only be measured for ${fmtPercent(quality.lean)} of this sit, so the lean and asymmetry figures rest on that slice. Usually this means the chest was partly out of frame.`));
  }
  if (samples.length < 30) {
    nodes.push(el('div', { class: 'notice bad' }, 'Too short to say much. Under a minute of clean data.'));
  }

  nodes.push(el('h2', {}, 'What your posture did'));
  const headline = el('div', { class: 'card' });
  for (const key of HEADLINE) headline.append(metricRow(summary[key]));
  nodes.push(headline);

  /* Drift is the single most useful number here: it separates "I sit
   * crooked" from "I start straight and collapse". */
  nodes.push(el('h2', {}, 'Did it drift?'));
  const drift = el('div', { class: 'card' });
  for (const key of ['shoulderOnlyTilt', 'lateralLean', 'sagittalLean'] as MetricKey[]) {
    const s = summary[key];
    const meta = METRIC_META[key];
    const worse = Math.abs(s.endMean) > Math.abs(s.startMean) + 0.5;
    drift.append(
      el('div', { class: 'kpi' },
        el('div', {},
          el('div', { class: 'label' }, meta.label),
          el('div', { class: 'hint' },
            Number.isFinite(s.startEndDelta)
              ? `first 3 min ${fmtSigned(s.startMean, meta.unit)} → last 3 min ${fmtSigned(s.endMean, meta.unit)}`
              : 'not enough data')),
        el('span', { class: `value ${worse ? 'warn' : 'good'}` },
          Number.isFinite(s.driftPer10Min) ? `${fmtSigned(s.driftPer10Min, meta.unit)}/10min` : '—')),
    );
  }
  nodes.push(drift);

  /* The timeline for the metric that actually moved most. */
  const mostActive = [...HEADLINE]
    .filter((k) => METRIC_META[k].unit === '°' && summary[k].n > 10)
    .sort((a, b) => (summary[b].sd || 0) - (summary[a].sd || 0))[0];
  if (mostActive && summary[mostActive].n > 10) {
    nodes.push(el('h2', {}, `Over the session — ${METRIC_META[mostActive].label.toLowerCase()}`));
    nodes.push(el('div', { class: 'card' },
      lineChart(
        samples
          .filter((s) => Number.isFinite(s.metrics[mostActive] as number))
          .map((s) => ({ x: s.t, y: s.metrics[mostActive] as number })),
        { band: summary[mostActive].tolerance, showTrend: true },
      ),
      el('div', { class: 'small muted', style: 'margin-top:6px' },
        'Green band is your tolerance. The dashed line is the trend across the sit.')));
  }

  /* The correlation view: the direct answer to "these are all related". */
  const rTiltLean = correlate(samples, 'shoulderTilt', 'lateralLean');
  nodes.push(el('h2', {}, 'How the three are linked'));
  nodes.push(el('div', { class: 'card' },
    scatterChart(
      samples.map((s) => [s.metrics.shoulderTilt, s.metrics.lateralLean] as [number, number]),
      rTiltLean.r,
      ['shoulder tilt °', 'lateral lean °'],
    ),
    el('div', { class: 'small muted', style: 'margin-top:8px' }, explainCorrelation(rTiltLean.r, summary))));

  nodes.push(el('h2', {}, 'Everything else'));
  const rest = el('div', { class: 'card' });
  for (const key of SECONDARY) rest.append(metricRow(summary[key]));
  nodes.push(rest);

  /*
   * Depth and pelvis rotation need the hip landmarks. On a bench or kneeling
   * stool they are simply not visible, so the section is omitted with a note
   * rather than shown as a column of dashes.
   */
  if (hipsUsable) {
    nodes.push(el('h2', {}, 'Depth and pelvis'));
    const hips = el('div', { class: 'card' });
    for (const key of HIP_ONLY) hips.append(metricRow(summary[key]));
    nodes.push(hips);
  } else {
    nodes.push(el('h2', {}, 'Depth and pelvis'));
    nodes.push(el('div', { class: 'card muted small' },
      'Not measured. Forward lean and pelvis twist need the hip landmarks, which are not visible in this setup — normal on a bench or kneeling stool. '
      + 'Everything above is measured from the shoulders and the body outline and is unaffected.'));
  }

  nodes.push(el('h2', {}, 'Data quality'));
  nodes.push(el('div', { class: 'card' },
    el('div', { class: 'kpi' }, el('span', { class: 'label' }, 'Body detected'), el('span', { class: 'value' }, fmtPercent(quality.upper))),
    el('div', { class: 'kpi' }, el('span', { class: 'label' }, 'Trunk axis found'), el('span', { class: 'value' }, fmtPercent(quality.lean))),
    el('div', { class: 'kpi' }, el('span', { class: 'label' }, 'Samples stored'), el('span', { class: 'value' }, String(samples.length))),
  ));

  nodes.push(el('div', { class: 'row', style: 'margin-top:20px;gap:8px' },
    el('button', { class: 'ghost', style: 'flex:1', onclick: () => exportSession(record, samples) }, 'Export CSV'),
    el('button', {
      class: 'ghost danger', style: 'flex:1',
      onclick: async () => {
        if (!confirm('Delete this session permanently?')) return;
        await deleteSession(record.id);
        navigate('#/history');
      },
    }, 'Delete')));

  return nodes;
}

function metricRow(s: MetricSummary): HTMLElement {
  const meta = METRIC_META[s.key];
  const digits = meta.unit === 'mm' ? 0 : meta.unit === '' || meta.unit === '×width' ? 3 : 1;

  if (!s.n) {
    return el('div', { class: 'kpi' },
      el('div', {}, el('div', { class: 'label' }, meta.label)),
      el('span', { class: 'value muted' }, '—'));
  }

  const within = Math.abs(s.mean) <= s.tolerance;
  const negligible = meta.unit === '°' && Math.abs(s.mean) < NOISE_FLOOR_DEG;
  const cls = negligible || within ? 'good' : Math.abs(s.mean) > s.tolerance * 2 ? 'bad' : 'warn';

  return el('div', { class: 'kpi' },
    el('div', {},
      el('div', { class: 'label' }, meta.label),
      el('div', { class: 'hint' },
        negligible
          ? 'within measurement noise'
          : `${s.mean > 0 ? meta.positive : meta.negative} · steady to ±${s.sd.toFixed(digits)}${meta.unit} · in range ${fmtPercent(s.timeInTolerance)}`),
      s.lowConfidence ? el('span', { class: 'badge warn' }, 'few usable frames') : null),
    el('span', { class: `value ${cls}` }, fmtSigned(s.mean, meta.unit, digits)));
}

/**
 * Turn the correlation into the sentence the number is actually for: whether
 * a dropped shoulder is its own problem or a symptom of the trunk listing.
 */
function explainCorrelation(r: number, summary: Record<MetricKey, MetricSummary>): string {
  if (!Number.isFinite(r)) return 'Not enough paired data to compare them.';

  const asym = Math.abs(summary.shoulderOnlyTilt.mean);
  const lean = Math.abs(summary.lateralLean.mean);
  const asymReal = asym >= NOISE_FLOOR_DEG;
  const leanReal = lean >= NOISE_FLOOR_DEG;
  const linked = Math.abs(r) > 0.6;
  const side = summary.shoulderOnlyTilt.mean > 0 ? 'left' : 'right';

  if (!asymReal && !leanReal) {
    return `Neither the lean (${lean.toFixed(1)}°) nor the asymmetry (${asym.toFixed(1)}°) is big enough to read much into. Your shoulders sit level.`;
  }
  if (!asymReal && leanReal) {
    return `Strongly linked (r = ${r.toFixed(2)}), and your shoulder asymmetry is inside the noise floor once lean is removed. Your shoulders are just following a ${lean.toFixed(1)}° trunk lean — work on the lean, not the shoulders.`;
  }
  if (asymReal && !leanReal) {
    return `Your trunk is upright (${lean.toFixed(1)}° lean) but your ${side} shoulder still sits ${asym.toFixed(1)}° low. That is a shoulder-girdle pattern in its own right, not a listing spine — the correlation of ${r.toFixed(2)} here mostly reflects the two moving together moment to moment, not a shared cause.`;
  }
  // Both are real: say which dominates rather than reporting two numbers.
  const dominant = asym > lean ? 'the shoulder asymmetry' : 'the trunk lean';
  return `You have both: a ${lean.toFixed(1)}° trunk lean and ${asym.toFixed(1)}° of ${side}-shoulder drop on top of it${linked ? `, and they track each other closely (r = ${r.toFixed(2)})` : ` (only loosely linked, r = ${r.toFixed(2)})`}. ${dominant.charAt(0).toUpperCase() + dominant.slice(1)} is the larger of the two.`;
}

/** CSV of the per-second series — everything the app knows, nothing hidden. */
function exportSession(record: SessionRecord, samples: Sample[]): void {
  const keys = Object.keys(METRIC_META);
  const header = ['t_ms', ...keys, 'hips_reliable', 'upper_quality'].join(',');
  const rows = samples.map((s) =>
    [
      s.t,
      ...keys.map((k) => {
        const v = s.metrics[k as MetricKey];
        return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(3) : '';
      }),
      s.metrics.hipsReliable ? 1 : 0,
      s.metrics.upperQuality.toFixed(2),
    ].join(','));

  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `posture-${new Date(record.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
