/** Message contract between content script, service worker and popup. */
import type { FrameStatus, TabStatus, VideoMode } from './types';

export const MSG = {
  /** content -> service worker: push the latest frame status. */
  STATUS_REPORT: 'nn:status-report',
  /** popup -> service worker: ask for the aggregated status of a tab. */
  STATUS_QUERY: 'nn:status-query',
  /** service worker -> content: ask for a fresh status right now. */
  STATUS_REQUEST: 'nn:status-request',
} as const;

export interface StatusReportMessage {
  type: typeof MSG.STATUS_REPORT;
  status: Omit<FrameStatus, 'frameId'>;
}

export interface StatusQueryMessage {
  type: typeof MSG.STATUS_QUERY;
  tabId: number;
}

export interface StatusRequestMessage {
  type: typeof MSG.STATUS_REQUEST;
}

export type ExtensionMessage = StatusReportMessage | StatusQueryMessage | StatusRequestMessage;

export interface StatusQueryResponse {
  status: TabStatus;
}

export const SESSION_STATUS_KEY = 'frameStatus';

/* ------------------------------ the live port ----------------------------- */

/**
 * The popup opens one `chrome.tabs.connect` port to the content scripts of the
 * tab it is describing, and two things ride on it in opposite directions.
 *
 * Down: whether the user is holding *Compare*, which bypasses the sound and
 * the picture for exactly as long as the button is held. A port rather than a
 * setting because a setting outlives the popup: a Compare that was still held
 * when the popup closed would leave the tab unprocessed with nothing on screen
 * to say why. A port disconnects the moment the popup goes, and the content
 * script treats that as the button being released.
 *
 * Up: a meter of what is being applied right now — the gain the audio chain is
 * adding at this moment and how much the tone curve is changing the light of
 * the frame on screen — a few times a second. The status channel through the
 * service worker is rate-limited to about one message a second and is the
 * wrong shape for a meter, which has to move while a scene does.
 *
 * `tabs.connect` needs no permission: it reaches only this extension's own
 * content scripts, the same way `tabs.sendMessage` already does.
 */
export const LIVE_PORT = 'nn:live';

export const LIVE = {
  /** popup -> content: the Compare button went down or came up. */
  HOLD: 'nn:hold',
  /** content -> popup: what is being applied right now. */
  METER: 'nn:meter',
} as const;

export interface LiveHoldMessage {
  type: typeof LIVE.HOLD;
  held: boolean;
}

export interface LiveMeterMessage {
  type: typeof LIVE.METER;
  /** True from the top-level frame, which the popup prefers when several report. */
  top: boolean;
  /** True while this frame is honouring a held Compare. */
  held: boolean;
  audio: {
    /** True when at least one player in this frame is being compressed. */
    active: boolean;
    /**
     * Net gain the chain is applying to the signal at this instant, in dB:
     * pre-gain and make-up less the compressor's current reduction. Null when
     * no player is being processed or nothing is playing.
     */
    gainDb: number | null;
  };
  video: {
    mode: VideoMode;
    /**
     * Emitted light of the frame on screen after the curve, over before it, in
     * linear light. Below 1 the picture is being dimmed, above 1 lifted. Null
     * when no curve is applied.
     */
    lightRatio: number | null;
  };
}

export type LiveMessage = LiveHoldMessage | LiveMeterMessage;

/** How often a frame sends its meter while a port is open. */
export const METER_INTERVAL_MS = 250;
