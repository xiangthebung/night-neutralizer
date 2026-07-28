import { describe, expect, it } from 'vitest';
import { STATUS_STALE_MS, aggregateStatuses, pruneFrames } from '../src/core/status';
import { DEFAULT_SETTINGS, type FrameStatus } from '../src/core/types';

function frame(overrides: Partial<FrameStatus> = {}): FrameStatus {
  return {
    frameId: 0,
    at: Date.now(),
    top: true,
    settings: { ...DEFAULT_SETTINGS },
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
