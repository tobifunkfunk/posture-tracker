import { el, clear, fmtDate, fmtDuration, fmtSigned } from '../dom';
import { summarize } from '../../posture/aggregate';
import { METRIC_META } from '../../posture/metrics';
import { getSession, getSettings, listSessions } from '../../store/db';
import { navigate } from '../../router';

export function homeScreen(root: HTMLElement): () => void {
  let disposed = false;

  void (async () => {
    const [settings, sessions] = await Promise.all([getSettings(), listSessions(5)]);
    if (disposed) return;

    clear(root);
    root.append(
      el('h1', {}, 'Posture'),
      el('p', { class: 'sub' }, 'Sit. The camera watches your alignment and keeps the numbers, so you do not have to think about them while you sit.'),
    );

    if (!settings.activeProfileId) {
      root.append(
        el('div', { class: 'card' },
          el('h3', {}, 'Start here'),
          el('p', { class: 'small' },
            'Calibrate the camera once per setup. It takes about a minute and it is what separates a crooked tripod from a crooked spine.'),
          el('button', { class: 'primary block', onclick: () => navigate('#/calibrate') }, 'Set up the camera')),
      );
      return;
    }

    root.append(
      el('button', { class: 'primary block', style: 'padding:18px', onclick: () => navigate('#/session') }, 'Begin a sit'),
    );

    if (sessions.length) {
      const last = await getSession(sessions[0].id);
      if (disposed) return;
      if (last && last.samples.length > 20) {
        const s = summarize(last.samples);
        root.append(
          el('h2', {}, 'Last sit'),
          el('div', { class: 'card', style: 'cursor:pointer', onclick: () => navigate(`#/report/${last.record.id}`) },
            el('div', { class: 'row spread' },
              el('span', { class: 'small muted' }, fmtDate(last.record.startedAt)),
              el('span', { class: 'small muted' }, fmtDuration(last.record.durationMs))),
            ...(['shoulderOnlyTilt', 'lateralLean', 'torsoTwist'] as const).map((key) =>
              el('div', { class: 'kpi' },
                el('span', { class: 'label' }, METRIC_META[key].label),
                el('span', { class: 'value' }, fmtSigned(s[key].mean, METRIC_META[key].unit))))),
        );
      }

      root.append(
        el('h2', {}, 'Recent'),
        el('div', { class: 'card' },
          ...sessions.map((r) =>
            el('div', { class: 'session-row', onclick: () => navigate(`#/report/${r.id}`) },
              el('div', {},
                el('div', { class: 'small' }, fmtDate(r.startedAt)),
                el('div', { class: 'small muted' }, `${fmtDuration(r.durationMs)} · ${r.mode}`)),
              el('span', { class: 'muted' }, '›')))),
        el('button', { class: 'ghost block', style: 'margin-top:10px', onclick: () => navigate('#/history') }, 'All sessions and trends'),
      );
    }
  })();

  return () => { disposed = true; };
}
