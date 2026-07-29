/**
 * The night window: wall-clock arithmetic, kept pure and unit tested.
 *
 * Times are stored as minutes since local midnight rather than as `"21:00"`
 * strings, so there is exactly one canonical form and comparison is integer
 * arithmetic. The popup converts at the edges, because `<input type="time">`
 * speaks strings.
 *
 * Everything here works in *local* wall-clock time, which is the only thing a
 * user means by "after nine". The consequence is that a DST change or a manual
 * clock adjustment shifts the window by an hour without warning; callers deal
 * with that by capping how long they will sleep between re-evaluations rather
 * than trusting a computed boundary hours in advance.
 */

export const MINUTES_PER_DAY = 1440;
export const MS_PER_DAY = MINUTES_PER_DAY * 60_000;

/** Wrap any integer minute count into `0..1439`. */
function wrap(minutes: number): number {
  return ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/**
 * Coerce stored or typed input into minutes since midnight.
 *
 * Accepts a number of minutes or a `"HH:MM"` string, so a hand-edited storage
 * value and a value straight out of a time input both work. Anything else
 * yields the fallback.
 */
export function sanitizeClock(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return wrap(value);
  if (typeof value === 'string') {
    const parsed = parseClock(value);
    if (parsed !== null) return parsed;
  }
  return wrap(fallback);
}

/** `"21:00"` -> 1260. Returns null for anything that is not a valid time. */
export function parseClock(text: string): number | null {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 1260 -> `"21:00"`. Zero padded, which is what a time input requires. */
export function formatClock(minutes: number): string {
  const value = wrap(minutes);
  const hours = Math.floor(value / 60);
  return `${String(hours).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

/** Local wall-clock minutes since midnight for a given instant. */
export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Is `minutes` inside the window? The window is half-open (`start` inclusive,
 * `end` exclusive) and may wrap midnight, which is the normal case for a night
 * window such as 21:00 to 07:00.
 *
 * A collapsed window (start === end) reads as *always*, not never. Both are
 * defensible readings of a zero-length range, but "never" would switch the
 * whole extension off with nothing in the UI to explain why, and a silent
 * global off is a worse failure than a window that is wider than intended.
 */
export function isWithinWindow(minutes: number, start: number, end: number): boolean {
  const now = wrap(minutes);
  const from = wrap(start);
  const to = wrap(end);
  if (from === to) return true;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/**
 * Milliseconds until the window next opens or closes.
 *
 * Used to schedule a single re-check instead of polling. Callers should cap the
 * result: the boundary is computed from the current local offset, so a clock
 * change between now and then would otherwise be noticed hours late.
 */
export function msUntilWindowChange(now: Date, start: number, end: number): number {
  const elapsed =
    minutesOfDay(now) * 60_000 + now.getSeconds() * 1000 + now.getMilliseconds();
  let best = MS_PER_DAY;
  for (const boundary of [wrap(start), wrap(end)]) {
    let delta = boundary * 60_000 - elapsed;
    if (delta <= 0) delta += MS_PER_DAY;
    if (delta < best) best = delta;
  }
  return best;
}

/**
 * The window as the user's locale would write it, e.g. `"9:00 PM to 7:00 AM"`.
 *
 * Not `formatClock`: a time input renders in the locale's own convention, so a
 * caption in 24-hour time next to a field reading "09:00 PM" describes the same
 * setting twice in two different languages.
 */
export function describeWindow(start: number, end: number, locales?: string | string[]): string {
  return `${describeClock(start, locales)} to ${describeClock(end, locales)}`;
}

/** One time, formatted for display rather than for a time input. */
export function describeClock(minutes: number, locales?: string | string[]): string {
  const value = wrap(minutes);
  const when = new Date(2000, 0, 1, Math.floor(value / 60), value % 60);
  try {
    // `2-digit` rather than `numeric`, because that is what Chrome's own time
    // input renders ("09:00 PM"), and these sit next to each other.
    return new Intl.DateTimeFormat(locales, { hour: '2-digit', minute: '2-digit' }).format(when);
  } catch {
    return formatClock(value);
  }
}
