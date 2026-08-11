/** Shared data shapes. */
import type { SoftClipParams } from './soft-clip';

export type { SoftClipParams };

/**
 * Everything the user can choose, in four groups: what applies everywhere, the
 * sound, the picture, and when any of it runs.
 *
 * The groups are the popup's panels, in the popup's order, and that is on
 * purpose — a setting whose neighbours in this file are not its neighbours on
 * screen is a setting someone will file in the wrong place twice: once here and
 * once in the UI. Storage is still one flat object under one key, so a group is
 * a way of reading this list rather than a shape anything has to unpack.
 */
export interface Settings {
  /* ------------------------------ everywhere ------------------------------ */

  /** Master switch. When false nothing is processed anywhere. */
  enabled: boolean;
  /**
   * Hostnames to leave completely alone, normalised (lower case, no `www.`, no
   * port). A listed host also covers its subdomains.
   */
  disabledSites: string[];

  /* -------------------------------- sound --------------------------------- */

  /**
   * Audio dynamic-range compression on/off. The master switch for this group:
   * with it off, neither the EQ nor the music exemption below can do anything.
   */
  audio: boolean;
  /** 0 = bypass, 100 = strongest compression. */
  audioStrength: number;
  /**
   * Night EQ: shelve the low end down and lift dialogue presence. Compression
   * makes quiet speech loud enough; this is what lets you turn the *volume*
   * down, since bass is what carries through walls.
   */
  nightEq: boolean;
  /**
   * Leave music alone. Dynamic range is the point of a record and a nuisance in
   * a film, so compressing YouTube Music the way we compress a thriller is the
   * wrong default. Sound only: tone mapping a music video has nothing to do
   * with what you are listening to, which is why it lives in this group.
   */
  skipMusic: boolean;

  /* ------------------------------- picture -------------------------------- */

  /** Video tone mapping on/off. */
  video: boolean;
  /**
   * Still-image tone mapping on/off. Separate from `video` because the two are
   * different bargains: a video is measured frame by frame and corrected for
   * what it actually contains, while a still gets one fixed curve that can only
   * ever darken it (see `imageAdaptState`). Someone who wants their films
   * treated and their photographs left exactly as the photographer left them is
   * asking for something reasonable, and one toggle cannot express it.
   */
  images: boolean;
  /** 0 = bypass, 100 = strongest tone mapping. Drives video and stills alike. */
  videoStrength: number;
  /**
   * Make the page dark.
   *
   * Asks the site first (`color-scheme: dark`) and only inverts the ones that
   * stay light. See `core/page.ts` for why the polite half rarely wins, and
   * `content/page-engine.ts` for how the answer is measured. Off by default:
   * inverting a page is the most visible thing this extension can do, and
   * unlike the tone curve — which is trying to show you the content the way it
   * was shot — it deliberately changes how a site looks.
   *
   * In this group rather than a group of its own because it is the same
   * complaint as the tone curve, one step further out: the brightest thing on
   * the screen at 1 a.m. is often not the video but the page behind it. It is
   * not on the picture slider, though; a page is dark or it is not.
   */
  darkMode: boolean;

  /* ------------------------------- schedule ------------------------------- */

  /**
   * Only process when it is actually night.
   *
   * "Night" is answered by the room when the browser exposes an ambient light
   * sensor, and by the clock otherwise. The sensor is the better signal — a
   * blacked-out room at 3 p.m. is exactly when this extension helps — but
   * Chrome keeps `AmbientLightSensor` behind a flag, so the clock is what most
   * installs will use. See `core/gate.ts` for the decision order.
   */
  nightOnly: boolean;
  /** Start of the night window, minutes since local midnight. */
  nightStart: number;
  /** End of the night window, minutes since local midnight; may wrap midnight. */
  nightEnd: number;
}

/**
 * Note for callers: `disabledSites` is a plain array here rather than a frozen
 * one, so treat spreads of this object as copy-on-write. `sanitizeSettings()`
 * always allocates a fresh array, which is where every stored value comes from.
 */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  enabled: true,
  disabledSites: [],
  audio: true,
  audioStrength: 45,
  nightEq: false,
  skipMusic: true,
  video: true,
  images: true,
  videoStrength: 45,
  darkMode: false,
  nightOnly: true,
  nightStart: 21 * 60,
  nightEnd: 7 * 60,
});

