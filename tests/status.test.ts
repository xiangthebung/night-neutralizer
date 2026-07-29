import { describe, expect, it } from 'vitest';
import { STATUS_STALE_MS, aggregateStatuses, pruneFrames } from '../src/core/status';
import { DEFAULT_SETTINGS, type FrameStatus } from '../src/core/types';

function frame(overrides: Partial<FrameStatus> = {}): FrameStatus {
  return {
    frameId: 0,
    at: Date.now(),
    top: true,
    settings: { ...DEFAULT_SETTINGS },
    site: 'example.com',
    siteDisabled: false,
    gate: { active: true, reason: 'active', source: 'clock', lux: null },
    music: { site: false, skipped: 0 },
    mediaElements: 1,
    audio: { state: 'active', processed: 1, skipped: 0 },
    video: { mode: 'adaptive', elements: 1, technique: 'svg-tone-curve' },
    notes: [],
    ...overrides,
  };
}

describe('aggregateStatuses', () => {
  it('reports an empty, stale status when nothing was reported', () => {
    const status = aggregateStatuses([]);
    expect(status.frames).toBe(0);
    expect(status.audio.state).toBe('off');
    expect(status.video.mode).toBe('off');
    expect(status.stale).toBe(true);
  });

  it('sums counts across frames', () => {
    const status = aggregateStatuses([
      frame({ frameId: 0, mediaElements: 1, audio: { state: 'active', processed: 1, skipped: 0 } }),
      frame({
        frameId: 3,
        mediaElements: 2,
        audio: { state: 'idle', processed: 0, skipped: 1 },
        video: { mode: 'static', elements: 2, technique: 'svg-tone-curve' },
      }),
    ]);
    expect(status.frames).toBe(2);
    expect(status.mediaElements).toBe(3);
    expect(status.audio.processed).toBe(1);
    expect(status.audio.skipped).toBe(1);
    expect(status.video.elements).toBe(3);
  });

  it('prefers the most informative audio state', () => {
    expect(
      aggregateStatuses([
        frame({ audio: { state: 'idle', processed: 0, skipped: 0 } }),
        frame({ audio: { state: 'active', processed: 1, skipped: 0 } }),
      ]).audio.state,
    ).toBe('active');

    expect(
      aggregateStatuses([
        frame({ audio: { state: 'off', processed: 0, skipped: 0 } }),
        frame({ audio: { state: 'blocked', processed: 0, skipped: 1 } }),
      ]).audio.state,
    ).toBe('blocked');
  });

  it('prefers adaptive over static video mode', () => {
    expect(
      aggregateStatuses([
        frame({ video: { mode: 'static', elements: 1, technique: 'svg-tone-curve' } }),
        frame({ video: { mode: 'adaptive', elements: 1, technique: 'svg-tone-curve' } }),
      ]).video.mode,
    ).toBe('adaptive');

    expect(
      aggregateStatuses([
        frame({ video: { mode: 'off', elements: 0, technique: 'none' } }),
        frame({ video: { mode: 'static', elements: 1, technique: 'css-basic' } }),
      ]).video.mode,
    ).toBe('static');
  });

  it('has no site when nothing was reported', () => {
    const status = aggregateStatuses([]);
    expect(status.site).toBe('');
    expect(status.siteDisabled).toBe(false);
  });

  it('takes the site from the top frame even when a sub-frame reports first', () => {
    const status = aggregateStatuses([
      frame({ frameId: 4, top: false, site: 'player.example.net' }),
      frame({ frameId: 0, top: true, site: 'blog.example.com' }),
    ]);
    expect(status.site).toBe('blog.example.com');
  });

  it('falls back to a sub-frame site when no top frame reported one', () => {
    const status = aggregateStatuses([
      frame({ frameId: 4, top: false, site: '' }),
      frame({ frameId: 9, top: false, site: 'player.example.net' }),
    ]);
    expect(status.site).toBe('player.example.net');
  });

  it('reports the tab as excluded when any frame is skipping the site', () => {
    expect(
      aggregateStatuses([frame({ siteDisabled: false }), frame({ siteDisabled: true })])
        .siteDisabled,
    ).toBe(true);
    expect(aggregateStatuses([frame(), frame()]).siteDisabled).toBe(false);
  });

  it('reports the tab as gated when every frame is', () => {
    const status = aggregateStatuses([
      frame({ gate: { active: false, reason: 'daytime', source: 'clock', lux: null } }),
      frame({ gate: { active: false, reason: 'daytime', source: 'clock', lux: null } }),
    ]);
    expect(status.gate.active).toBe(false);
    expect(status.gate.reason).toBe('daytime');
  });

  it('lets one working frame speak for the tab', () => {
    // An excluded top-level page can still host a player from a host that is
    // not excluded, and "something is happening" is the useful headline.
    const status = aggregateStatuses([
      frame({ gate: { active: false, reason: 'site', source: 'none', lux: null } }),
      frame({ gate: { active: true, reason: 'active', source: 'clock', lux: null } }),
    ]);
    expect(status.gate.reason).toBe('active');
    expect(status.gate.active).toBe(true);
  });

  it('prefers a sensor verdict over a clock one', () => {
    const status = aggregateStatuses([
      frame({ gate: { active: false, reason: 'daytime', source: 'clock', lux: null } }),
      frame({ gate: { active: false, reason: 'daylight', source: 'sensor', lux: 90 } }),
    ]);
    expect(status.gate.source).toBe('sensor');
    expect(status.gate.reason).toBe('daylight');
    expect(status.gate.lux).toBe(90);
  });

  it('takes the lux reading from the top frame when several report one', () => {
    // Only a top-level frame can read the sensor; a sub-frame is repeating a
    // shared value that may be a moment behind.
    const status = aggregateStatuses([
      frame({ frameId: 4, top: false, gate: { active: true, reason: 'active', source: 'sensor', lux: 5 } }),
      frame({ frameId: 0, top: true, gate: { active: true, reason: 'active', source: 'sensor', lux: 9 } }),
    ]);
    expect(status.gate.lux).toBe(9);
  });

  it('sums music skips and notices a music host in any frame', () => {
    const status = aggregateStatuses([
      frame({ music: { site: false, skipped: 1 } }),
      frame({ music: { site: true, skipped: 2 } }),
    ]);
    expect(status.music).toEqual({ site: true, skipped: 3 });
  });

  it('ranks a music skip above a plain bypass', () => {
    expect(
      aggregateStatuses([
        frame({ audio: { state: 'bypassed', processed: 0, skipped: 0 } }),
        frame({ audio: { state: 'music', processed: 0, skipped: 0 } }),
      ]).audio.state,
    ).toBe('music');
  });

  it('deduplicates notes', () => {
    const status = aggregateStatuses([
      frame({ notes: ['Protected video'] }),
      frame({ notes: ['Protected video', 'Something else'] }),
    ]);
    expect(status.notes).toEqual(['Protected video', 'Something else']);
  });

  it('marks the aggregate stale when every frame is old', () => {
    const now = Date.now();
    const fresh = aggregateStatuses([frame({ at: now - 1000 })], now);
    expect(fresh.stale).toBe(false);
    const old = aggregateStatuses([frame({ at: now - STATUS_STALE_MS - 1 })], now);
    expect(old.stale).toBe(true);
  });
});

describe('pruneFrames', () => {
  it('drops frames that stopped reporting', () => {
    const now = Date.now();
    const frames = {
      '0': frame({ at: now }),
      '7': frame({ at: now - 10 * 60_000 }),
    };
    const pruned = pruneFrames(frames, now);
    expect(Object.keys(pruned)).toEqual(['0']);
  });

  it('tolerates malformed entries', () => {
    const frames = { '0': undefined as unknown as FrameStatus };
    expect(pruneFrames(frames)).toEqual({});
  });
});
