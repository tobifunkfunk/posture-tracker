import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS, blankProfile, getSettings, listProfiles, saveProfile, saveSession,
  saveSettings, getSession, listSessions, sessionsForProfile,
} from '../src/store/db';
import { poolAzimuth, sessionAzimuthEstimate } from '../src/posture/autocalibrate';
import { toDeg } from '../src/posture/vec';
import type { Sample } from '../src/posture/types';

describe('blankProfile', () => {
  it('is usable immediately, with nothing assumed about the setup', () => {
    const p = blankProfile();
    expect(p.azimuth).toBe(0);
    expect(p.sessionCount).toBe(0);
    expect(p.mirrored).toBe(false);
    // Gravity starts as "assume level" and is overwritten by the sensor at the
    // start of the first sit.
    expect(p.gravitySource).toBe('assumed-level');
    expect(p.gravityDown).toEqual({ x: 0, y: -1, z: 0 });
  });

  it('mints a distinct id each time', () => {
    expect(blankProfile().id).not.toBe(blankProfile().id);
  });
});

describe('profile persistence', () => {
  it('round-trips a profile through storage', async () => {
    const p = blankProfile('Bench by the window');
    await saveProfile(p);
    const found = (await listProfiles()).find((x) => x.id === p.id)!;
    expect(found.name).toBe('Bench by the window');
    expect(found.sessionCount).toBe(0);
  });

  it('accumulates the azimuth estimate across sits, as the app does', async () => {
    let profile = blankProfile('Converging');
    await saveProfile(profile);

    // The camera really sits 14 degrees off-axis; each sit sees the residual.
    const TRUE_AZIMUTH_DEG = 14;
    for (let i = 0; i < 25; i++) {
      const residual = TRUE_AZIMUTH_DEG - toDeg(profile.azimuth);
      const yawSamples = Array.from({ length: 40 }, (_, k) => residual + Math.sin(k) * 3);
      const estimate = sessionAzimuthEstimate(profile.azimuth, yawSamples)!;
      const pooled = poolAzimuth(profile.azimuth, profile.sessionCount, estimate);
      profile = { ...profile, azimuth: pooled.azimuth, sessionCount: profile.sessionCount + 1 };
      await saveProfile(profile);
    }

    const stored = (await listProfiles()).find((x) => x.id === profile.id)!;
    expect(toDeg(stored.azimuth)).toBeCloseTo(TRUE_AZIMUTH_DEG, 0);
    expect(stored.sessionCount).toBe(25);
  });
});

describe('session persistence', () => {
  const sample = (t: number): Sample => ({
    t,
    metrics: {
      shoulderTilt: 1, shoulderDropMm: 5, shoulderDropRatio: 0.01,
      lateralLean: 2, shoulderOnlyTilt: 3, sagittalLean: NaN,
      torsoYaw: 4, pelvisYaw: NaN, torsoTwist: NaN,
      headRoll: 1, headRollEyes: 1, headRollEars: 1,
      headRollVsShoulders: 0, headYawVsShoulders: 0, headLateralOffset: 0,
      upperQuality: 0.9, hipQuality: 0.1, hipsReliable: false,
      leanSource: 'silhouette',
    },
  });

  it('stores and reloads a bench sit with no hips at all', async () => {
    const profile = blankProfile('Bench');
    await saveProfile(profile);
    const samples = [sample(0), sample(1000), sample(2000)];

    await saveSession({
      id: 'sess-1', profileId: profile.id, startedAt: Date.now(), durationMs: 3000,
      mode: 'blind', quality: 0.95, hipQuality: 0.1,
      tripodMoved: false, setupChanged: false, tripodDriftDeg: null, notes: '',
    }, samples);

    const loaded = (await getSession('sess-1'))!;
    expect(loaded.samples).toHaveLength(3);
    expect(loaded.samples[0].metrics.leanSource).toBe('silhouette');
    expect(loaded.samples[0].metrics.hipsReliable).toBe(false);
    expect(loaded.record.setupChanged).toBe(false);
    expect((await sessionsForProfile(profile.id)).map((s) => s.id)).toContain('sess-1');
  });

  it('lists sessions newest first', async () => {
    const profile = blankProfile('Ordering');
    await saveProfile(profile);
    const base = Date.UTC(2026, 0, 1);
    for (const [i, id] of ['old', 'mid', 'new'].entries()) {
      await saveSession({
        id: `ord-${id}`, profileId: profile.id, startedAt: base + i * 86_400_000,
        durationMs: 1000, mode: 'blind', quality: 1, hipQuality: 0,
        tripodMoved: false, setupChanged: false, tripodDriftDeg: null, notes: '',
      }, [sample(0)]);
    }
    const ids = (await listSessions()).map((s) => s.id).filter((id) => id.startsWith('ord-'));
    expect(ids.slice(0, 3)).toEqual(['ord-new', 'ord-mid', 'ord-old']);
  });
});

describe('settings', () => {
  beforeEach(async () => {
    await saveSettings({ ...DEFAULT_SETTINGS });
  });

  it('merges stored settings over defaults, so new fields survive an upgrade', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, sampleHz: 9 });
    const s = await getSettings();
    expect(s.sampleHz).toBe(9);
    // A field the stored copy never had still arrives from the defaults.
    expect(s.overlayStyle).toBe('outline');
    expect(s.nudges.cooldownSec).toBe(DEFAULT_SETTINGS.nudges.cooldownSec);
  });
});
