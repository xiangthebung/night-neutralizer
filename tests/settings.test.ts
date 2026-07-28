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

  it('drops unknown keys', () => {
    expect(sanitizeSettings({ enabled: false, evil: 'payload' })).toEqual({
      ...DEFAULT_SETTINGS,
      enabled: false,
    });
  });
});

describe('settingsEqual', () => {
  it('compares by value', () => {
    expect(settingsEqual({ ...DEFAULT_SETTINGS }, { ...DEFAULT_SETTINGS })).toBe(true);
    expect(settingsEqual({ ...DEFAULT_SETTINGS }, { ...DEFAULT_SETTINGS, strength: 10 })).toBe(
      false,
    );
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
      enabled: false,
      strength: 12,
      audio: true,
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
      enabled: false,
      strength: 90,
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
