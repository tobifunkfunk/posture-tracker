/**
 * Compact SVG time-series and trend charts.
 *
 * A session is at most a few thousand points and renders as a single <path>,
 * so this replaces the uPlot dependency the plan reached for: it draws just
 * as fast at this size, inherits the theme's CSS variables for free, and
 * keeps the offline bundle smaller.
 */
import { svg } from '../dom';

export interface SeriesPoint {
  x: number;
  y: number;
}

export interface LineChartOptions {
  width?: number;
  height?: number;
  /** Shaded band drawn around zero, e.g. the tolerance for this metric. */
  band?: number;
  /** Axis label for the y unit. */
  unit?: string;
  /** Draw the least-squares trend line through the data. */
  showTrend?: boolean;
  /** Force symmetric limits about zero, so sign is readable at a glance. */
  symmetric?: boolean;
}

function niceBounds(values: number[], band: number, symmetric: boolean): [number, number] {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return [-1, 1];
  let lo = Math.min(...finite);
  let hi = Math.max(...finite);
  if (symmetric) {
    const m = Math.max(Math.abs(lo), Math.abs(hi), band * 1.4);
    lo = -m;
    hi = m;
  }
  const pad = (hi - lo) * 0.12 || 1;
  return [lo - pad, hi + pad];
}