/** Hard cap on the exclusion list, so storage.sync quota cannot be exhausted. */
export const MAX_DISABLED_SITES = 200;

export const SETTINGS_KEY = 'settings';

/** Parameters for a single `DynamicsCompressorNode`. */
export interface CompressorParams {
  thresholdDb: number;
  kneeDb: number;
  ratio: number;
  /** seconds */
  attack: number;
  /** seconds */
  release: number;
}

/**
 * Night EQ: a low shelf and a presence bell, both flat when disabled so the
 * nodes can stay in the graph permanently (rebuilding a live graph is what
 * risks silencing an element).
 */
export interface EqParams {
  enabled: boolean;
  /** Low-shelf corner frequency in Hz. */
  lowShelfHz: number;
  /** Low-shelf gain, always <= 0: rumble is what disturbs the neighbours. */
  lowShelfDb: number;
  /** Presence bell centre in Hz, in the consonant range. */
  presenceHz: number;
  /** Presence gain, always >= 0. */
  presenceDb: number;
  /** Presence bell Q; wide enough to avoid sounding like a telephone. */
  presenceQ: number;
}

export interface AudioParams {
  /** True when the chain should be acoustically transparent. */
  bypass: boolean;
  /** Gain in front of the compressor, pushes quiet material into the knee. */
  preGainDb: number;
  /** Tone shaping, applied before compression so the compressor sees it. */
  eq: EqParams;
  compressor: CompressorParams;
  /** Post-compressor gain that brings the reduced signal back up. */
  makeupGainDb: number;
  /** Fast brick-wall-ish stage that catches transients the compressor misses. */
  limiter: CompressorParams;
  /** Instantaneous last resort so nothing can reach the sink above full scale. */
  safety: SoftClipParams;
}

/** Controls for the temporal adaptation loop (scene analysis). */
export interface AdaptConfig {
  enabled: boolean;
  /** Mean luma we steer bright scenes towards (0..1). */
  targetLuma: number;
  /** Lowest exposure multiplier the loop may apply. */
  minExposure: number;
  /** Highest exposure multiplier the loop may apply. */
  maxExposure: number;
  /** Time constant (s) when dimming. Short: protect the eyes quickly. */
  dimTau: number;
  /** Time constant (s) when recovering. Long: avoid visible pumping. */
  recoverTau: number;
  /**
   * Rate of mean-luma rise, in luma units per second, that counts as a flash.
   * Expressed as a rate rather than a per-sample delta so the behaviour does
   * not change with the sampling interval (~60 Hz when driven by video frames,
   * 8 Hz on the timer fallback).
   */
  flashRate: number;
  /** Maximum extra exposure reduction applied to a detected flash (0..1). */
  flashDim: number;
  /** Decay time constant (s) for the flash guard. */
  flashTau: number;
  /** Lift/roll strength used when frames cannot be analysed (DRM etc.). */
  staticLiftScale: number;
  staticRollScale: number;
}

export interface VideoParams {
  bypass: boolean;
  /** Absolute black point raise (0..0.2 of full range). */
  blackLift: number;
  /** Shadow gamma; >1 opens up dark detail. */
  shadowGamma: number;
  /** Input level where the highlight roll-off starts (0..1). */
  kneeStart: number;
  /**
   * How far the white point is pulled down, as a fraction of the full range:
   * white = 1 - highlightCompression. Defined against full range rather than
   * against the above-knee span, because the span is small and scaling by it
   * made the shoulder too weak to be visible.
   */
  highlightCompression: number;
  /** Static exposure multiplier applied before the curve. */
  exposure: number;
  /** Saturation compensation for the desaturating effect of the curve. */
  saturation: number;
  adapt: AdaptConfig;
}

export interface ProcessingParams {
  audio: AudioParams;
  video: VideoParams;
}

