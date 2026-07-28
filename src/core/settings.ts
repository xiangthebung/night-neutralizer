/**
 * Settings persistence.
 *
 * A single storage key holds the whole settings object, which makes change
 * notification trivial (one key to watch) and keeps writes atomic. The store
 * is constructed around narrow interfaces so tests can supply a fake area
 * instead of a Chrome global.
 */
import { DEFAULT_SETTINGS, SETTINGS_KEY, type Settings } from './types';
import { clamp } from './math';

export interface StorageAreaLike {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export type StorageChange = { oldValue?: unknown; newValue?: unknown };
export type ChangeListener = (
  changes: Record<string, StorageChange>,
  areaName: string,
) => void;

export interface ChangeEmitterLike {
  addListener(listener: ChangeListener): void;
  removeListener(listener: ChangeListener): void;
}

/** Coerce anything (including malformed stored data) into valid settings. */
export function sanitizeSettings(raw: unknown): Settings {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Settings>;
  const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback;
  const strengthRaw = typeof source.strength === 'number' ? source.strength : Number.NaN;
  const strength = Number.isFinite(strengthRaw)
    ? Math.round(clamp(strengthRaw, 0, 100))
    : DEFAULT_SETTINGS.strength;

  return {
    enabled: bool(source.enabled, DEFAULT_SETTINGS.enabled),
    strength,
    audio: bool(source.audio, DEFAULT_SETTINGS.audio),
    video: bool(source.video, DEFAULT_SETTINGS.video),
  };
}

export function settingsEqual(a: Settings, b: Settings): boolean {
  return (
    a.enabled === b.enabled &&
    a.strength === b.strength &&
    a.audio === b.audio &&
    a.video === b.video
  );
}

export class SettingsStore {
  private readonly area: StorageAreaLike;
  private readonly emitter: ChangeEmitterLike | null;
  private readonly areaName: string;

  constructor(area: StorageAreaLike, emitter: ChangeEmitterLike | null = null, areaName = 'sync') {
    this.area = area;
    this.emitter = emitter;
    this.areaName = areaName;
  }

  async load(): Promise<Settings> {
    try {
      const stored = await this.area.get(SETTINGS_KEY);
      return sanitizeSettings(stored?.[SETTINGS_KEY]);
    } catch {
      // Storage can fail if the extension context was invalidated (reload,
      // update). Falling back to defaults keeps the page usable.
      return { ...DEFAULT_SETTINGS };
    }
  }

  /** Merge a patch into the stored settings and return the result. */
  async save(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.load();
    const next = sanitizeSettings({ ...current, ...patch });
    await this.area.set({ [SETTINGS_KEY]: next });
    return next;
  }

  async reset(): Promise<Settings> {
    const next = { ...DEFAULT_SETTINGS };
    await this.area.set({ [SETTINGS_KEY]: next });
    return next;
  }

  /** Write defaults only for values that were never stored. */
  async ensureDefaults(): Promise<Settings> {
    const stored = await this.area.get(SETTINGS_KEY);
    if (stored && typeof stored[SETTINGS_KEY] === 'object' && stored[SETTINGS_KEY] !== null) {
      return sanitizeSettings(stored[SETTINGS_KEY]);
    }
    return this.reset();
  }

  /**
   * Subscribe to external changes. Returns an unsubscribe function so callers
   * never have to keep the listener reference around (this is what prevents
   * duplicate listeners after SPA navigation).
   */
  subscribe(callback: (settings: Settings) => void): () => void {
    if (!this.emitter) return () => {};
    const listener: ChangeListener = (changes, areaName) => {
      if (areaName !== this.areaName) return;
      const change = changes[SETTINGS_KEY];
      if (!change) return;
      callback(sanitizeSettings(change.newValue));
    };
    this.emitter.addListener(listener);
    return () => this.emitter?.removeListener(listener);
  }
}

/**
 * Build the production store from the Chrome APIs.
 *
 * `storage.sync` is preferred so preferences follow the user between devices;
 * it degrades to `storage.local` when sync is unavailable (for example when
 * the browser is running without a signed-in profile).
 */
export function createChromeSettingsStore(): SettingsStore {
  const api = typeof chrome !== 'undefined' ? chrome : undefined;
  const sync = api?.storage?.sync;
  const local = api?.storage?.local;
  const area = (sync ?? local) as unknown as StorageAreaLike | undefined;
  const areaName = sync ? 'sync' : 'local';

  if (!area) {
    // Memory-only fallback: keeps the code path alive in odd contexts instead
    // of throwing inside a content script.
    const memory = new Map<string, unknown>();
    const fallback: StorageAreaLike = {
      async get(keys) {
        const list = keys === null ? [...memory.keys()] : Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const key of list) if (memory.has(key)) out[key] = memory.get(key);
        return out;
      },
      async set(items) {
        for (const [key, value] of Object.entries(items)) memory.set(key, value);
      },
    };
    return new SettingsStore(fallback, null, 'memory');
  }

  const emitter = api?.storage?.onChanged
    ? {
        addListener: (listener: ChangeListener) => api.storage.onChanged.addListener(listener),
        removeListener: (listener: ChangeListener) =>
          api.storage.onChanged.removeListener(listener),
      }
    : null;

  return new SettingsStore(area, emitter, areaName);
}
