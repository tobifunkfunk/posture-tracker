/**
 * Local persistence. Everything lives in IndexedDB on the device: no frames,
 * no video, no network. What is stored is landmarks reduced to angles, which
 * is both far smaller and far less personal than the footage it came from.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CameraProfile, MetricKey, Sample } from '../posture/types';

export type SessionMode = 'blind' | 'live';

export interface SessionRecord {
  id: string;
  profileId: string;
  startedAt: number;
  durationMs: number;
  mode: SessionMode;
  /** Fraction of samples with a usable pose, 0..1. */
  quality: number;
  /** Fraction of samples where the hips were visible enough to trust. */
  hipQuality: number;
  /** Set when the tripod moved mid-session; the angles are then not comparable. */
  tripodMoved: boolean;
  /** Degrees the camera drifted, when known. */
  tripodDriftDeg: number | null;
  notes: string;
  /** Whether the head KPIs came from the face model or the coarser ear-line fallback. */
  headSource: 'face-model' | 'pose-fallback';
}

export interface SampleBlock {
  sessionId: string;
  /** Decimated to 1Hz: one entry per second of the session. */
  samples: Sample[];
}

export interface Settings {
  id: 'settings';
  sampleHz: number;
  withFace: boolean;
  defaultMode: SessionMode;
  activeProfileId: string | null;
  /** Session length in minutes; 0 means open-ended. */
  plannedMinutes: number;
  startBell: boolean;
  endBell: boolean;
  nudges: NudgeSettings;
  tolerance: Partial<Record<MetricKey, number>>;
}

export interface NudgeSettings {
  visual: boolean;
  chime: boolean;
  glow: boolean;
  /** Which metrics can trigger a nudge. */
  metrics: MetricKey[];
  /** Seconds out of band before anything fires. */
  minOutOfBandSec: number;
  /** Seconds of silence enforced after a nudge, so it cannot nag. */
  cooldownSec: number;
  chimeVolume: number;
}

interface PostureDB extends DBSchema {
  sessions: {
    key: string;
    value: SessionRecord;
    indexes: { 'by-start': number; 'by-profile': string };
  };
  samples: { key: string; value: SampleBlock };
  profiles: { key: string; value: CameraProfile };
  settings: { key: string; value: Settings };
}

const DB_NAME = 'posture-tracker';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<PostureDB>> | null = null;

export function db(): Promise<IDBPDatabase<PostureDB>> {
  if (!dbPromise) {
    dbPromise = openDB<PostureDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        const sessions = database.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('by-start', 'startedAt');
        sessions.createIndex('by-profile', 'profileId');
        database.createObjectStore('samples', { keyPath: 'sessionId' });
        database.createObjectStore('profiles', { keyPath: 'id' });
        database.createObjectStore('settings', { keyPath: 'id' });
      },
    });
  }
  return dbPromise;
}

export const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  sampleHz: 5,
  withFace: false,
  defaultMode: 'blind',
  activeProfileId: null,
  plannedMinutes: 20,
  startBell: true,
  endBell: true,
  nudges: {
    visual: true,
    chime: false,
    glow: false,
    metrics: ['shoulderOnlyTilt', 'lateralLean'],
    minOutOfBandSec: 20,
    cooldownSec: 90,
    chimeVolume: 0.25,
  },
  tolerance: {},
};

export async function getSettings(): Promise<Settings> {
  const stored = await (await db()).get('settings', 'settings');
  // Merge rather than replace, so a settings shape added later still loads.
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    nudges: { ...DEFAULT_SETTINGS.nudges, ...stored?.nudges },
    tolerance: { ...DEFAULT_SETTINGS.tolerance, ...stored?.tolerance },
  };
}

export async function saveSettings(s: Settings): Promise<void> {
  await (await db()).put('settings', { ...s, id: 'settings' });
}

export async function saveProfile(p: CameraProfile): Promise<void> {
  await (await db()).put('profiles', p);
}

export async function getProfile(id: string): Promise<CameraProfile | undefined> {
  return (await db()).get('profiles', id);
}

export async function listProfiles(): Promise<CameraProfile[]> {
  return (await (await db()).getAll('profiles')).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteProfile(id: string): Promise<void> {
  await (await db()).delete('profiles', id);
}

export async function saveSession(record: SessionRecord, samples: Sample[]): Promise<void> {
  const d = await db();
  const tx = d.transaction(['sessions', 'samples'], 'readwrite');
  await Promise.all([
    tx.objectStore('sessions').put(record),
    tx.objectStore('samples').put({ sessionId: record.id, samples }),
    tx.done,
  ]);
}

export async function listSessions(limit = 200): Promise<SessionRecord[]> {
  const all = await (await db()).getAllFromIndex('sessions', 'by-start');
  return all.reverse().slice(0, limit);
}

export async function getSession(id: string): Promise<{ record: SessionRecord; samples: Sample[] } | null> {
  const d = await db();
  const record = await d.get('sessions', id);
  if (!record) return null;
  const block = await d.get('samples', id);
  return { record, samples: block?.samples ?? [] };
}

export async function deleteSession(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['sessions', 'samples'], 'readwrite');
  await Promise.all([
    tx.objectStore('sessions').delete(id),
    tx.objectStore('samples').delete(id),
    tx.done,
  ]);
}

export function newId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}

/**
 * Sessions are only comparable within one camera profile, so a session that
 * cannot be tied back to its setup is worse than useless.
 */
export async function sessionsForProfile(profileId: string): Promise<SessionRecord[]> {
  return (await (await db()).getAllFromIndex('sessions', 'by-profile', profileId)).sort(
    (a, b) => a.startedAt - b.startedAt,
  );
}
