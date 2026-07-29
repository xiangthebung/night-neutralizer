/**
 * The one place that decides whether a frame processes anything.
 *
 * Before this module the answer was a single expression in the content script
 * (`enabled && !siteDisabled`). Adding "and it has to be dark" and "and the
 * clock has to agree" to an inline boolean would have left the popup, the badge
 * and the engines each deriving the same answer separately, so the decision and
 * its explanation are produced together, here, and everything else displays what
 * this returns.
 *
 * Order of precedence, most decisive first:
 *
 *  1. the master switch;
 *  2. the per-site exclusion list;
 *  3. the night restriction, if it is switched on:
 *     a. an ambient light sensor reading, when one is available;
 *     b. otherwise the configured window on the local clock.
 *
 * The sensor wins over the clock because it is a better answer to the actual
 * question. A room with the blinds down at 4 p.m. is exactly the situation this
 * extension is for, and a lit room at 11 p.m. is exactly when it is not needed.
 * The clock is the fallback because Chrome does not expose the sensor by default.
 */
import type { GateReason, GateSource, Settings } from './types';
import type { Darkness } from './ambient';
import { isSiteDisabled } from './site';
import { isWithinWindow, msUntilWindowChange } from './schedule';

export interface GateInput {
  settings: Settings;
  /** Site keys for this frame, from `siteKeys()`. */
  siteKeys: readonly string[];
  /** Ambient verdict; `'unknown'` when there is no usable sensor reading. */
  darkness: Darkness;
  /** Local wall-clock minutes since midnight. */
  nowMinutes: number;
}

export interface GateResult {
  active: boolean;
  reason: GateReason;
  source: GateSource;
}

const ACTIVE_NO_GATE: GateResult = { active: true, reason: 'active', source: 'none' };

export function evaluateGate(input: GateInput): GateResult {
  const { settings, siteKeys, darkness, nowMinutes } = input;

  if (!settings.enabled) return { active: false, reason: 'off', source: 'none' };
  if (isSiteDisabled(settings.disabledSites, siteKeys)) {
    return { active: false, reason: 'site', source: 'none' };
  }
  if (!settings.nightOnly) return ACTIVE_NO_GATE;

  if (darkness !== 'unknown') {
    return darkness === 'dark'
      ? { active: true, reason: 'active', source: 'sensor' }
      : { active: false, reason: 'daylight', source: 'sensor' };
  }

  return isWithinWindow(nowMinutes, settings.nightStart, settings.nightEnd)
    ? { active: true, reason: 'active', source: 'clock' }
    : { active: false, reason: 'daytime', source: 'clock' };
}

/**
 * Longest a caller may sleep before re-evaluating the clock. Boundaries are
 * computed against the current UTC offset, so a DST change or a corrected system
 * clock would otherwise be noticed a whole hour late; waking up every ten
 * minutes at worst bounds that to ten minutes, at a cost of nothing measurable.
 */
export const GATE_RECHECK_CAP_MS = 600_000;

/**
 * When to re-evaluate the gate, in milliseconds, or 0 when no timer is needed.
 *
 * Only the clock path needs waking up: settings changes and sensor readings
 * both arrive as events.
 */
export function gateRecheckDelayMs(
  settings: Settings,
  now: Date,
  capMs = GATE_RECHECK_CAP_MS,
): number {
  if (!settings.enabled || !settings.nightOnly) return 0;
  const untilBoundary = msUntilWindowChange(now, settings.nightStart, settings.nightEnd);
  // The floor keeps a boundary that has just passed from spinning the timer.
  return Math.max(1000, Math.min(capMs, untilBoundary));
}
