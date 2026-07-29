import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SettingsStore,
  sanitizeSettings,
  settingsEqual,
  type ChangeListener,
} from '../src/core/settings';
import { audioStrengthOf, videoStrengthOf } from '../src/core/strength';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from '../src/core/types';

/** Minimal stand-in for a `chrome.storage` area plus its change emitter. */
class FakeStorage {
  data = new Map<string, unknown>();
  writes = 0;
  failNext = false;
  private listeners = new Set<ChangeListener>();

  area = {
    get: async (keys: string | string[] | null) => {
      if (this.failNext) {
        this.failNext = false;
        throw new Error('storage unavailable');
      }
      const list = keys === null ? [...this.data.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) if (this.data.has(key)) out[key] = this.data.get(key);
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      this.writes++;
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: this.data.get(key), newValue: value };
        this.data.set(key, value);
      }
      for (const listener of this.listeners) listener(changes, 'sync');
    },
  };

  emitter = {
    addListener: (listener: ChangeListener) => this.listeners.add(listener),
    removeListener: (listener: ChangeListener) => this.listeners.delete(listener),
  };

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Simulate a write performed by another extension context. */
  emitExternal(value: unknown, areaName = 'sync'): void {
    for (const listener of this.listeners) {
      listener({ [SETTINGS_KEY]: { newValue: value } }, areaName);
    }
  }
}

describe('sanitizeSettings', () => {
  it('falls back to defaults for missing values', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('nonsense')).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps and rounds the strength', () => {
    expect(sanitizeSettings({ strength: -20 }).strength).toBe(0);
    expect(sanitizeSettings({ strength: 250 }).strength).toBe(100);
    expect(sanitizeSettings({ strength: 44.6 }).strength).toBe(45);
    expect(sanitizeSettings({ strength: Number.NaN }).strength).toBe(DEFAULT_SETTINGS.strength);
    expect(sanitizeSettings({ strength: '70' }).strength).toBe(DEFAULT_SETTINGS.strength);
  });

  it('coerces non-boolean flags to defaults', () => {
    const result = sanitizeSettings({ enabled: 'yes', audio: 0, video: false });
    expect(result.enabled).toBe(DEFAULT_SETTINGS.enabled);
    expect(result.audio).toBe(DEFAULT_SETTINGS.audio);
    expect(result.video).toBe(false);
  });

  it('defaults to running only at night, 21:00 to 07:00', () => {
    const fresh = sanitizeSettings({});
    expect(fresh.nightOnly).toBe(true);
    expect(fresh.nightStart).toBe(21 * 60);
    expect(fresh.nightEnd).toBe(7 * 60);
    expect(fresh.skipMusic).toBe(true);
  });

  it('accepts the night window as minutes or as a clock string', () => {
    expect(sanitizeSettings({ nightStart: 1290 }).nightStart).toBe(1290);
    expect(sanitizeSettings({ nightStart: '22:30' }).nightStart).toBe(1350);
  });

  it('wraps or rejects an impossible night window', () => {
    expect(sanitizeSettings({ nightEnd: 1440 }).nightEnd).toBe(0);
    expect(sanitizeSettings({ nightEnd: -30 }).nightEnd).toBe(1410);
    expect(sanitizeSettings({ nightEnd: 'later' }).nightEnd).toBe(DEFAULT_SETTINGS.nightEnd);
    expect(sanitizeSettings({ nightStart: null }).nightStart).toBe(DEFAULT_SETTINGS.nightStart);
  });

  it('drops unknown keys', () => {
    expect(sanitizeSettings({ enabled: false, evil: 'payload' })).toEqual({
      ...DEFAULT_SETTINGS,
      enabled: false,
    });
  });

  it('migrates pre-split settings by mirroring strength into both channels', () => {
    // Exactly what an existing user's stored object looks like.
    const migrated = sanitizeSettings({ enabled: true, strength: 70, audio: true, video: true });
    expect(migrated.linked).toBe(true);
    expect(migrated.audioStrength).toBe(70);
    expect(migrated.videoStrength).toBe(70);
    expect(migrated.nightEq).toBe(false);
    expect(migrated.disabledSites).toEqual([]);
    // The night restriction and the music exemption are new behaviour that an
    // existing install picks up on update, so the defaults have to be deliberate.
    expect(migrated.nightOnly).toBe(true);
    expect(migrated.skipMusic).toBe(true);
  });

  it('keeps per-channel strengths independent once they exist', () => {
    const split = sanitizeSettings({
      strength: 45,
      linked: false,
      audioStrength: 90,
      videoStrength: 10,
    });
    expect(split.audioStrength).toBe(90);
    expect(split.videoStrength).toBe(10);
  });

  it('clamps and rounds the per-channel strengths too', () => {
    expect(sanitizeSettings({ audioStrength: -5 }).audioStrength).toBe(0);
    expect(sanitizeSettings({ videoStrength: 140 }).videoStrength).toBe(100);
    expect(sanitizeSettings({ audioStrength: 61.5 }).audioStrength).toBe(62);
  });

  it('cleans up the exclusion list', () => {
    const result = sanitizeSettings({
      disabledSites: ['WWW.Example.COM', 'example.com', 'bad:8080', '', 42, 'x.test.'],
    });
    expect(result.disabledSites).toEqual(['bad', 'example.com', 'x.test']);
  });

  it('never shares the default exclusion array with stored settings', () => {
    const first = sanitizeSettings({});
    first.disabledSites.push('example.com');
    expect(sanitizeSettings({}).disabledSites).toEqual([]);
    expect(DEFAULT_SETTINGS.disabledSites).toEqual([]);
  });
});

