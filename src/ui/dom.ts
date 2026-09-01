/** Minimal DOM helpers — enough structure to avoid a framework. */

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;
type Child = Node | string | number | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      node.className = String(v);
    } else if (k === 'html') {
      node.innerHTML = String(v);
    } else if (v === true) {
      node.setAttribute(k, '');
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const svg = (tag: string, attrs: Record<string, string | number> = {}, ...children: Node[]): SVGElement => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  children.forEach((c) => node.append(c));
  return node;
};

/** Append children, skipping the nulls that conditional rendering produces. */
export function append(parent: HTMLElement, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Format a metric for display, respecting the noise floor. */
export function fmt(value: number, unit: string, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  if (unit === '°' && Math.abs(value) < 1) return `<1${unit}`;
  return `${value.toFixed(digits)}${unit}`;
}

export function fmtSigned(value: number, unit: string, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}${unit}`;
}

export function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function fmtPercent(fraction: number): string {
  return Number.isFinite(fraction) ? `${Math.round(fraction * 100)}%` : '—';
}
