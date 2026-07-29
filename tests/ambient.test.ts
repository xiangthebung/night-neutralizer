import { beforeEach, describe, expect, it } from 'vitest';
import {
  AMBIENT_KEY,
  AMBIENT_MAX_AGE_MS,
  AMBIENT_MIN_DELTA_LUX,
  AMBIENT_MIN_GAP_MS,
  AmbientStore,
  BRIGHT_LUX,
  DARK_LUX,
  classifyLux,
  describeLux,
  readingDarkness,
  sanitizeReading,
  shouldPublish,
  type AmbientReading,
  type Darkness,
} from '../src/core/ambient';
import type { ChangeListener } from '../src/core/settings';

class FakeSession {
  data = new Map<string, unknown>();
  writable = true;
  readable = true;
  private listeners = new Set<ChangeListener>();

  area = {
    get: async (keys: string | string[] | null) => {
      // A content script cannot touch session storage until the service worker
      // has widened the access level; before that, reads throw.
      if (!this.readable) throw new Error('access to storage is not allowed');
      const list = keys === null ? [...this.data.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) if (this.data.has(key)) out[key] = this.data.get(key);
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      if (!this.writable) throw new Error('access to storage is not allowed');
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: this.data.get(key), newValue: value };
        this.data.set(key, value);
      }
      for (const listener of this.listeners) listener(changes, 'session');
    },
  };

  emitter = {
    addListener: (listener: ChangeListener) => this.listeners.add(listener),
    removeListener: (listener: ChangeListener) => this.listeners.delete(listener),
  };

  get listenerCount(): number {
    return this.listeners.size;
  }

  emit(value: unknown, areaName = 'session'): void {
    for (const listener of this.listeners) {
      listener({ [AMBIENT_KEY]: { newValue: value } }, areaName);
    }
  }
}

describe('sanitizeReading', () => {
  it('accepts a well-formed reading', () => {
    expect(sanitizeReading({ lux: 12.5, at: 1000 })).toEqual({ lux: 12.5, at: 1000 });
  });

  it('rejects anything else', () => {
    expect(sanitizeReading(undefined)).toBeNull();
    expect(sanitizeReading(null)).toBeNull();
    expect(sanitizeReading(42)).toBeNull();
    expect(sanitizeReading({ lux: 12 })).toBeNull();
    expect(sanitizeReading({ at: 1000 })).toBeNull();
    expect(sanitizeReading({ lux: -1, at: 1000 })).toBeNull();
    expect(sanitizeReading({ lux: Number.NaN, at: 1000 })).toBeNull();
    expect(sanitizeReading({ lux: 12, at: 0 })).toBeNull();
    expect(sanitizeReading({ lux: '12', at: 1000 })).toBeNull();
  });
});

describe('classifyLux', () => {
  it('calls a dark room dark and a lit one bright', () => {
    expect(classifyLux(0)).toBe('dark');
    expect(classifyLux(DARK_LUX)).toBe('dark');
    expect(classifyLux(BRIGHT_LUX)).toBe('bright');
    expect(classifyLux(400)).toBe('bright');
  });

  it('keeps the previous verdict in the gap between the thresholds', () => {
    // Without this, a reading hovering near the threshold would switch the whole
    // extension on and off once a second.
    const middle = (DARK_LUX + BRIGHT_LUX) / 2 + 1;
    expect(classifyLux(middle, 'dark')).toBe('dark');
    expect(classifyLux(middle, 'bright')).toBe('bright');
    const low = DARK_LUX + 1;
    expect(classifyLux(low, 'bright')).toBe('bright');
    expect(classifyLux(low, 'dark')).toBe('dark');
  });

  it('decides at the midpoint when there is no previous verdict', () => {
    expect(classifyLux(DARK_LUX + 1)).toBe('dark');
    expect(classifyLux(BRIGHT_LUX - 1)).toBe('bright');
  });

  it('refuses to guess from a nonsense value', () => {
    expect(classifyLux(Number.NaN)).toBe('unknown');
    expect(classifyLux(-5)).toBe('unknown');
    expect(classifyLux(Number.POSITIVE_INFINITY)).toBe('unknown');
  });
});