describe('effective strength', () => {
  it('uses the master value while linked', () => {
    const linked = sanitizeSettings({
      strength: 60,
      linked: true,
      audioStrength: 10,
      videoStrength: 90,
    });
    expect(audioStrengthOf(linked)).toBe(60);
    expect(videoStrengthOf(linked)).toBe(60);
  });

  it('uses the per-channel values once unlinked', () => {
    const split = sanitizeSettings({
      strength: 60,
      linked: false,
      audioStrength: 10,
      videoStrength: 90,
    });
    expect(audioStrengthOf(split)).toBe(10);
    expect(videoStrengthOf(split)).toBe(90);
  });
});

describe('settingsEqual', () => {
  it('compares by value', () => {
    expect(settingsEqual({ ...DEFAULT_SETTINGS }, { ...DEFAULT_SETTINGS })).toBe(true);
    expect(settingsEqual({ ...DEFAULT_SETTINGS }, { ...DEFAULT_SETTINGS, strength: 10 })).toBe(
      false,
    );
  });

  it('notices every field, including the new ones', () => {
    const base = sanitizeSettings({});
    for (const patch of [
      { linked: false },
      { audioStrength: 1 },
      { videoStrength: 1 },
      { nightEq: true },
      { nightOnly: false },
      { nightStart: 1 },
      { nightEnd: 1 },
      { skipMusic: false },
      { disabledSites: ['example.com'] },
    ]) {
      expect(settingsEqual(base, sanitizeSettings({ ...base, ...patch }))).toBe(false);
    }
  });

  it('compares the exclusion list element-wise, not by identity', () => {
    const a = sanitizeSettings({ disabledSites: ['a.test', 'b.test'] });
    const b = sanitizeSettings({ disabledSites: ['b.test', 'a.test'] });
    expect(settingsEqual(a, b)).toBe(true); // sanitize sorts both
    expect(settingsEqual(a, sanitizeSettings({ disabledSites: ['a.test'] }))).toBe(false);
  });
});

describe('SettingsStore', () => {
  let storage: FakeStorage;
  let store: SettingsStore;

  beforeEach(() => {
    storage = new FakeStorage();
    store = new SettingsStore(storage.area, storage.emitter, 'sync');
  });

  it('returns defaults when nothing was ever saved', async () => {
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
    expect(storage.writes).toBe(0);
  });

  it('persists a patch and merges it with existing values', async () => {
    await store.save({ strength: 80 });
    await store.save({ audio: false });

    const loaded = await store.load();
    expect(loaded).toEqual({ ...DEFAULT_SETTINGS, strength: 80, audio: false });
    expect(storage.data.get(SETTINGS_KEY)).toEqual(loaded);
  });

  it('survives a round-trip through a fresh store instance', async () => {
    await store.save({ enabled: false, strength: 12, video: false });
    const other = new SettingsStore(storage.area, storage.emitter, 'sync');
    await expect(other.load()).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      enabled: false,
      strength: 12,
      video: false,
    });
  });

  it('sanitizes on the way in and on the way out', async () => {
    await store.save({ strength: 999 } as never);
    expect((storage.data.get(SETTINGS_KEY) as { strength: number }).strength).toBe(100);

    storage.data.set(SETTINGS_KEY, { strength: 'boom', enabled: 1 });
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('falls back to defaults when storage throws', async () => {
    storage.failNext = true;
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('seeds defaults only once', async () => {
    await store.ensureDefaults();
    expect(storage.writes).toBe(1);
    await store.save({ strength: 5 });
    await store.ensureDefaults();
    expect(storage.writes).toBe(2); // no extra write from ensureDefaults
    await expect(store.load()).resolves.toMatchObject({ strength: 5 });
  });

  it('resets to defaults', async () => {
    await store.save({ enabled: false, strength: 0 });
    await expect(store.reset()).resolves.toEqual(DEFAULT_SETTINGS);
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('notifies subscribers about external changes', async () => {
    const seen = vi.fn();
    store.subscribe(seen);

    await store.save({ strength: 33 });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, strength: 33 });

    storage.emitExternal({ enabled: false, strength: 90, audio: false, video: true });
    expect(seen).toHaveBeenLastCalledWith({
      ...DEFAULT_SETTINGS,
      enabled: false,
      strength: 90,
      // Settings written without the per-channel values inherit `strength`.
      audioStrength: 90,
      videoStrength: 90,
      audio: false,
      video: true,
    });
  });

  it('ignores changes from other storage areas and other keys', async () => {
    const seen = vi.fn();
    store.subscribe(seen);
    storage.emitExternal({ strength: 10 }, 'local');
    expect(seen).not.toHaveBeenCalled();

    await storage.area.set({ somethingElse: 1 });
    expect(seen).not.toHaveBeenCalled();
  });

  it('unsubscribes cleanly so listeners cannot pile up', () => {
    const unsubscribe = store.subscribe(vi.fn());
    expect(storage.listenerCount).toBe(1);
    unsubscribe();
    expect(storage.listenerCount).toBe(0);
  });

  it('degrades to a no-op subscription without an emitter', () => {
    const noEmitter = new SettingsStore(storage.area, null, 'sync');
    const unsubscribe = noEmitter.subscribe(vi.fn());
    expect(() => unsubscribe()).not.toThrow();
  });
});
