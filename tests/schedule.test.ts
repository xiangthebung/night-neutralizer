/**
 * The night window is the mechanism most installs will actually run on, since
 * Chrome does not expose the light sensor. Its one genuinely awkward case is the
 * wrap across midnight, which is also the normal case.
 */
import { describe, expect, it } from 'vitest';
import {
  MINUTES_PER_DAY,
  MS_PER_DAY,
  describeClock,
  describeWindow,
  formatClock,
  isWithinWindow,
  minutesOfDay,
  msUntilWindowChange,
  parseClock,
  sanitizeClock,
} from '../src/core/schedule';

const at = (hours: number, minutes = 0): number => hours * 60 + minutes;

/** A local-time instant, so the tests are independent of the machine's zone. */
const localTime = (hours: number, minutes = 0, seconds = 0): Date =>
  new Date(2026, 6, 28, hours, minutes, seconds);

describe('parseClock', () => {
  it('reads what a time input produces', () => {
    expect(parseClock('21:00')).toBe(1260);
    expect(parseClock('00:00')).toBe(0);
    expect(parseClock('07:30')).toBe(450);
    expect(parseClock('9:05')).toBe(545);
  });

  it('rejects anything that is not a time', () => {
    // An empty time input reports an empty string, which must not become midnight.
    expect(parseClock('')).toBeNull();
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('21:60')).toBeNull();
    expect(parseClock('21')).toBeNull();
    expect(parseClock('nine')).toBeNull();
  });
});

describe('formatClock', () => {
  it('zero-pads, which a time input requires', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(450)).toBe('07:30');
    expect(formatClock(1260)).toBe('21:00');
  });

  it('round-trips with parseClock', () => {
    for (let minutes = 0; minutes < MINUTES_PER_DAY; minutes += 7) {
      expect(parseClock(formatClock(minutes))).toBe(minutes);
    }
  });
});

describe('sanitizeClock', () => {
  it('accepts minutes or a clock string', () => {
    expect(sanitizeClock(1260, 0)).toBe(1260);
    expect(sanitizeClock('21:00', 0)).toBe(1260);
  });

  it('falls back for anything unusable', () => {
    expect(sanitizeClock(undefined, 420)).toBe(420);
    expect(sanitizeClock(null, 420)).toBe(420);
    expect(sanitizeClock(Number.NaN, 420)).toBe(420);
    expect(sanitizeClock('half nine', 420)).toBe(420);
    expect(sanitizeClock({}, 420)).toBe(420);
  });

  it('wraps out-of-range values instead of rejecting them', () => {
    expect(sanitizeClock(MINUTES_PER_DAY, 0)).toBe(0);
    expect(sanitizeClock(MINUTES_PER_DAY + 60, 0)).toBe(60);
    expect(sanitizeClock(-60, 0)).toBe(1380);
    expect(sanitizeClock(60.4, 0)).toBe(60);
  });
});

describe('minutesOfDay', () => {
  it('uses local wall-clock time', () => {
    expect(minutesOfDay(localTime(0))).toBe(0);
    expect(minutesOfDay(localTime(21, 30))).toBe(1290);
    expect(minutesOfDay(localTime(23, 59))).toBe(1439);
  });
});

describe('isWithinWindow', () => {
  it('handles a window that wraps midnight', () => {
    const start = at(21);
    const end = at(7);
    expect(isWithinWindow(at(21), start, end)).toBe(true); // start is inclusive
    expect(isWithinWindow(at(23, 59), start, end)).toBe(true);
    expect(isWithinWindow(at(0), start, end)).toBe(true);
    expect(isWithinWindow(at(6, 59), start, end)).toBe(true);
    expect(isWithinWindow(at(7), start, end)).toBe(false); // end is exclusive
    expect(isWithinWindow(at(13), start, end)).toBe(false);
    expect(isWithinWindow(at(20, 59), start, end)).toBe(false);
  });

  it('handles a window inside one day', () => {
    const start = at(13);
    const end = at(17);
    expect(isWithinWindow(at(12, 59), start, end)).toBe(false);
    expect(isWithinWindow(at(13), start, end)).toBe(true);
    expect(isWithinWindow(at(16, 59), start, end)).toBe(true);
    expect(isWithinWindow(at(17), start, end)).toBe(false);
    expect(isWithinWindow(at(23), start, end)).toBe(false);
  });

  it('treats a collapsed window as always, never as never', () => {
    // Zero length is ambiguous, and "never" would switch the extension off
    // globally with nothing in the UI to explain it.
    for (const minutes of [0, at(4), at(12), at(21), at(23, 59)]) {
      expect(isWithinWindow(minutes, at(21), at(21))).toBe(true);
    }
  });
});

describe('msUntilWindowChange', () => {
  const minutes = (ms: number): number => ms / 60_000;

  it('counts to whichever boundary comes first', () => {
    // 22:00, window 21:00-07:00: the close at 07:00 is 9 h away.
    expect(minutes(msUntilWindowChange(localTime(22), at(21), at(7)))).toBe(9 * 60);
    // 06:00: the close is one hour away.
    expect(minutes(msUntilWindowChange(localTime(6), at(21), at(7)))).toBe(60);
    // 12:00: the open at 21:00 is nine hours away.
    expect(minutes(msUntilWindowChange(localTime(12), at(21), at(7)))).toBe(9 * 60);
  });

  it('crosses midnight rather than returning a negative delay', () => {
    const delay = msUntilWindowChange(localTime(23, 30), at(21), at(7));
    expect(delay).toBeGreaterThan(0);
    expect(minutes(delay)).toBe(7 * 60 + 30);
  });

  it('accounts for seconds within the current minute', () => {
    const delay = msUntilWindowChange(localTime(6, 59, 30), at(21), at(7));
    expect(delay).toBe(30_000);
  });

  it('never exceeds a day, and never returns zero on a boundary', () => {
    const onBoundary = msUntilWindowChange(localTime(7), at(21), at(7));
    expect(onBoundary).toBeGreaterThan(0);
    expect(onBoundary).toBeLessThanOrEqual(MS_PER_DAY);
  });
});

describe('describeClock and describeWindow', () => {
  it('follows the locale, so the copy matches what a time input renders', () => {
    expect(describeClock(at(21), 'en-GB')).toBe('21:00');
    expect(describeClock(at(21), 'en-US')).toMatch(/09:00\s?PM/);
    expect(describeWindow(at(21), at(7), 'en-GB')).toBe('21:00 to 07:00');
    expect(describeWindow(at(21), at(7), 'en-US')).toMatch(/09:00\s?PM to 07:00\s?AM/);
  });

  it('falls back to a plain clock string if Intl refuses the locale', () => {
    expect(describeClock(at(7), 'not a locale')).toBe('07:00');
  });
});
