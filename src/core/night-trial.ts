/**
 * "Try it now": the night gate switched off for this browser session only.
 *
 * The welcome page opens on install, which is usually in daylight, and with
 * the shipped defaults nothing then happens until 21:00. That is the dead end
 * this exists to remove: one tap switches *Only at night* off, and a flag in
 * `chrome.storage.local` records that it was switched off for a look rather
 * than for good. The service worker's `onStartup` — which fires once per
 * browser session — reads the flag, puts the night restriction back, and
 * clears it. So the trial lasts until Chrome is next started, and the default
 * the user was shown on the welcome page is the default they wake up with.
 *
 * `storage.local` rather than `storage.session`, because the session area is
 * gone by the time `onStartup` runs: it is exactly the record that has to
 * outlive the session it describes. And `local` rather than `sync`, because
 * a trial is about this browser, not every browser the user is signed into.
 *
 * Anyone who changes *Only at night* by hand in the meantime has made a real
 * decision, and the popup clears the flag when they do, so a restart does not
 * overrule them.
 */
import type { SettingsStore, StorageAreaLike } from './settings';

export const NIGHT_TRIAL_KEY = 'nightTrial';

export interface NightTrialStores {
  /** Where the flag lives: `chrome.storage.local`. */
  local: StorageAreaLike;
  settings: SettingsStore;
}

/** True while the night restriction is off for a look rather than for good. */
export async function isNightTrialActive(local: StorageAreaLike): Promise<boolean> {
  try {
    const stored = await local.get(NIGHT_TRIAL_KEY);
    return stored?.[NIGHT_TRIAL_KEY] === true;
  } catch {
    return false;
  }
}

/**
 * Switch the night restriction off until the browser restarts.
 *
 * A no-op when it is already off by choice: there is nothing to restore then,
 * and writing the flag would put it back on at the next start over the user's
 * own setting.
 */
export async function startNightTrial(stores: NightTrialStores): Promise<void> {
  const current = await stores.settings.load();
  if (!current.nightOnly) return;
  await stores.settings.save({ nightOnly: false });
  await stores.local.set({ [NIGHT_TRIAL_KEY]: true });
}

/** Forget the trial without changing any setting: the user decided for themselves. */
export async function clearNightTrial(local: StorageAreaLike): Promise<void> {
  try {
    await local.set({ [NIGHT_TRIAL_KEY]: false });
  } catch {
    /* nothing to clear, or storage unavailable: either way there is no trial */
  }
}

/**
 * At browser start: if a trial was running, put the restriction back.
 * Returns true when it did.
 */
export async function restoreAfterNightTrial(stores: NightTrialStores): Promise<boolean> {
  if (!(await isNightTrialActive(stores.local))) return false;
  await stores.settings.save({ nightOnly: true });
  await clearNightTrial(stores.local);
  return true;
}
