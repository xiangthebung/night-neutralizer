/** Message contract between content script, service worker and popup. */
import type { FrameStatus, TabStatus } from './types';

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
