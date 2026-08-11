/**
 * Status aggregation: a tab can contain many frames (embedded players), each
 * running its own copy of the content script. The popup shows one summary, so
 * the per-frame reports are merged here. Pure module, unit tested.
 */
import type {
  AudioState,
  FrameStatus,
  GateReason,
  GateSource,
  PageDarkMode,
  TabStatus,
  VideoMode,
} from './types';

const AUDIO_PRIORITY: AudioState[] = [
  'active',
  'blocked',
  'music',
  'bypassed',
  'unsupported',
  'idle',
  'off',
];

const VIDEO_PRIORITY: VideoMode[] = ['adaptive', 'static', 'unsupported', 'off'];

/**
 * `active` first: one frame doing work is the headline whatever the others say
 * (an excluded top-level page can still host a player from a host that is not
 * excluded). The rest run most decisive first, matching `core/gate.ts`.
 */
const GATE_PRIORITY: GateReason[] = ['active', 'off', 'site', 'daylight', 'daytime'];

const GATE_SOURCE_PRIORITY: GateSource[] = ['sensor', 'clock', 'none'];

/**
 * Most invasive first, which is also most informative first: if any frame in
 * the tab is being taken apart and rebuilt, that is what the popup should say,
 * because that is the one a surprise will have come from.
 */
const PAGE_DARK_PRIORITY: PageDarkMode[] = ['invert', 'scheme', 'pending', 'off'];

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
      site: '',
      siteDisabled: false,
      gate: { active: false, reason: 'off', source: 'none', lux: null },
      music: { site: false, skipped: 0 },
      mediaElements: 0,
      audio: { state: 'off', processed: 0, skipped: 0 },
      video: { mode: 'off', elements: 0, technique: 'none' },
      images: { active: false, elements: 0 },
      page: { active: false, dark: 'off' },
      notes: [],
      stale: true,
    };
  }

  let mediaElements = 0;
  let processed = 0;
  let skipped = 0;
  let videoElements = 0;
  let imageElements = 0;
  // One frame filtering its images is enough to say the tab's pictures are
  // being treated, the same way one frame doing work decides the gate below.
  let imagesActive = false;
  let pageActive = false;
  // The strongest treatment any frame is applying: a nested document can be
  // inverted while the page hosting it was already dark, and the popup should
  // report the thing that changed rather than the thing that did not.
  const pageDarkModes: PageDarkMode[] = [];
  let newest = 0;
  // The top frame is authoritative for the site: sub-frames report the same
  // top-level host, but only if `ancestorOrigins` was available to them.
  let site = '';
  let siteDisabled = false;
  let musicSite = false;
  let musicSkipped = 0;
  // The light sensor can only be read by a top-level frame, so its reading is
  // taken from the top frame when one reported and from anywhere otherwise.
  let lux: number | null = null;
  let luxFromTop = false;
  const audioStates: AudioState[] = [];
  const videoModes: VideoMode[] = [];
  const techniques: FrameStatus['video']['technique'][] = [];
  const gateReasons: GateReason[] = [];
  const gateSources: GateSource[] = [];
  const notes = new Set<string>();

  for (const frame of frames) {
    mediaElements += frame.mediaElements;
    processed += frame.audio.processed;
    skipped += frame.audio.skipped;
    videoElements += frame.video.elements;
    // Optional access on a required field: a report written by the previous
    // version of the content script can still be sitting in session storage
    // right after an update, and it has no `images` at all.
    imageElements += frame.images?.elements ?? 0;
    if (frame.images?.active) imagesActive = true;
    // Same optional access, and for the same reason: a report written by the
    // previous version of the content script can still be in session storage.
    if (frame.page?.active) pageActive = true;
    if (frame.page) pageDarkModes.push(frame.page.dark);
    newest = Math.max(newest, frame.at);
    audioStates.push(frame.audio.state);
    videoModes.push(frame.video.mode);
    techniques.push(frame.video.technique);
    gateReasons.push(frame.gate.reason);
    gateSources.push(frame.gate.source);
    if (frame.gate.lux !== null && (!luxFromTop || frame.top)) {
      lux = frame.gate.lux;
      luxFromTop = luxFromTop || frame.top;
    }
    if (frame.music.site) musicSite = true;
    musicSkipped += frame.music.skipped;
    if (frame.site && (!site || frame.top)) site = frame.site;
    if (frame.siteDisabled) siteDisabled = true;
    for (const note of frame.notes) notes.add(note);
  }

  const gateReason = pick(gateReasons, GATE_PRIORITY, 'off');

  return {
    frames: frames.length,
    site,
    siteDisabled,
    gate: {
      active: gateReason === 'active',
      reason: gateReason,
      source: pick(gateSources, GATE_SOURCE_PRIORITY, 'none'),
      lux,
    },
    music: { site: musicSite, skipped: musicSkipped },
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
    images: { active: imagesActive, elements: imageElements },
    page: { active: pageActive, dark: pick(pageDarkModes, PAGE_DARK_PRIORITY, 'off') },
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
