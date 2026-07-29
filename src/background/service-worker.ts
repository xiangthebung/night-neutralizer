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
import { SETTINGS_KEY, type FrameStatus, type GateReason } from '../core/types';
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

/**
 * Let content scripts read and write session storage.
 *
 * This is what lets one ambient light reading be shared by every frame in every
 * tab (see `core/ambient.ts`): the frame that can read the sensor writes it, and
 * the rest pick it up through `storage.onChanged`, with no extra messaging and no
 * broadcast loop over tabs.
 *
 * What it widens: the session area also holds the per-frame status map, whose
 * only page-derived content is bare hostnames. Content scripts run in an
 * isolated world, so page JavaScript cannot reach any of it, and the data never
 * leaves the extension or touches disk. The access level is per browser session,
 * so it is set from the top level of this script, which runs on every wake rather
 * than only at install.
 */
function openSessionToContentScripts(): void {
  const area = sessionArea() as
    | (chrome.storage.StorageArea & {
        setAccessLevel?: (options: { accessLevel: string }) => Promise<void>;
      })
    | null;
  if (!area?.setAccessLevel) return;
  void area
    .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
    .catch((error) => debug('could not open session storage to content scripts', error));
}

openSessionToContentScripts();

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

/* ------------------------- toolbar state feedback ------------------------- */

/**
 * The toolbar icon is the only feedback the keyboard shortcut can give.
 * Alt+Shift+N used to flip the setting silently: on a tab with no video, or
 * with video processing already off, nothing observable happened at all and you
 * could not tell whether the press had registered.
 *
 * So: an "off" badge plus a dimmed icon when the master switch is off, and
 * "site" on tabs whose host is excluded. Both `action.setBadgeText` and
 * `action.setIcon` are part of the `action` manifest key and need no permission.
 */
const ICON_SIZES = [16, 32, 48, 128] as const;

function iconPaths(off: boolean): Record<number, string> {
  const paths: Record<number, string> = {};
  for (const size of ICON_SIZES) {
    paths[size] = off ? `icons/icon-off-${size}.png` : `icons/icon-${size}.png`;
  }
  return paths;
}

/**
 * Badge text for a tab, most decisive state first: a global off, then a per-site
 * exclusion, then waiting for night.
 *
 * `day` matters more than it looks. With the night restriction on, the extension
 * spends most of the day doing nothing on purpose, and without a badge that is
 * indistinguishable from being broken.
 */
function badgeFor(enabled: boolean, siteDisabled: boolean, reason: GateReason = 'active'): string {
  if (!enabled) return 'off';
  if (siteDisabled) return 'site';
  if (reason === 'daylight' || reason === 'daytime') return 'day';
  return '';
}

async function paintAction(enabled: boolean, tabId?: number): Promise<void> {
  const action = chrome.action;
  if (!action) return;
  try {
    // A dimmed icon is global; per-tab badges are layered on top of it.
    await action.setIcon({ path: iconPaths(!enabled) });
    await action.setBadgeBackgroundColor({ color: enabled ? '#4a3a1e' : '#3a2222' });
    await action.setBadgeTextColor?.({ color: '#f2e6cf' });
    await action.setTitle({
      title: enabled
        ? 'Night Neutralizer'
        : 'Night Neutralizer — off (Alt+Shift+N to switch back on)',
    });
    if (tabId === undefined) await action.setBadgeText({ text: badgeFor(enabled, false) });
  } catch (error) {
    debug('could not paint the toolbar action', error);
  }
}

/** Per-tab badge, driven by whatever the frames in that tab last reported. */
async function paintTab(
  tabId: number,
  enabled: boolean,
  siteDisabled: boolean,
  reason: GateReason,
): Promise<void> {
  try {
    await chrome.action?.setBadgeText({ tabId, text: badgeFor(enabled, siteDisabled, reason) });
  } catch {
    // The tab can disappear between the report and this call; that is not an
    // error worth logging.
  }
}

async function refreshAction(): Promise<void> {
  const settings = await createChromeSettingsStore().load();

  // Tab-specific badges shadow the global one, so stale overrides have to go
  // before the global text is meaningful again. Passing `null` for a tab clears
  // the override and lets that tab fall back to the global text; the published
  // typings only describe the string form, hence the cast.
  //
  // `tabs.query` returns ids without the `tabs` permission (it withholds urls
  // and titles), which is all this needs.
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map(async (tab) => {
        if (typeof tab.id !== 'number') return;
        await chrome.action
          ?.setBadgeText({ tabId: tab.id, text: null as unknown as string })
          .catch(() => undefined);
      }),
    );
  } catch {
    /* nothing to clear */
  }

  await paintAction(settings.enabled);
}

chrome.runtime.onInstalled.addListener(() => {
  void createChromeSettingsStore()
    .ensureDefaults()
    .then((settings) => paintAction(settings.enabled))
    .catch((error) => debug('could not seed defaults', error));
});

// The worker is torn down when idle, so the badge has to be re-established
// whenever it wakes up rather than only at install time.
chrome.runtime.onStartup?.addListener(() => {
  void refreshAction().catch((error) => debug('could not restore badge', error));
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' && areaName !== 'local') return;
  if (!changes[SETTINGS_KEY]) return;
  void refreshAction().catch((error) => debug('could not update badge', error));
});

void refreshAction().catch(() => undefined);

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
      // Frames report their own view of the settings and of the gate, so the
      // badge can be kept honest from the report itself without another storage
      // read or a duplicate copy of the gate logic here.
      if ((sender.frameId ?? 0) === 0) {
        void paintTab(
          tabId,
          message.status.settings.enabled,
          message.status.siteDisabled,
          message.status.gate.reason,
        );
      }
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
