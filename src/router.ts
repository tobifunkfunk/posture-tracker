/**
 * Hash routing. Each screen returns its own teardown, which matters here more
 * than in most apps: leaving a screen must stop the camera and release the
 * wake lock, not merely blank the DOM.
 */
type Screen = (root: HTMLElement, param: string) => (() => void) | void;

const routes: Array<{ pattern: RegExp; screen: Screen; tab: string | null }> = [];
let teardown: (() => void) | void;
let container: HTMLElement | null = null;
let navEl: HTMLElement | null = null;

export function route(pattern: RegExp, screen: Screen, tab: string | null = null): void {
  routes.push({ pattern, screen, tab });
}

export function navigate(hash: string): void {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function render(): void {
  if (!container) return;
  if (typeof teardown === 'function') teardown();
  teardown = undefined;

  const hash = location.hash || '#/';
  while (container.firstChild) container.removeChild(container.firstChild);

  for (const { pattern, screen, tab } of routes) {
    const match = pattern.exec(hash);
    if (!match) continue;
    highlight(tab);
    teardown = screen(container, match[1] ?? '');
    window.scrollTo(0, 0);
    return;
  }
  navigate('#/');
}

function highlight(tab: string | null): void {
  if (!navEl) return;
  // The nav hides itself during a session so nothing invites a tap mid-sit.
  navEl.style.display = tab === null ? 'none' : '';
  navEl.querySelectorAll('a').forEach((a) => {
    a.classList.toggle('active', a.dataset.tab === tab);
  });
}

export function startRouter(mount: HTMLElement, nav: HTMLElement): void {
  container = mount;
  navEl = nav;
  window.addEventListener('hashchange', render);
  render();
}