export type VideoMode =
  /** Video processing disabled by settings. */
  | 'off'
  /** Frames are analysed; the tone curve tracks the content. */
  | 'adaptive'
  /** Frames cannot be read (DRM/cross-origin); a fixed curve is applied. */
  | 'static'
  /** Neither path is available in this browser. */
  | 'unsupported';

/** What the still-image half of the picture path is doing in one frame. */
export interface ImageStatus {
  /** True when the fixed image curve is installed in this frame. */
  active: boolean;
  /** `<img>` elements in this frame's document, filtered or not. */
  elements: number;
}

/**
 * How a request for a dark page was actually answered. The distinction is the
 * whole point of the setting: `scheme` means the site had a dark presentation
 * of its own and we asked for it, `invert` means it did not and we took the
 * picture apart. They do not look alike and they do not fail alike.
 */
export type PageDarkMode =
  /** No dark page was asked for. */
  | 'off'
  /** Asked for, and the page was already dark or went dark on request. */
  | 'scheme'
  /** Asked for, the page stayed light, so it is being inverted. */
  | 'invert'
  /** Asked for, but nothing has been measured yet (the document is empty). */
  | 'pending';

/** What the dark-page treatment is doing in one frame. */
export interface PageStatus {
  /** True when this frame has a page stylesheet installed. */
  active: boolean;
  dark: PageDarkMode;
}

export type AudioState =
  | 'off'
  | 'idle'
  | 'active'
  | 'bypassed'
  /** Deliberately left alone because this player is playing music. */
  | 'music'
  | 'blocked'
  | 'unsupported';

/**
 * Why a frame is or is not processing. One value, decided in one place
 * (`core/gate.ts`), so the popup, the badge and the engines cannot disagree.
 */
export type GateReason =
  /** Processing. */
  | 'active'
  /** Master switch off. */
  | 'off'
  /** This host is on the exclusion list. */
  | 'site'
  /** The light sensor says the room is bright. */
  | 'daylight'
  /** The clock says we are outside the night window. */
  | 'daytime';

/** Which signal answered "is it night?". */
export type GateSource =
  /** Nothing was consulted: the night restriction is switched off. */
  | 'none'
  /** An ambient light sensor reading. */
  | 'sensor'
  /** The local wall clock and the configured window. */
  | 'clock';

export interface GateStatus {
  active: boolean;
  reason: GateReason;
  source: GateSource;
  /** Last ambient reading in lux, or null when no sensor reading exists. */
  lux: number | null;
}

export interface MusicStatus {
  /** True when this frame's host is a known music service. */
  site: boolean;
  /** Media elements left uncompressed because they are playing music. */
  skipped: number;
}

export interface FrameStatus {
  frameId: number;
  at: number;
  top: boolean;
  settings: Settings;
  /**
   * Normalised hostname of the *top-level* page, so the popup can offer "turn
   * off on this site" without the extension holding any tab permission. A bare
   * hostname only: no path, no query, no title. It lives in
   * `chrome.storage.session`, which is memory-only and dropped when the tab
   * closes or Chrome exits.
   */
  site: string;
  /** True when this frame is skipping work because the site is excluded. */
  siteDisabled: boolean;
  /** Whether this frame is processing at all, and why not when it is not. */
  gate: GateStatus;
  music: MusicStatus;
  mediaElements: number;
  audio: {
    state: AudioState;
    processed: number;
    skipped: number;
  };
  video: {
    mode: VideoMode;
    elements: number;
    /** Rendering path actually in use. */
    technique: 'svg-tone-curve' | 'css-basic' | 'none';
  };
  images: ImageStatus;
  page: PageStatus;
  notes: string[];
}

export interface TabStatus {
  frames: number;
  /** Top-level hostname, empty when no frame reported one. */
  site: string;
  siteDisabled: boolean;
  gate: GateStatus;
  music: MusicStatus;
  mediaElements: number;
  audio: { state: AudioState; processed: number; skipped: number };
  video: { mode: VideoMode; elements: number; technique: FrameStatus['video']['technique'] };
  images: ImageStatus;
  page: PageStatus;
  notes: string[];
  stale: boolean;
}
