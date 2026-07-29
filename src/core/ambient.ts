/**
 * Ambient light: turning an illuminance reading into "is the room dark?".
 *
 * Why this is best effort rather than the primary mechanism: the Generic Sensor
 * API's `AmbientLightSensor` is implemented in Chromium but is not exposed to
 * pages unless `chrome://flags/#enable-generic-sensor-extra-classes` is on, and
 * a machine without a light sensor cannot answer at all. So the sensor is used
 * when it works and the clock is used when it does not — see `core/gate.ts`.
 *
 * Where the reading lives: the sensor is a property of the *room*, not of a tab,
 * and only a top-level frame can read it. So one frame publishes to
 * `chrome.storage.session` and every other frame, in every tab, picks it up
 * through the same `onChanged` channel the settings already use. Session storage
 * is memory-only: the reading never reaches disk and is gone when Chrome exits.
 */
import type { ChangeEmitterLike, ChangeListener, StorageAreaLike } from './settings';

export const AMBIENT_KEY = 'ambient';

/**
 * Thresholds, with a gap between them so a reading hovering at the boundary
 * cannot flip the whole extension on and off every second.
 *
 * For scale: full daylight is tens of thousands of lux, an office is 300-500, a
 * living room with the lamps on is 50-150, and a room lit only by the screen you
 * are watching is single digits. 30 lux is therefore "the lights are off"; 60 is
 * "something is switched on".
 */
export const DARK_LUX = 30;
export const BRIGHT_LUX = 60;

/**
 * How long a reading stays usable. Session storage is already cleared when the
 * browser exits, so this only guards the case where the last sensor reading is
 * genuinely old — a laptop closed overnight and reopened in the morning — where
 * falling back to the clock is better than trusting yesterday's darkness.
 */
export const AMBIENT_MAX_AGE_MS = 6 * 60 * 60_000;

/** Publishing throttle: see `shouldPublish`. */
export const AMBIENT_MIN_GAP_MS = 10_000;
export const AMBIENT_MIN_DELTA_LUX = 5;

export interface AmbientReading {
  /** Illuminance in lux. */
  lux: number;
  /** `Date.now()` when the reading was taken. */
  at: number;
}

export type Darkness = 'dark' | 'bright' | 'unknown';

/** Coerce a stored value into a reading, or null when it is unusable. */
export function sanitizeReading(raw: unknown): AmbientReading | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { lux, at } = raw as Partial<AmbientReading>;
  if (typeof lux !== 'number' || !Number.isFinite(lux) || lux < 0) return null;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
  return { lux, at };
}

/**
 * Classify a lux value, with hysteresis: between the two thresholds the previous
 * verdict is kept, so only a real change in the room changes the answer. With no
 * previous verdict the midpoint decides.
 */
export function classifyLux(lux: number, previous: Darkness = 'unknown'): Darkness {
  if (!Number.isFinite(lux) || lux < 0) return 'unknown';
  if (lux <= DARK_LUX) return 'dark';
  if (lux >= BRIGHT_LUX) return 'bright';
  if (previous !== 'unknown') return previous;
  return lux <= (DARK_LUX + BRIGHT_LUX) / 2 ? 'dark' : 'bright';
}

/** Classify a stored reading, treating a stale one as no reading at all. */
export function readingDarkness(
  reading: AmbientReading | null,
  now = Date.now(),
  previous: Darkness = 'unknown',
): Darkness {
  if (!reading) return 'unknown';
  if (now - reading.at > AMBIENT_MAX_AGE_MS) return 'unknown';
  return classifyLux(reading.lux, previous);
}

/**
 * Should this reading be published?
 *
 * The sensor fires about once a second, and every publish fans out to every
 * frame in every tab. A verdict change always goes out immediately; otherwise a
 * reading has to be both meaningfully different and not too soon after the last
 * one. The effect is that a steady room publishes nothing at all, and the lux
 * figure the popup shows still tracks a room whose light is genuinely changing.
 */
export function shouldPublish(
  previous: AmbientReading | null,
  next: AmbientReading,
  previousDarkness: Darkness,
  nextDarkness: Darkness,
): boolean {
  if (!previous) return true;
  if (nextDarkness !== previousDarkness) return true;
  if (next.at - previous.at < AMBIENT_MIN_GAP_MS) return false;
  return Math.abs(next.lux - previous.lux) >= AMBIENT_MIN_DELTA_LUX;
}

/** Short label for the popup, e.g. `"3 lux"`. */
export function describeLux(lux: number): string {
  if (!Number.isFinite(lux) || lux < 0) return 'unknown';
  const rounded = lux < 10 ? Math.round(lux * 10) / 10 : Math.round(lux);
  return `${rounded} lux`;
}

/**
 * Shared access to the latest reading.
 *
 * Deliberately the same shape as `SettingsStore` (injected area and emitter, so
 * tests can supply fakes) but pointed at `storage.session`.
 */
export class AmbientStore {
  constructor(
    private readonly area: StorageAreaLike,
    private readonly emitter: ChangeEmitterLike | null = null,
    private readonly areaName = 'session',
  ) {}

  async load(): Promise<AmbientReading | null> {
    try {
      const stored = await this.area.get(AMBIENT_KEY);
      return sanitizeReading(stored?.[AMBIENT_KEY]);
    } catch {
      // A content script can only read session storage once the service worker
      // has widened its access level, and the worker may still be asleep.
      // "No reading" is a correct answer, and the clock takes over.
      return null;
    }
  }

  /** Returns false when the write could not be made, which is not an error. */
  async save(reading: AmbientReading): Promise<boolean> {
    try {
      await this.area.set({ [AMBIENT_KEY]: reading });
      return true;
    } catch {
      return false;
    }
  }

  subscribe(callback: (reading: AmbientReading | null) => void): () => void {
    if (!this.emitter) return () => {};
    const listener: ChangeListener = (changes, areaName) => {
      if (areaName !== this.areaName) return;
      const change = changes[AMBIENT_KEY];
      if (!change) return;
      callback(sanitizeReading(change.newValue));
    };
    this.emitter.addListener(listener);
    return () => this.emitter?.removeListener(listener);
  }
}

/**
 * Build the production store, or null when session storage is unreachable (in
 * which case every frame falls back to the clock).
 */
export function createChromeAmbientStore(): AmbientStore | null {
  const api = typeof chrome !== 'undefined' ? chrome : undefined;
  const session = (api?.storage as { session?: unknown } | undefined)?.session as
    | StorageAreaLike
    | undefined;
  if (!session) return null;

  const emitter = api?.storage?.onChanged
    ? {
        addListener: (listener: ChangeListener) => api.storage.onChanged.addListener(listener),
        removeListener: (listener: ChangeListener) =>
          api.storage.onChanged.removeListener(listener),
      }
    : null;

  return new AmbientStore(session, emitter, 'session');
}