describe('readingDarkness', () => {
  const now = 1_000_000_000;

  it('is unknown without a reading, so the clock takes over', () => {
    expect(readingDarkness(null, now)).toBe('unknown');
  });

  it('uses a fresh reading', () => {
    expect(readingDarkness({ lux: 2, at: now - 1000 }, now)).toBe('dark');
    expect(readingDarkness({ lux: 300, at: now - 1000 }, now)).toBe('bright');
  });

  it('discards a reading old enough to be from another day', () => {
    const stale = { lux: 2, at: now - AMBIENT_MAX_AGE_MS - 1 };
    expect(readingDarkness(stale, now)).toBe('unknown');
    expect(readingDarkness({ lux: 2, at: now - AMBIENT_MAX_AGE_MS }, now)).toBe('dark');
  });

  it('passes the previous verdict through for hysteresis', () => {
    const between = { lux: (DARK_LUX + BRIGHT_LUX) / 2 + 1, at: now };
    expect(readingDarkness(between, now, 'dark')).toBe('dark');
    expect(readingDarkness(between, now, 'bright')).toBe('bright');
  });
});

describe('shouldPublish', () => {
  const base: AmbientReading = { lux: 10, at: 1_000_000 };
  const dark: Darkness = 'dark';

  it('always publishes the first reading', () => {
    expect(shouldPublish(null, base, 'unknown', 'dark')).toBe(true);
  });

  it('publishes a verdict change immediately', () => {
    const next = { lux: 400, at: base.at + 1000 };
    expect(shouldPublish(base, next, dark, 'bright')).toBe(true);
  });

  it('stays quiet in a steady room', () => {
    // The sensor fires about once a second and every publish fans out to every
    // frame in every tab, so an unchanging room must cost nothing.
    const next = { lux: 10.2, at: base.at + AMBIENT_MIN_GAP_MS * 2 };
    expect(shouldPublish(base, next, dark, dark)).toBe(false);
  });

  it('holds back a real change that arrives too soon', () => {
    const next = { lux: base.lux + AMBIENT_MIN_DELTA_LUX, at: base.at + AMBIENT_MIN_GAP_MS - 1 };
    expect(shouldPublish(base, next, dark, dark)).toBe(false);
  });

  it('publishes a real change once the gap has passed', () => {
    const next = { lux: base.lux + AMBIENT_MIN_DELTA_LUX, at: base.at + AMBIENT_MIN_GAP_MS };
    expect(shouldPublish(base, next, dark, dark)).toBe(true);
    const dimmer = { lux: base.lux - AMBIENT_MIN_DELTA_LUX, at: next.at };
    expect(shouldPublish(base, dimmer, dark, dark)).toBe(true);
  });
});

describe('describeLux', () => {
  it('keeps one decimal only where it matters', () => {
    expect(describeLux(0)).toBe('0 lux');
    expect(describeLux(3.42)).toBe('3.4 lux');
    expect(describeLux(120.6)).toBe('121 lux');
    expect(describeLux(Number.NaN)).toBe('unknown');
  });
});

describe('AmbientStore', () => {
  let session: FakeSession;
  let store: AmbientStore;

  beforeEach(() => {
    session = new FakeSession();
    store = new AmbientStore(session.area, session.emitter, 'session');
  });

  it('round-trips a reading', async () => {
    await expect(store.save({ lux: 4, at: 99 })).resolves.toBe(true);
    await expect(store.load()).resolves.toEqual({ lux: 4, at: 99 });
  });

  it('has nothing to report before anything is written', async () => {
    await expect(store.load()).resolves.toBeNull();
  });

  it('reports a failed write instead of throwing', async () => {
    // This is the normal case in a content script whose service worker has not
    // widened the session access level yet.
    session.writable = false;
    await expect(store.save({ lux: 4, at: 99 })).resolves.toBe(false);
  });

  it('treats an unreadable area as no reading', async () => {
    session.readable = false;
    await expect(store.load()).resolves.toBeNull();
  });

  it('sanitizes on the way out', async () => {
    session.data.set(AMBIENT_KEY, { lux: 'bright', at: 1 });
    await expect(store.load()).resolves.toBeNull();
  });

  it('notifies subscribers of a reading published by another frame', async () => {
    const seen: Array<AmbientReading | null> = [];
    const unsubscribe = store.subscribe((reading) => seen.push(reading));
    await store.save({ lux: 7, at: 1234 });
    expect(seen).toEqual([{ lux: 7, at: 1234 }]);

    unsubscribe();
    expect(session.listenerCount).toBe(0);
    await store.save({ lux: 8, at: 2345 });
    expect(seen).toHaveLength(1);
  });

  it('ignores changes from other storage areas', () => {
    const seen: Array<AmbientReading | null> = [];
    store.subscribe((reading) => seen.push(reading));
    session.emit({ lux: 7, at: 1 }, 'sync');
    expect(seen).toEqual([]);
  });

  it('reports a cleared key as no reading', () => {
    const seen: Array<AmbientReading | null> = [];
    store.subscribe((reading) => seen.push(reading));
    session.emit(undefined);
    expect(seen).toEqual([null]);
  });
});
