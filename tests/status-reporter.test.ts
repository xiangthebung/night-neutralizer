/**
 * The reporter is what keeps an idle page from sending a message every time an
 * engine twitches. Its throttling and deduplication were previously only
 * exercised end to end, where a regression would look like "the popup is a bit
 * laggy" rather than a failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusReporter } from '../src/content/status-reporter';
import { MSG } from '../src/core/messages';
import { DEFAULT_SETTINGS, type FrameStatus } from '../src/core/types';

type Snapshot = Omit<FrameStatus, 'frameId'>;

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
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
    images: { active: true, elements: 3 },
    notes: [],
    ...overrides,
  };
}

let sendMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  sendMessage = vi.fn().mockResolvedValue(undefined);
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id: 'test-extension', sendMessage },
  };
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe('StatusReporter', () => {
  it('sends the built status as a report message', async () => {
    const reporter = new StatusReporter(() => snapshot());
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(0);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const message = sendMessage.mock.calls[0]?.[0];
    expect(message.type).toBe(MSG.STATUS_REPORT);
    expect(message.status.site).toBe('example.com');
  });

  it('coalesces a burst of requests into one message', async () => {
    // Every engine calls schedule() on every state change; a page with several
    // players would otherwise flood the service worker.
    const reporter = new StatusReporter(() => snapshot());
    for (let i = 0; i < 20; i++) reporter.schedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not resend an unchanged status', async () => {
    let counter = 0;
    // `at` moves every time; only the rest of the payload should count.
    const reporter = new StatusReporter(() => snapshot({ at: (counter += 1000) }));
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('sends again once something actually changes', async () => {
    let processed = 1;
    const reporter = new StatusReporter(() =>
      snapshot({ audio: { state: 'active', processed, skipped: 0 } }),
    );
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(0);

    processed = 2;
    await vi.advanceTimersByTimeAsync(2000);
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(2000);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('rate-limits to roughly one message per second', async () => {
    let counter = 0;
    const reporter = new StatusReporter(() => snapshot({ mediaElements: (counter += 1) }));
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // A change 100 ms later must wait out the interval rather than go straight
    // out.
    await vi.advanceTimersByTimeAsync(100);
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('swallows a failing snapshot builder', async () => {
    const reporter = new StatusReporter(() => {
      throw new Error('engine exploded');
    });
    reporter.schedule();
    // A throwing builder must not escape the timer callback.
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('stops permanently once the extension context is gone', async () => {
    // After a reload or update `chrome.runtime.id` disappears; retrying would
    // throw on every engine event for the life of the page.
    (globalThis as unknown as { chrome: { runtime: { id?: string } } }).chrome.runtime.id =
      undefined;
    const build = vi.fn(() => snapshot());
    const reporter = new StatusReporter(build);

    reporter.schedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessage).not.toHaveBeenCalled();

    build.mockClear();
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(5000);
    expect(build).not.toHaveBeenCalled();
  });

  it('sends nothing after stop, and cancels a pending report', async () => {
    const reporter = new StatusReporter(() => snapshot());
    reporter.schedule();
    reporter.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sendMessage).not.toHaveBeenCalled();

    reporter.schedule();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('survives a rejected sendMessage without throwing', async () => {
    sendMessage.mockRejectedValue(new Error('receiving end does not exist'));
    const reporter = new StatusReporter(() => snapshot());
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
