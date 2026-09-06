/**
 * "Try it now" switches the night restriction off for one browser session,
 * and the restart is what puts it back. Both halves are cheap to get wrong in
 * a way nobody notices for a day: a trial that never ends leaves the extension
 * running through every afternoon, and one that ends over the user's own
 * decision switches on a setting they turned off on purpose.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  NIGHT_TRIAL_KEY,
  clearNightTrial,
  isNightTrialActive,
  restoreAfterNightTrial,
  startNightTrial,
} from '../src/core/night-trial';
import { SettingsStore, type StorageAreaLike } from '../src/core/settings';
import { SETTINGS_KEY } from '../src/core/types';

function area(): StorageAreaLike & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys) {
      const list = keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) if (data.has(key)) out[key] = data.get(key);
      return out;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
  };
}

let local: ReturnType<typeof area>;
let sync: ReturnType<typeof area>;
let settings: SettingsStore;

beforeEach(() => {
  local = area();
  sync = area();
  settings = new SettingsStore(sync, null, 'sync');
});

describe('the night trial', () => {
  it('switches the restriction off and remembers that it did', async () => {
    await startNightTrial({ local, settings });
    expect((await settings.load()).nightOnly).toBe(false);
    expect(await isNightTrialActive(local)).toBe(true);
    expect(local.data.get(NIGHT_TRIAL_KEY)).toBe(true);
  });

  it('is put back by the next browser start, once', async () => {
    await startNightTrial({ local, settings });
    expect(await restoreAfterNightTrial({ local, settings })).toBe(true);
    expect((await settings.load()).nightOnly).toBe(true);
    expect(await isNightTrialActive(local)).toBe(false);
    // A second start finds nothing to do and touches nothing.
    await settings.save({ nightOnly: false });
    expect(await restoreAfterNightTrial({ local, settings })).toBe(false);
    expect((await settings.load()).nightOnly).toBe(false);
  });

  it('does nothing when the restriction was already off by choice', async () => {
    // Otherwise a restart would switch on a setting the user turned off.
    await settings.save({ nightOnly: false });
    await startNightTrial({ local, settings });
    expect(await isNightTrialActive(local)).toBe(false);
    expect(await restoreAfterNightTrial({ local, settings })).toBe(false);
    expect((await settings.load()).nightOnly).toBe(false);
  });

  it('is forgotten when the user decides for themselves', async () => {
    await startNightTrial({ local, settings });
    await clearNightTrial(local);
    expect(await isNightTrialActive(local)).toBe(false);
    // The popup wrote the switch; a restart must leave it where they put it.
    await settings.save({ nightOnly: false });
    expect(await restoreAfterNightTrial({ local, settings })).toBe(false);
    expect((await settings.load()).nightOnly).toBe(false);
  });

  it('treats an unreadable flag as no trial', async () => {
    const broken: StorageAreaLike = {
      get: async () => {
        throw new Error('storage unavailable');
      },
      set: async () => {
        throw new Error('storage unavailable');
      },
    };
    expect(await isNightTrialActive(broken)).toBe(false);
    await expect(clearNightTrial(broken)).resolves.toBeUndefined();
    expect(sync.data.has(SETTINGS_KEY)).toBe(false);
  });
});
