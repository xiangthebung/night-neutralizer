/**
 * Status aggregation: a tab can contain many frames (embedded players), each
 * running its own copy of the content script. The popup shows one summary, so
 * the per-frame reports are merged here. Pure module, unit tested.
 */
import type { AudioState, FrameStatus, TabStatus, VideoMode } from './types';

const AUDIO_PRIORITY: AudioState[] = [
  'active',
  'blocked',
  'bypassed',
  'unsupported',
  'idle',
  'off',
];

const VIDEO_PRIORITY: VideoMode[] = ['adaptive', 'static', 'unsupported', 'off'];

function pick<T>(values: readonly T[], priority: readonly T[], fallback: T): T {
  for (const candidate of priority) {
    if (values.includes(candidate)) return candidate;
  }
  return fallback;
}

export const STATUS_STALE_MS = 20_000;

export function aggregateStatuses(frames: readonly FrameStatus[], now = Date.now()): TabStatus {
  if (frames.length === 0) {
    return {
      frames: 0,
      mediaElements: 0,
      audio: { state: 'off', processed: 0, skipped: 0 },
      video: { mode: 'off', elements: 0, technique: 'none' },
      notes: [],
      stale: true,
    };
  }

  let mediaElements = 0;
  let processed = 0;
  let skipped = 0;
  let videoElements = 0;
  let newest = 0;
  const audioStates: AudioState[] = [];
  const videoModes: VideoMode[] = [];
  const techniques: FrameStatus['video']['technique'][] = [];
  const notes = new Set<string>();

  for (const frame of frames) {
    mediaElements += frame.mediaElements;
    processed += frame.audio.processed;
    skipped += frame.audio.skipped;
    videoElements += frame.video.elements;
    newest = Math.max(newest, frame.at);
    audioStates.push(frame.audio.state);
    videoModes.push(frame.video.mode);
    techniques.push(frame.video.technique);
    for (const note of frame.notes) notes.add(note);
  }

  return {
    frames: frames.length,
    mediaElements,
    audio: {
      state: pick(audioStates, AUDIO_PRIORITY, 'off'),
      processed,
      skipped,
    },
    video: {
      mode: pick(videoModes, VIDEO_PRIORITY, 'off'),
      elements: videoElements,
      technique: pick(techniques, ['svg-tone-curve', 'css-basic', 'none'], 'none'),
    },
    notes: [...notes],
    stale: now - newest > STATUS_STALE_MS,
  };
}

/** Drop reports from frames that have not checked in for a long time. */
export function pruneFrames(
  frames: Record<string, FrameStatus>,
  now = Date.now(),
  maxAgeMs = 5 * 60_000,
): Record<string, FrameStatus> {
  const out: Record<string, FrameStatus> = {};
  for (const [key, frame] of Object.entries(frames)) {
    if (frame && now - frame.at <= maxAgeMs) out[key] = frame;
  }
  return out;
}
