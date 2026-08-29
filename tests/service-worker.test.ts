/**
 * The service worker, which under MV3 is a process that keeps being killed.
 *
 * That is the whole difficulty. It holds the per-tab status the popup and the
 * badge read, several frames of a page push into it at once, and Chrome may
 * tear it down between any two of those pushes. So the three things checked
 * here are the three that a restart or a race can break:
 *
 *  - **Restart.** `chrome.storage.session` is the source of truth, not the
 *    module's own cache, so a fresh instance of the worker must find the same
 *    records the previous one left. Simulated by importing the module twice
 *    over one surviving fake storage, which is exactly what a wake looks like.
 *  - **Races.** Every update is a read-modify-write, and a page and its
 *    embedded players all report at the same moment. Without serialising them,
 *    a slow frame writes back a copy of the map that predates a fast one and
 *    silently deletes it.
 *  - **Access level.** Content scripts can only read the shared ambient light
 *    reading because the worker widens the session area, and that setting lasts
 *    one browser session — so it has to be re-applied on every wake rather than
 *    only at install, or the sensor stops being shared until the next reinstall.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG, SESSION_STATUS_KEY } from '../src/core/messages';
import { SETTINGS_KEY, type FrameStatus, type Settings } from '../src/core/types';
import { sanitizeSettings } from '../src/core/settings';

type Listener = (...args: unknown[]) => unknown;

/** A storage area with a settable delay, so a slow write can overtake a fast one. */
function area(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial));
  const state = { delayMs: 0, accessLevel: '' };
  return {
    state,
    data,
    async get(keys: string | string[] | null) {
      const wanted = keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of wanted) if (data.has(key)) out[key] = structuredClone(data.get(key));
      if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      return out;
    },
    async set(items: Record<string, unknown>) {
      if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
    async setAccessLevel(options: { accessLevel: string }) {
      state.accessLevel = options.accessLevel;
    },
  };
}

interface Harness {
  session: ReturnType<typeof area>;
  sync: ReturnType<typeof area>;
  badges: { tabId?: number; text: string | null }[];
  icons: string[];
  listeners: Map<string, Listener[]>;
  emit(event: string, ...args: unknown[]): unknown;
}

