/**
 * Service worker. Two jobs only:
 *
 *  1. seed default settings on install;
 *  2. relay status between content scripts and the popup.
 *
 * The relay exists because a popup cannot receive an unsolicited message from a
 * content script, and messaging a tab directly is not guaranteed without host
 * permissions. Content scripts push their status here (keyed by tab and frame),
 * the popup pulls the aggregate. `chrome.storage.session` keeps the data alive
 * across service-worker restarts and is never written to disk.
 *
 * No network access, no persistent storage of page data, nothing leaves the
 * browser.
 */
import { MSG, SESSION_STATUS_KEY, type ExtensionMessage } from '../core/messages';
import { aggregateStatuses, pruneFrames } from '../core/status';
import { createChromeSettingsStore } from '../core/settings';
import type { FrameStatus } from '../core/types';
import { debug } from '../core/log';

type FrameMap = Record<string, FrameStatus>;
type TabMap = Record<string, FrameMap>;

/** In-memory mirror; `storage.session` is the source of truth across restarts. */
let memoryCache: TabMap | null = null;

/**
 * Status updates are read-modify-write. Frames report independently (a page and
 * its embedded players all push at once), so without serialisation a slower
 * frame can write back a stale copy of another frame's entry.
 */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function sessionArea(): chrome.storage.StorageArea | null {
  return (chrome.storage as { session?: chrome.storage.StorageArea }).session ?? null;
}

async function readAll(): Promise<TabMap> {
  const area = sessionArea();
  if (!area) return memoryCache ?? {};
  try {
    const stored = await area.get(SESSION_STATUS_KEY);
    const value = stored?.[SESSION_STATUS_KEY];
    memoryCache = (typeof value === 'object' && value !== null ? value : {}) as TabMap;
    return memoryCache;
  } catch {
    return memoryCache ?? {};
  }
}

async function writeAll(map: TabMap): Promise<void> {
  memoryCache = map;
  const area = sessionArea();
  if (!area) return;
  try {
    await area.set({ [SESSION_STATUS_KEY]: map });
  } catch (error) {
    debug('could not persist status', error);
  }
}

function recordStatus(
  tabId: number,
  frameId: number,
  status: Omit<FrameStatus, 'frameId'>,
): Promise<void> {
  return enqueue(() => recordStatusLocked(tabId, frameId, status));
}

async function recordStatusLocked(
  tabId: number,
  frameId: number,
  status: Omit<FrameStatus, 'frameId'>,
): Promise<void> {
  const all = await readAll();
  const key = String(tabId);
  const frames = pruneFrames(all[key] ?? {});
  frames[String(frameId)] = { ...status, frameId };
  all[key] = frames;

  // Bound the map: a long browsing session should not accumulate tabs.
  const keys = Object.keys(all);
  if (keys.length > 60) {
    const scored = keys
      .map((k) => {
        const newest = Math.max(0, ...Object.values(all[k] ?? {}).map((f) => f.at));
        return [k, newest] as const;
      })
      .sort((a, b) => a[1] - b[1]);
    for (const [staleKey] of scored.slice(0, keys.length - 60)) delete all[staleKey];
  }

  await writeAll(all);
}

async function queryStatus(tabId: number) {
  // Best effort refresh of the top frame. This is allowed for our own content
  // scripts; if the browser refuses, the pushed snapshot is used instead.
  let fresh: Omit<FrameStatus, 'frameId'> | undefined;
  try {
    fresh = (await chrome.tabs.sendMessage(tabId, { type: MSG.STATUS_REQUEST }, { frameId: 0 })) as
      | Omit<FrameStatus, 'frameId'>
      | undefined;
  } catch {
    /* no content script in this tab, or messaging not permitted */
  }

  if (fresh && typeof fresh.at === 'number') {
    await recordStatus(tabId, 0, fresh);
  }

  return enqueue(async () => {
    const all = await readAll();
    return aggregateStatuses(Object.values(pruneFrames(all[String(tabId)] ?? {})));
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void createChromeSettingsStore()
    .ensureDefaults()
    .catch((error) => debug('could not seed defaults', error));
});

/**
 * Keyboard shortcut (Alt+Shift+N by default, remappable at
 * chrome://extensions/shortcuts). Flipping the stored flag is enough: every
 * content script is already watching that key, so the change applies live.
 * The `commands` manifest key adds no permission warning.
 */
chrome.commands?.onCommand.addListener((command) => {
  if (command !== 'toggle-enabled') return;
  void (async () => {
    const store = createChromeSettingsStore();
    const current = await store.load();
    await store.save({ enabled: !current.enabled });
  })().catch((error) => debug('could not toggle from shortcut', error));
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  if (message?.type === MSG.STATUS_REPORT) {
    const tabId = sender.tab?.id;
    if (typeof tabId === 'number') {
      void recordStatus(tabId, sender.frameId ?? 0, message.status);
    }
    return false;
  }

  if (message?.type === MSG.STATUS_QUERY) {
    void queryStatus(message.tabId).then((status) => sendResponse({ status }));
    return true; // async response
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void enqueue(async () => {
    const all = await readAll();
    if (all[String(tabId)]) {
      delete all[String(tabId)];
      await writeAll(all);
    }
  });
});