export function lineChart(points: SeriesPoint[], opts: LineChartOptions = {}): SVGElement {
  const w = opts.width ?? 320;
  const h = opts.height ?? 130;
  const padL = 34;
  const padR = 8;
  const padT = 8;
  const padB = 18;
  const band = opts.band ?? 0;

  const root = svg('svg', {
    viewBox: `0 0 ${w} ${h}`,
    class: 'chart',
    preserveAspectRatio: 'none',
  });

  const usable = points.filter((p) => Number.isFinite(p.y));
  if (usable.length < 2) {
    root.append(svg('text', {
      x: w / 2, y: h / 2, 'text-anchor': 'middle', fill: '#9a908a', 'font-size': 12,
    }, document.createTextNode('not enough data') as unknown as SVGElement));
    return root;
  }

  const xs = usable.map((p) => p.x);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const [y0, y1] = niceBounds(usable.map((p) => p.y), band, opts.symmetric ?? true);

  const sx = (x: number) => padL + ((x - x0) / (x1 - x0 || 1)) * (w - padL - padR);
  const sy = (y: number) => padT + (1 - (y - y0) / (y1 - y0 || 1)) * (h - padT - padB);

  // Tolerance band, so "in range" is a place on the chart rather than a number.
  if (band > 0) {
    root.append(svg('rect', {
      x: padL, y: sy(band), width: w - padL - padR, height: Math.max(1, sy(-band) - sy(band)),
      fill: 'rgba(111, 158, 106, 0.10)',
    }));
  }

  // Zero line.
  if (y0 < 0 && y1 > 0) {
    root.append(svg('line', {
      x1: padL, y1: sy(0), x2: w - padR, y2: sy(0),
      stroke: '#4a423c', 'stroke-width': 1,
    }));
  }

  const d = usable.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  root.append(svg('path', {
    d, fill: 'none', stroke: '#c9a227', 'stroke-width': 1.6,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));

  if (opts.showTrend && usable.length > 8) {
    const n = usable.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = usable.reduce((a, b) => a + b.y, 0) / n;
    let num = 0;
    let den = 0;
    for (const p of usable) {
      num += (p.x - mx) * (p.y - my);
      den += (p.x - mx) ** 2;
    }
    if (den > 0) {
      const slope = num / den;
      const at = (x: number) => my + slope * (x - mx);
      root.append(svg('line', {
        x1: sx(x0), y1: sy(at(x0)), x2: sx(x1), y2: sy(at(x1)),
        stroke: '#b55c4e', 'stroke-width': 1.2, 'stroke-dasharray': '5 4', opacity: 0.85,
      }));
    }
  }

  for (const v of [y1, y0]) {
    const t = svg('text', {
      x: padL - 5, y: sy(v) + 4, 'text-anchor': 'end', fill: '#9a908a', 'font-size': 9,
    });
    t.textContent = v.toFixed(1);
    root.append(t);
  }

  const startLabel = svg('text', { x: padL, y: h - 5, fill: '#9a908a', 'font-size': 9 });
  startLabel.textContent = '0 min';
  const endLabel = svg('text', { x: w - padR, y: h - 5, 'text-anchor': 'end', fill: '#9a908a', 'font-size': 9 });
  endLabel.textContent = `${Math.round((x1 - x0) / 60000)} min`;
  root.append(startLabel, endLabel);

  return root;
}

/** Scatter of two metrics against each other, for the correlation view. */
export function scatterChart(pairs: Array<[number, number]>, r: number, labels: [string, string]): SVGElement {
  const w = 320;
  const h = 200;
  const pad = 30;
  const root = svg('svg', { viewBox: `0 0 ${w} ${h}`, class: 'chart', style: 'height:200px' });

  const finite = pairs.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (finite.length < 3) {
    const t = svg('text', { x: w / 2, y: h / 2, 'text-anchor': 'middle', fill: '#9a908a', 'font-size': 12 });
    t.textContent = 'not enough data';
    root.append(t);
    return root;
  }

  const axis = (vals: number[]) => {
    const m = Math.max(...vals.map(Math.abs), 1);
    return [-m, m] as const;
  };
  const [ax0, ax1] = axis(finite.map((p) => p[0]));
  const [ay0, ay1] = axis(finite.map((p) => p[1]));
  const sx = (v: number) => pad + ((v - ax0) / (ax1 - ax0)) * (w - pad * 2);
  const sy = (v: number) => pad + (1 - (v - ay0) / (ay1 - ay0)) * (h - pad * 2);

  root.append(
    svg('line', { x1: pad, y1: sy(0), x2: w - pad, y2: sy(0), stroke: '#4a423c', 'stroke-width': 1 }),
    svg('line', { x1: sx(0), y1: pad, x2: sx(0), y2: h - pad, stroke: '#4a423c', 'stroke-width': 1 }),
  );

  // Thin out dense sessions; 400 dots reads the same as 3600 and draws faster.
  const step = Math.max(1, Math.floor(finite.length / 400));
  for (let i = 0; i < finite.length; i += step) {
    const [a, b] = finite[i];
    root.append(svg('circle', { cx: sx(a), cy: sy(b), r: 1.8, fill: 'rgba(201, 162, 39, 0.45)' }));
  }

  const label = svg('text', { x: w - pad, y: pad - 8, 'text-anchor': 'end', fill: '#9a908a', 'font-size': 11 });
  label.textContent = `r = ${Number.isFinite(r) ? r.toFixed(2) : '—'}`;
  const xLabel = svg('text', { x: w / 2, y: h - 6, 'text-anchor': 'middle', fill: '#9a908a', 'font-size': 9 });
  xLabel.textContent = labels[0];
  const yLabel = svg('text', { x: 10, y: h / 2, fill: '#9a908a', 'font-size': 9, transform: `rotate(-90, 10, ${h / 2})`, 'text-anchor': 'middle' });
  yLabel.textContent = labels[1];
  root.append(label, xLabel, yLabel);

  return root;
}

/** Sparkline of one value across sessions, for the history trends. */
export function sparkline(values: number[], band = 0): SVGElement {
  const w = 300;
  const h = 44;
  const root = svg('svg', { viewBox: `0 0 ${w} ${h}`, class: 'chart', style: 'height:44px' });
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return root;

  const m = Math.max(...finite.map(Math.abs), band * 1.3, 0.5);
  const sx = (i: number) => (i / (values.length - 1)) * w;
  const sy = (v: number) => h / 2 - (v / m) * (h / 2 - 4);

  if (band > 0) {
    root.append(svg('rect', {
      x: 0, y: sy(band), width: w, height: Math.max(1, sy(-band) - sy(band)),
      fill: 'rgba(111, 158, 106, 0.12)',
    }));
  }
  root.append(svg('line', { x1: 0, y1: h / 2, x2: w, y2: h / 2, stroke: '#4a423c', 'stroke-width': 1 }));

  const d = values
    .map((v, i) => (Number.isFinite(v) ? `${i === 0 ? 'M' : 'L'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}` : ''))
    .filter(Boolean)
    .join(' ')
    .replace(/^L/, 'M');
  root.append(svg('path', { d, fill: 'none', stroke: '#c9a227', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }));

  values.forEach((v, i) => {
    if (Number.isFinite(v)) root.append(svg('circle', { cx: sx(i), cy: sy(v), r: 2, fill: '#c9a227' }));
  });

  return root;
}