/** Install a `chrome` global rich enough for the worker to run against. */
function harness(settings: Partial<Settings> = {}): Harness {
  const session = area();
  const sync = area({ [SETTINGS_KEY]: sanitizeSettings(settings) });
  const badges: Harness['badges'] = [];
  const icons: string[] = [];
  const listeners = new Map<string, Listener[]>();

  const on = (event: string) => ({
    addListener: (listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
  });

  const chrome = {
    runtime: { onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message') },
    storage: { session, sync, local: sync, onChanged: on('storage') },
    tabs: {
      query: async () => [{ id: 1 }, { id: 2 }],
      sendMessage: async () => undefined,
      onRemoved: on('tabRemoved'),
    },
    commands: { onCommand: on('command') },
    action: {
      setIcon: async (options: { path: Record<number, string> }) => {
        icons.push(options.path[16] ?? '');
      },
      setBadgeText: async (options: { tabId?: number; text: string | null }) => {
        badges.push({ ...(options.tabId === undefined ? {} : { tabId: options.tabId }), text: options.text });
      },
      setBadgeBackgroundColor: async () => undefined,
      setBadgeTextColor: async () => undefined,
      setTitle: async () => undefined,
    },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = chrome;
  return {
    session,
    sync,
    badges,
    icons,
    listeners,
    emit(event, ...args) {
      let result: unknown;
      for (const listener of listeners.get(event) ?? []) result = listener(...args);
      return result;
    },
  };
}

/**
 * Load a fresh copy of the worker, the way Chrome does on every wake. The cache
 * bust is what makes this a *restart* rather than a second reference to the
 * instance already running.
 */
async function bootWorker(): Promise<void> {
  // `resetModules` is what makes the second call a *restart*: without it the
  // registry hands back the instance that is already running, and none of the
  // top-level wake-up work re-executes.
  vi.resetModules();
  await import('../src/background/service-worker');
  // The module kicks off async work from its top level; let it settle.
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function frame(patch: Partial<FrameStatus> = {}): Omit<FrameStatus, 'frameId'> {
  return {
    at: Date.now(),
    top: true,
    settings: sanitizeSettings({}),
    site: 'example.com',
    siteDisabled: false,
    gate: { active: true, reason: 'active', source: 'clock', lux: null },
    music: { site: false, skipped: 0 },
    mediaElements: 1,
    audio: { state: 'active', processed: 1, skipped: 0 },
    video: { mode: 'adaptive', elements: 1, technique: 'svg-tone-curve' },
    images: { active: true, elements: 3 },
    page: { active: false, dark: 'off' },
    notes: [],
    ...patch,
  } as Omit<FrameStatus, 'frameId'>;
}

const report = (status: Omit<FrameStatus, 'frameId'>) => ({ type: MSG.STATUS_REPORT, status });
const sender = (tabId: number, frameId: number) => ({ tab: { id: tabId }, frameId });

/** The stored map, as the worker leaves it. */
function stored(env: Harness): Record<string, Record<string, FrameStatus>> {
  return (env.session.data.get(SESSION_STATUS_KEY) ?? {}) as Record<
    string,
    Record<string, FrameStatus>
  >;
}

async function settle(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('per-tab session records', () => {
  it('keeps one record per frame, keyed by tab', async () => {
    const env = harness();
    await bootWorker();

    env.emit('message', report(frame()), sender(7, 0), () => {});
    env.emit('message', report(frame({ top: false, site: '' })), sender(7, 3), () => {});
    env.emit('message', report(frame()), sender(9, 0), () => {});
    await settle(5);

    expect(Object.keys(stored(env)).sort()).toEqual(['7', '9']);
    expect(Object.keys(stored(env)['7'] ?? {}).sort()).toEqual(['0', '3']);
    expect(stored(env)['7']?.['3']?.frameId).toBe(3);
  });

  it('does not lose a frame to a slower one writing back a stale map', async () => {
    // The failure this guards: a page and its embedded players report in the
    // same tick, each does read-modify-write, and without a queue the last
    // write wins with a map that never contained the others.
    const env = harness();
    await bootWorker();
    env.session.state.delayMs = 5;

    for (let frameId = 0; frameId < 6; frameId++) {
      env.emit('message', report(frame({ top: frameId === 0 })), sender(4, frameId), () => {});
    }
    await settle(400);

    expect(Object.keys(stored(env)['4'] ?? {}).sort()).toEqual(['0', '1', '2', '3', '4', '5']);
  });

  it('drops the records for a tab when that tab closes', async () => {
    const env = harness();
    await bootWorker();
    env.emit('message', report(frame()), sender(11, 0), () => {});
    await settle(5);
    expect(stored(env)['11']).toBeDefined();

    env.emit('tabRemoved', 11);
    await settle(5);
    expect(stored(env)['11']).toBeUndefined();
  });

  it('bounds the map so a long session cannot accumulate tabs', async () => {
    const env = harness();
    await bootWorker();
    for (let tabId = 0; tabId < 70; tabId++) {
      env.emit('message', report(frame({ at: 1_000 + tabId })), sender(tabId, 0), () => {});
    }
    await settle(60);

    const keys = Object.keys(stored(env));
    expect(keys.length).toBeLessThanOrEqual(60);
    // The stalest go first, so the tabs still being used survive.
    expect(keys).toContain('69');
    expect(keys).not.toContain('0');
  });
});

describe('surviving suspension', () => {
  it('finds the records the previous instance left', async () => {
    const env = harness();
    await bootWorker();
    env.emit('message', report(frame({ site: 'example.com' })), sender(5, 0), () => {});
    await settle(5);

    // Chrome kills the worker; the session area is what outlives it.
    env.listeners.clear();
    await bootWorker();

    let answered: unknown = null;
    const handled = env.emit(
      'message',
      { type: MSG.STATUS_QUERY, tabId: 5 },
      {},
      (response: unknown) => {
        answered = response;
      },
    );
    expect(handled).toBe(true); // the listener must keep the channel open
    await settle(10);

    const status = (answered as { status?: { site?: string; frames?: number } } | null)?.status;
    expect(status?.site).toBe('example.com');
    expect(status?.frames).toBe(1);
  });

  it('re-opens session storage to content scripts on every wake', async () => {
    // The access level lasts one browser session, so doing this at install time
    // only would leave the shared light reading unreadable until a reinstall.
    const env = harness();
    await bootWorker();
    expect(env.session.state.accessLevel).toBe('TRUSTED_AND_UNTRUSTED_CONTEXTS');

    env.session.state.accessLevel = '';
    env.listeners.clear();
    await bootWorker();
    expect(env.session.state.accessLevel).toBe('TRUSTED_AND_UNTRUSTED_CONTEXTS');
  });
});

describe('the toolbar badge', () => {
  const badgeFor = (env: Harness, tabId: number): string | null | undefined =>
    env.badges.filter((entry) => entry.tabId === tabId).at(-1)?.text;

  it('says why a tab is doing nothing, so "off" and "broken" differ', async () => {
    const env = harness();
    await bootWorker();

    env.emit('message', report(frame()), sender(1, 0), () => {});
    env.emit(
      'message',
      report(frame({ settings: sanitizeSettings({ enabled: false }) })),
      sender(2, 0),
      () => {},
    );
    env.emit('message', report(frame({ siteDisabled: true })), sender(3, 0), () => {});
    env.emit(
      'message',
      report(frame({ gate: { active: false, reason: 'daytime', source: 'clock', lux: null } })),
      sender(4, 0),
      () => {},
    );
    env.emit(
      'message',
      report(frame({ gate: { active: false, reason: 'daylight', source: 'sensor', lux: 400 } })),
      sender(5, 0),
      () => {},
    );
    await settle(20);

    expect(badgeFor(env, 1)).toBe('');
    expect(badgeFor(env, 2)).toBe('off');
    expect(badgeFor(env, 3)).toBe('site');
    expect(badgeFor(env, 4)).toBe('day');
    expect(badgeFor(env, 5)).toBe('day');
  });

  it('is painted from the top frame only, so a sub-frame cannot claim the tab', async () => {
    const env = harness();
    await bootWorker();
    env.emit('message', report(frame({ siteDisabled: true })), sender(8, 4), () => {});
    await settle(10);
    expect(badgeFor(env, 8)).toBeUndefined();
  });

  it('clears stale per-tab overrides when the master switch changes', async () => {
    // A per-tab badge shadows the global one, so an override left behind after
    // the extension is switched off keeps saying "site" on a dead setting.
    const env = harness();
    await bootWorker();
    env.badges.length = 0;

    await env.sync.set({ [SETTINGS_KEY]: sanitizeSettings({ enabled: false }) });
    env.emit('storage', { [SETTINGS_KEY]: { newValue: {} } }, 'sync');
    await settle(20);

    const cleared = env.badges.filter((entry) => entry.tabId !== undefined && entry.text === null);
    expect(cleared.map((entry) => entry.tabId).sort()).toEqual([1, 2]);
    expect(env.icons.at(-1)).toMatch(/icon-off-16/);
  });

  it('ignores storage changes from areas that are not settings', async () => {
    const env = harness();
    await bootWorker();
    env.badges.length = 0;
    env.emit('storage', { [SESSION_STATUS_KEY]: { newValue: {} } }, 'session');
    await settle(10);
    expect(env.badges).toEqual([]);
  });
});

describe('the keyboard shortcut', () => {
  it('flips the stored switch, which every frame is already watching', async () => {
    const env = harness({ enabled: true });
    await bootWorker();

    env.emit('command', 'toggle-enabled');
    await settle(20);
    expect((env.sync.data.get(SETTINGS_KEY) as Settings).enabled).toBe(false);

    env.emit('command', 'toggle-enabled');
    await settle(20);
    expect((env.sync.data.get(SETTINGS_KEY) as Settings).enabled).toBe(true);
  });

  it('ignores a command it does not own', async () => {
    const env = harness({ enabled: true });
    await bootWorker();
    env.emit('command', 'something-else');
    await settle(10);
    expect((env.sync.data.get(SETTINGS_KEY) as Settings).enabled).toBe(true);
  });
});
