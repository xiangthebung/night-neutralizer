/**
 * The gate is the one place that answers "should this frame do anything", so
 * every way of switching the extension off has to be checked here, along with
 * the order they take precedence in.
 */
import { describe, expect, it } from 'vitest';
import { GATE_RECHECK_CAP_MS, evaluateGate, gateRecheckDelayMs } from '../src/core/gate';
import { sanitizeSettings } from '../src/core/settings';
import type { Darkness } from '../src/core/ambient';
import type { Settings } from '../src/core/types';

const at = (hours: number, minutes = 0): number => hours * 60 + minutes;
const localTime = (hours: number, minutes = 0): Date => new Date(2026, 6, 28, hours, minutes);

const settings = (patch: Partial<Settings> = {}): Settings => sanitizeSettings(patch);

const gate = (
  patch: Partial<Settings>,
  nowMinutes: number,
  darkness: Darkness = 'unknown',
  siteKeys: string[] = ['example.com'],
) => evaluateGate({ settings: settings(patch), siteKeys, darkness, nowMinutes });

describe('evaluateGate', () => {
  it('processes inside the night window by default', () => {
    // The shipped default is 21:00-07:00 with no sensor available.
    expect(gate({}, at(23))).toEqual({ active: true, reason: 'active', source: 'clock' });
    expect(gate({}, at(3))).toEqual({ active: true, reason: 'active', source: 'clock' });
  });

  it('stands down outside the window', () => {
    expect(gate({}, at(14))).toEqual({ active: false, reason: 'daytime', source: 'clock' });
    expect(gate({}, at(7))).toEqual({ active: false, reason: 'daytime', source: 'clock' });
  });

  it('obeys the master switch above everything else', () => {
    expect(gate({ enabled: false }, at(23), 'dark')).toEqual({
      active: false,
      reason: 'off',
      source: 'none',
    });
  });

  it('obeys the exclusion list above the night restriction', () => {
    expect(gate({ disabledSites: ['example.com'] }, at(23), 'dark')).toEqual({
      active: false,
      reason: 'site',
      source: 'none',
    });
  });

  it('runs at any hour once the night restriction is off', () => {
    expect(gate({ nightOnly: false }, at(14))).toEqual({
      active: true,
      reason: 'active',
      source: 'none',
    });
  });

  it('ignores the sensor once the night restriction is off', () => {
    expect(gate({ nightOnly: false }, at(14), 'bright')).toEqual({
      active: true,
      reason: 'active',
      source: 'none',
    });
  });

  it('lets the sensor override the clock in both directions', () => {
    // A blacked-out room in the afternoon is exactly what this is for, and a lit
    // room at midnight is exactly when it is not needed.
    expect(gate({}, at(14), 'dark')).toEqual({
      active: true,
      reason: 'active',
      source: 'sensor',
    });
    expect(gate({}, at(2), 'bright')).toEqual({
      active: false,
      reason: 'daylight',
      source: 'sensor',
    });
  });

  it('falls back to the clock when there is no reading', () => {
    expect(gate({}, at(2), 'unknown').source).toBe('clock');
  });

  it('honours a custom window, including one that does not wrap', () => {
    const patch = { nightStart: at(13), nightEnd: at(17) };
    expect(gate(patch, at(14)).active).toBe(true);
    expect(gate(patch, at(23)).active).toBe(false);
  });

  it('never blocks on the clock when the window is collapsed', () => {
    const patch = { nightStart: at(21), nightEnd: at(21) };
    expect(gate(patch, at(12)).active).toBe(true);
  });
});

describe('gateRecheckDelayMs', () => {
  it('needs no timer when nothing is time-dependent', () => {
    expect(gateRecheckDelayMs(settings({ nightOnly: false }), localTime(12))).toBe(0);
    expect(gateRecheckDelayMs(settings({ enabled: false }), localTime(12))).toBe(0);
  });

  it('caps how far ahead it will sleep', () => {
    // The boundary is computed against the current UTC offset, so a DST change
    // must not go unnoticed for an hour.
    expect(gateRecheckDelayMs(settings({}), localTime(12))).toBe(GATE_RECHECK_CAP_MS);
  });

  it('wakes at the boundary when it is close', () => {
    expect(gateRecheckDelayMs(settings({}), localTime(20, 55))).toBe(5 * 60_000);
    expect(gateRecheckDelayMs(settings({}), localTime(6, 58))).toBe(2 * 60_000);
  });

  it('never returns a delay short enough to spin', () => {
    expect(gateRecheckDelayMs(settings({}), localTime(21, 0))).toBeGreaterThanOrEqual(1000);
  });
});
