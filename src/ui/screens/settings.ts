/**
 * Settings. The nudge controls are the substantive part: each channel is
 * independently switchable, because the right amount of feedback during
 * meditation is a personal and shifting thing.
 */
import { el, clear, fmtDate } from '../dom';
import { DEFAULT_TOLERANCE } from '../../posture/aggregate';
import { METRIC_META } from '../../posture/metrics';
import type { MetricKey } from '../../posture/types';
import {
  deleteProfile, getSession, getSettings, listProfiles, listSessions, saveSettings, type Settings,
} from '../../store/db';
import { Chime } from '../../nudge';
import { navigate } from '../../router';

const NUDGEABLE: MetricKey[] = ['shoulderOnlyTilt', 'lateralLean', 'sagittalLean', 'torsoTwist', 'headYawVsShoulders'];

export function settingsScreen(root: HTMLElement): () => void {
  let disposed = false;
  const chime = new Chime();

  void (async () => {
    const settings = await getSettings();
    const profiles = await listProfiles();
    if (disposed) return;

    const save = async () => { await saveSettings(settings); };

    const toggle = (label: string, desc: string, get: () => boolean, set: (v: boolean) => void) =>
      el('label', { class: 'toggle' },
        el('div', {}, el('div', {}, label), el('div', { class: 'desc' }, desc)),
        el('input', {
          type: 'checkbox', checked: get(),
          onchange: (e: Event) => { set((e.target as HTMLInputElement).checked); void save(); },
        }));

    clear(root);
    root.append(
      el('h1', {}, 'Settings'),

      el('h2', {}, 'Nudges'),
      el('div', { class: 'card' },
        toggle('Visual gauges', 'Live mode only. Level bar, plumb line and twist dial.',
          () => settings.nudges.visual, (v) => { settings.nudges.visual = v; }),
        toggle('Soft chime', 'A quiet tone when you have been out of range a while. Works in blind mode.',
          () => settings.nudges.chime, (v) => { settings.nudges.chime = v; if (v) void chime.unlock().then(() => chime.play(settings.nudges.chimeVolume)); }),
        toggle('Ambient glow', 'The screen edge tints as you drift. Readable with eyes almost closed.',
          () => settings.nudges.glow, (v) => { settings.nudges.glow = v; })),

      el('div', { class: 'card' },
        el('h3', {}, 'What can trigger a nudge'),
        ...NUDGEABLE.map((key) =>
          el('label', { class: 'toggle' },
            el('div', {}, el('div', {}, METRIC_META[key].label)),
            el('input', {
              type: 'checkbox', checked: settings.nudges.metrics.includes(key),
              onchange: (e: Event) => {
                const on = (e.target as HTMLInputElement).checked;
                settings.nudges.metrics = on
                  ? [...settings.nudges.metrics, key]
                  : settings.nudges.metrics.filter((k) => k !== key);
                void save();
              },
            }))),
        el('label', { class: 'field', style: 'margin-top:14px' },
          el('span', {}, `Wait ${settings.nudges.minOutOfBandSec}s out of range before nudging`),
          el('input', {
            type: 'range', min: 5, max: 120, step: 5, value: settings.nudges.minOutOfBandSec,
            oninput: (e: Event) => {
              settings.nudges.minOutOfBandSec = Number((e.target as HTMLInputElement).value);
              (e.target as HTMLElement).previousElementSibling!.textContent =
                `Wait ${settings.nudges.minOutOfBandSec}s out of range before nudging`;
            },
            onchange: () => void save(),
          })),
        el('label', { class: 'field' },
          el('span', {}, `Then stay quiet for ${settings.nudges.cooldownSec}s`),
          el('input', {
            type: 'range', min: 15, max: 600, step: 15, value: settings.nudges.cooldownSec,
            oninput: (e: Event) => {
              settings.nudges.cooldownSec = Number((e.target as HTMLInputElement).value);
              (e.target as HTMLElement).previousElementSibling!.textContent =
                `Then stay quiet for ${settings.nudges.cooldownSec}s`;
            },
            onchange: () => void save(),
          })),
        el('div', { class: 'small muted' },
          'A long wait and a long cooldown are the difference between a nudge and a nag.')),

      el('h2', {}, 'Tolerance bands'),
      el('div', { class: 'card' },
        el('p', { class: 'small muted' },
          'How far from your reference counts as "in range". Anything under 1° is measurement noise and will not be flagged regardless.'),
        ...NUDGEABLE.map((key) =>
          el('label', { class: 'field' },
            el('span', {}, `${METRIC_META[key].label} (±${settings.tolerance[key] ?? DEFAULT_TOLERANCE[key]}${METRIC_META[key].unit})`),
            el('input', {
              type: 'range', min: 1, max: 15, step: 0.5,
              value: settings.tolerance[key] ?? DEFAULT_TOLERANCE[key],
              oninput: (e: Event) => {
                const v = Number((e.target as HTMLInputElement).value);
                settings.tolerance[key] = v;
                (e.target as HTMLElement).previousElementSibling!.textContent =
                  `${METRIC_META[key].label} (±${v}${METRIC_META[key].unit})`;
              },
              onchange: () => void save(),
            })))),

      el('h2', {}, 'Session'),
      el('div', { class: 'card' },
        toggle('Bell at the start', 'A low tone when the session begins.',
          () => settings.startBell, (v) => { settings.startBell = v; }),
        toggle('Bell at the end', 'A low tone when the planned time is up.',
          () => settings.endBell, (v) => { settings.endBell = v; }),
        el('label', { class: 'field', style: 'margin-top:14px' },
          el('span', {}, 'Live view'),
          el('select', {
            onchange: (e: Event) => { settings.overlayStyle = (e.target as HTMLSelectElement).value as Settings['overlayStyle']; void save(); },
          },
            el('option', { value: 'outline', selected: settings.overlayStyle === 'outline' }, 'Body outline'),
            el('option', { value: 'skeleton', selected: settings.overlayStyle === 'skeleton' }, 'Landmark skeleton'),
            el('option', { value: 'both', selected: settings.overlayStyle === 'both' }, 'Both')),
          el('div', { class: 'small muted', style: 'margin-top:4px' },
            'The outline traces your silhouette, which is easier to read than a stick figure. It costs a little more per frame, so it is switched off automatically during a blind sit.')),
        el('label', { class: 'field', style: 'margin-top:14px' },
          el('span', {}, 'Default mode'),
          el('select', {
            onchange: (e: Event) => { settings.defaultMode = (e.target as HTMLSelectElement).value as Settings['defaultMode']; void save(); },
          },
            el('option', { value: 'blind', selected: settings.defaultMode === 'blind' }, 'Blind'),
            el('option', { value: 'live', selected: settings.defaultMode === 'live' }, 'Live feedback')))),

      el('h2', {}, 'Capture'),
      el('div', { class: 'card' },
        el('label', { class: 'field' },
          el('span', {}, `Sample rate: ${settings.sampleHz} Hz`),
          el('input', {
            type: 'range', min: 2, max: 15, step: 1, value: settings.sampleHz,
            oninput: (e: Event) => {
              settings.sampleHz = Number((e.target as HTMLInputElement).value);
              (e.target as HTMLElement).previousElementSibling!.textContent = `Sample rate: ${settings.sampleHz} Hz`;
            },
            onchange: () => void save(),
          }),
          el('div', { class: 'small muted', style: 'margin-top:4px' },
            'Meditation is nearly static, so 5 Hz captures everything that matters. Higher rates warm the phone and drain the battery for no real gain.')),
      ),

      el('h2', {}, 'Camera setups'),
      el('div', { class: 'card' },
        ...(profiles.length
          ? profiles.map((p) =>
              el('div', { class: 'session-row' },
                el('div', {},
                  el('div', {}, p.name, p.id === settings.activeProfileId ? el('span', { class: 'badge good', style: 'margin-left:8px' }, 'active') : null),
                  el('div', { class: 'small muted' },
                    `${fmtDate(p.createdAt)} · ${((p.azimuth * 180) / Math.PI).toFixed(0)}° off-axis · ${p.gravitySource === 'sensor' ? 'tilt corrected' : 'assumed level'}`)),
                el('div', { class: 'row', style: 'gap:6px' },
                  p.id !== settings.activeProfileId
                    ? el('button', { class: 'ghost small', onclick: async () => { settings.activeProfileId = p.id; await save(); settingsScreen(root); } }, 'Use')
                    : null,
                  el('button', {
                    class: 'ghost danger small',
                    onclick: async () => {
                      if (!confirm(`Delete "${p.name}"? Its sessions stay but lose their reference.`)) return;
                      await deleteProfile(p.id);
                      clear(root);
                      settingsScreen(root);
                    },
                  }, 'Delete'))))
          : [el('p', { class: 'muted small' }, 'No setups yet.')]),
        el('button', { class: 'block', style: 'margin-top:12px', onclick: () => navigate('#/calibrate') }, 'Calibrate a new setup')),

      el('h2', {}, 'Your data'),
      el('div', { class: 'card' },
        el('p', { class: 'small muted' },
          'Everything stays on this device. No video is ever recorded or sent — only joint angles are stored. There is no server and no network request.'),
        el('button', { class: 'block', onclick: () => void exportAll() }, 'Export everything as JSON')),
    );
  })();

  return () => { disposed = true; chime.close(); };
}

async function exportAll(): Promise<void> {
  const records = await listSessions(1000);
  const profiles = await listProfiles();
  const settings = await getSettings();
  const sessions = await Promise.all(records.map((r) => getSession(r.id)));

  const blob = new Blob(
    [JSON.stringify({ exportedAt: Date.now(), profiles, settings, sessions }, null, 2)],
    { type: 'application/json' },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `posture-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
