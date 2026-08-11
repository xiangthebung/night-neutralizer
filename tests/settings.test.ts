import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SettingsStore,
  sanitizeSettings,
  settingsEqual,
  type ChangeListener,
} from '../src/core/settings';
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

  it('clamps and rounds both strengths', () => {
    expect(sanitizeSettings({ audioStrength: -20 }).audioStrength).toBe(0);
    expect(sanitizeSettings({ videoStrength: 250 }).videoStrength).toBe(100);
    expect(sanitizeSettings({ audioStrength: 44.6 }).audioStrength).toBe(45);
    expect(sanitizeSettings({ videoStrength: 61.5 }).videoStrength).toBe(62);
    expect(sanitizeSettings({ audioStrength: Number.NaN }).audioStrength).toBe(
      DEFAULT_SETTINGS.audioStrength,
    );
    expect(sanitizeSettings({ videoStrength: '70' }).videoStrength).toBe(
      DEFAULT_SETTINGS.videoStrength,
    );
  });

  it('coerces non-boolean flags to defaults', () => {
    const result = sanitizeSettings({ enabled: 'yes', audio: 0, video: false });
    expect(result.enabled).toBe(DEFAULT_SETTINGS.enabled);
    expect(result.audio).toBe(DEFAULT_SETTINGS.audio);
    expect(result.video).toBe(false);
  });

  it('turns still images on for settings written before the toggle existed', () => {
    const legacy = { enabled: true, strength: 45, audio: true, video: true };
    expect(sanitizeSettings(legacy).images).toBe(true);
    expect(sanitizeSettings({ images: false }).images).toBe(false);
  });

  it('leaves dark mode off for settings written before it existed', () => {
    // The opposite migration from `images`, and deliberately so: inverting a
    // page changes how a site looks on purpose, so it must never arrive with an
    // update on someone who did not ask for it.
    const legacy = { enabled: true, strength: 45, audio: true, video: true, images: true };
    expect(sanitizeSettings(legacy).darkMode).toBe(false);
    expect(sanitizeSettings({ darkMode: true }).darkMode).toBe(true);
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

/*
 * The settings that used to exist. A synced profile keeps whatever was last
 * written to it, so an install that has not been opened since the reorganisation
 * still has the old shape sitting in storage, and it has to arrive at the new
 * one without the user noticing anything except the popup's new layout.
 */
describe('migrating from the old shape', () => {
  it('takes the shared slider as both strengths', () => {
    // What a linked install — the default, so most of them — looks like.
    const migrated = sanitizeSettings({
      enabled: true,
      strength: 70,
      linked: true,
      audio: true,
      video: true,
    });
    expect(migrated.audioStrength).toBe(70);
    expect(migrated.videoStrength).toBe(70);
  });

  it('keeps the two strengths of an install that had already separated them', () => {
    const split = sanitizeSettings({
      strength: 45,
      linked: false,
      audioStrength: 90,
      videoStrength: 10,
    });
    expect(split.audioStrength).toBe(90);
    expect(split.videoStrength).toBe(10);
  });

  it('honours the per-channel values even where `linked` said otherwise', () => {
    // `linked` is gone, and with it any way to mean "ignore these two". They
    // were kept in step while linked, so taking them at face value is right in
    // both cases and needs no reconstruction of a mode that no longer exists.
    const linked = sanitizeSettings({
      strength: 60,
      linked: true,
      audioStrength: 10,
      videoStrength: 90,
    });
    expect(linked.audioStrength).toBe(10);
    expect(linked.videoStrength).toBe(90);
  });

  it('carries dark mode over from its old name', () => {
    expect(sanitizeSettings({ pageDark: true }).darkMode).toBe(true);
    expect(sanitizeSettings({ pageDark: false }).darkMode).toBe(false);
    // The new name wins where both are present, which is what a downgrade and
    // re-upgrade through a synced profile would produce.
    expect(sanitizeSettings({ pageDark: true, darkMode: false }).darkMode).toBe(false);
  });

  it('drops the settings that no longer exist rather than carrying them along', () => {
    const cleaned = sanitizeSettings({ strength: 70, linked: false, pageColor: true });
    expect(cleaned).not.toHaveProperty('strength');
    expect(cleaned).not.toHaveProperty('linked');
    expect(cleaned).not.toHaveProperty('pageColor');
  });
});

describe('settingsEqual', () => {
  it('compares by value', () => {
    expect(settingsEqual({ ...DEFAULT_SETTINGS }, { ...DEFAULT_SETTINGS })).toBe(true);
    expect(settingsEqual({ ...DEFAULT_SETTINGS }, { ...DEFAULT_SETTINGS, audioStrength: 10 })).toBe(
      false,
    );
  });

  it('notices every field', () => {
    const base = sanitizeSettings({});
    for (const patch of [
      { enabled: false },
      { audio: false },
      { audioStrength: 1 },
      { nightEq: true },
      { skipMusic: false },
      { video: false },
      { images: false },
      { videoStrength: 1 },
      { darkMode: true },
      { nightOnly: false },
      { nightStart: 1 },
      { nightEnd: 1 },
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
    await store.save({ audioStrength: 80 });
    await store.save({ audio: false });

    const loaded = await store.load();
    expect(loaded).toEqual({ ...DEFAULT_SETTINGS, audioStrength: 80, audio: false });
    expect(storage.data.get(SETTINGS_KEY)).toEqual(loaded);
  });

  it('survives a round-trip through a fresh store instance', async () => {
    await store.save({ enabled: false, videoStrength: 12, video: false });
    const other = new SettingsStore(storage.area, storage.emitter, 'sync');
    await expect(other.load()).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      enabled: false,
      videoStrength: 12,
      video: false,
    });
  });

  it('sanitizes on the way in and on the way out', async () => {
    await store.save({ audioStrength: 999 } as never);
    expect((storage.data.get(SETTINGS_KEY) as { audioStrength: number }).audioStrength).toBe(100);

    storage.data.set(SETTINGS_KEY, { audioStrength: 'boom', enabled: 1 });
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('falls back to defaults when storage throws', async () => {
    storage.failNext = true;
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('seeds defaults only once', async () => {
    await store.ensureDefaults();
    expect(storage.writes).toBe(1);
    await store.save({ audioStrength: 5 });
    await store.ensureDefaults();
    expect(storage.writes).toBe(2); // no extra write from ensureDefaults
    await expect(store.load()).resolves.toMatchObject({ audioStrength: 5 });
  });

  it('resets to defaults', async () => {
    await store.save({ enabled: false, audioStrength: 0 });
    await expect(store.reset()).resolves.toEqual(DEFAULT_SETTINGS);
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('notifies subscribers about external changes', async () => {
    const seen = vi.fn();
    store.subscribe(seen);

    await store.save({ videoStrength: 33 });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, videoStrength: 33 });

    storage.emitExternal({ enabled: false, strength: 90, audio: false, video: true });
    expect(seen).toHaveBeenLastCalledWith({
      ...DEFAULT_SETTINGS,
      enabled: false,
      // A write in the old shape, from a context that has not updated yet: the
      // one slider it carries becomes both of ours.
      audioStrength: 90,
      videoStrength: 90,
      audio: false,
      video: true,
    });
  });

  it('ignores changes from other storage areas and other keys', async () => {
    const seen = vi.fn();
    store.subscribe(seen);
    storage.emitExternal({ audioStrength: 10 }, 'local');
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
