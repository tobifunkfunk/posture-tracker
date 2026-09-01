/**
 * Live gauges. Each one is a single geometric idea rendered as SVG, chosen so
 * it can be read at a glance with a soft gaze rather than studied.
 */
import { svg } from '../dom';
import { NOISE_FLOOR_DEG } from '../../posture/aggregate';

/** A spirit level: the bar tilts by the measured angle. */
export class LevelGauge {
  readonly root: SVGElement;
  private readonly bar: SVGElement;
  private readonly readout: SVGElement;

  constructor(private readonly tolerance = 2) {
    this.bar = svg('g');
    this.bar.append(
      svg('line', { x1: -70, y1: 0, x2: 70, y2: 0, stroke: 'currentColor', 'stroke-width': 3, 'stroke-linecap': 'round' }),
      svg('circle', { cx: -70, cy: 0, r: 5, fill: 'currentColor' }),
      svg('circle', { cx: 70, cy: 0, r: 5, fill: 'currentColor' }),
    );
    this.readout = svg('text', {
      x: 0, y: 42, 'text-anchor': 'middle', fill: 'currentColor',
      'font-size': 13, 'font-variant-numeric': 'tabular-nums',
    });

    this.root = svg('svg', { viewBox: '-90 -50 180 100', class: 'gauge' },
      // Reference horizon, so the tilt is read against something.
      svg('line', { x1: -80, y1: 0, x2: 80, y2: 0, stroke: '#332e2a', 'stroke-width': 1, 'stroke-dasharray': '3 4' }),
      svg('g', { transform: 'translate(0,-6)' }, this.bar),
      this.readout,
    );
  }

  set(deg: number): void {
    if (!Number.isFinite(deg)) {
      this.readout.textContent = '—';
      return;
    }
    // Amplify the visual tilt: 2 degrees is meaningful but nearly invisible
    // at true scale, so the gauge exaggerates by 4x to stay readable.
    this.bar.setAttribute('transform', `rotate(${(-deg * 4).toFixed(2)})`);
    const within = Math.abs(deg) <= this.tolerance;
    this.root.style.color = Math.abs(deg) < NOISE_FLOOR_DEG ? '#6f9e6a' : within ? '#9a908a' : '#c98a3f';
    this.readout.textContent = Math.abs(deg) < NOISE_FLOOR_DEG ? 'level' : `${deg > 0 ? 'L' : 'R'} ${Math.abs(deg).toFixed(1)}°`;
  }
}

/** A plumb line: the trunk axis drawn against true vertical. */
export class PlumbGauge {
  readonly root: SVGElement;
  private readonly trunk: SVGElement;
  private readonly readout: SVGElement;

  constructor(private readonly tolerance = 3) {
    this.trunk = svg('line', {
      x1: 0, y1: 40, x2: 0, y2: -40,
      stroke: 'currentColor', 'stroke-width': 4, 'stroke-linecap': 'round',
    });
    this.readout = svg('text', {
      x: 0, y: 62, 'text-anchor': 'middle', fill: 'currentColor',
      'font-size': 13, 'font-variant-numeric': 'tabular-nums',
    });
    this.root = svg('svg', { viewBox: '-70 -55 140 130', class: 'gauge' },
      svg('line', { x1: 0, y1: 42, x2: 0, y2: -45, stroke: '#332e2a', 'stroke-width': 1, 'stroke-dasharray': '3 4' }),
      svg('circle', { cx: 0, cy: 40, r: 3, fill: '#332e2a' }),
      this.trunk,
      this.readout,
    );
  }

  set(deg: number): void {
    if (!Number.isFinite(deg)) {
      this.readout.textContent = '—';
      return;
    }
    this.trunk.setAttribute('transform', `rotate(${(-deg * 3).toFixed(2)}, 0, 40)`);
    const within = Math.abs(deg) <= this.tolerance;
    this.root.style.color = Math.abs(deg) < NOISE_FLOOR_DEG ? '#6f9e6a' : within ? '#9a908a' : '#c98a3f';
    this.readout.textContent = Math.abs(deg) < NOISE_FLOOR_DEG ? 'upright' : `${deg > 0 ? 'left' : 'right'} ${Math.abs(deg).toFixed(1)}°`;
  }
}

/** A rotation dial, seen from above: shoulder line against the reference. */
export class RotationGauge {
  readonly root: SVGElement;
  private readonly line: SVGElement;
  private readonly readout: SVGElement;

  constructor(private readonly tolerance = 5) {
    this.line = svg('g');
    this.line.append(
      svg('line', { x1: -46, y1: 0, x2: 46, y2: 0, stroke: 'currentColor', 'stroke-width': 4, 'stroke-linecap': 'round' }),
      // A short stub marking which way the body faces.
      svg('line', { x1: 0, y1: 0, x2: 0, y2: 20, stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', opacity: 0.5 }),
    );
    this.readout = svg('text', {
      x: 0, y: 62, 'text-anchor': 'middle', fill: 'currentColor',
      'font-size': 13, 'font-variant-numeric': 'tabular-nums',
    });
    this.root = svg('svg', { viewBox: '-70 -55 140 130', class: 'gauge' },
      svg('circle', { cx: 0, cy: 0, r: 46, fill: 'none', stroke: '#332e2a', 'stroke-width': 1 }),
      svg('line', { x1: -50, y1: 0, x2: 50, y2: 0, stroke: '#332e2a', 'stroke-width': 1, 'stroke-dasharray': '3 4' }),
      this.line,
      this.readout,
    );
  }

  set(deg: number): void {
    if (!Number.isFinite(deg)) {
      this.readout.textContent = '—';
      return;
    }
    this.line.setAttribute('transform', `rotate(${(deg * 1.5).toFixed(2)})`);
    const within = Math.abs(deg) <= this.tolerance;
    this.root.style.color = Math.abs(deg) < NOISE_FLOOR_DEG ? '#6f9e6a' : within ? '#9a908a' : '#c98a3f';
    this.readout.textContent = Math.abs(deg) < NOISE_FLOOR_DEG ? 'square' : `${deg > 0 ? 'left' : 'right'} ${Math.abs(deg).toFixed(1)}°`;
  }
}
