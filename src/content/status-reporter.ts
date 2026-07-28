/**
 * Pushes this frame's status to the service worker so the popup can display it.
 *
 * Reports are throttled and deduplicated: an idle page sends nothing. The
 * popup also pulls a fresh status on open, so a stale push is never the only
 * source of truth.
 */
import { MSG, type StatusReportMessage } from '../core/messages';
import type { FrameStatus } from '../core/types';
import { debug } from '../core/log';

const MIN_INTERVAL_MS = 1000;

export class StatusReporter {
  private lastPayload = '';
  private lastSentAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disabled = false;

  constructor(private readonly build: () => Omit<FrameStatus, 'frameId'>) {}

  /** Coalesced request to publish the current status. */
  schedule(): void {
    if (this.disabled || this.timer) return;
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - this.lastSentAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.send();
    }, wait);
  }

  private send(): void {
    if (this.disabled) return;
    let status: Omit<FrameStatus, 'frameId'>;
    try {
      status = this.build();
    } catch (error) {
      debug('failed to build status', error);
      return;
    }

    const serialized = JSON.stringify(status);
    // `at` always differs, so compare without it.
    const comparable = serialized.replace(/"at":\d+,?/, '');
    if (comparable === this.lastPayload) {
      this.lastSentAt = Date.now();
      return;
    }
    this.lastPayload = comparable;
    this.lastSentAt = Date.now();

    const message: StatusReportMessage = { type: MSG.STATUS_REPORT, status };
    try {
      if (!chrome?.runtime?.id) {
        this.disabled = true;
        return;
      }
      void chrome.runtime.sendMessage(message).catch(() => undefined);
    } catch {
      // Extension was reloaded/updated: stop trying, the page keeps working.
      this.disabled = true;
    }
  }

  stop(): void {
    this.disabled = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
