/** Shared data shapes. */
import type { SoftClipParams } from './soft-clip';

export type { SoftClipParams };

export interface Settings {
  /** Master switch. When false nothing is processed anywhere. */
  enabled: boolean;
  /** 0 = bypass, 100 = strongest compression. Drives both halves when linked. */
  strength: number;
  /**
   * When true one slider drives audio and video together (the default, and what
   * most people want). When false each half uses its own value below, because
   * "compress the audio hard but leave the picture nearly alone" is a perfectly
   * ordinary preference that a single slider cannot express.
   */
  linked: boolean;
  /** Used instead of `strength` for audio when `linked` is false. */
  audioStrength: number;
  /** Used instead of `strength` for video when `linked` is false. */
  videoStrength: number;
  /** Audio dynamic-range compression on/off. */
  audio: boolean;
  /** Video tone mapping on/off. */
  video: boolean;
  /**
   * Night EQ: shelve the low end down and lift dialogue presence. Compression
   * makes quiet speech loud enough; this is what lets you turn the *volume*
   * down, since bass is what carries through walls.
   */
  nightEq: boolean;
  /**
   * Hostnames to leave completely alone, normalised (lower case, no `www.`, no
   * port). A listed host also covers its subdomains.
   */
  disabledSites: string[];
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
  /**
   * Leave music alone. Dynamic range is the point of a record and a nuisance in
   * a film, so compressing YouTube Music the way we compress a thriller is the
   * wrong default. Applies to the audio half only: tone mapping a music video
   * has nothing to do with what you are listening to.
   */
  skipMusic: boolean;
}

/**
 * Note for callers: `disabledSites` is a plain array here rather than a frozen
 * one, so treat spreads of this object as copy-on-write. `sanitizeSettings()`
 * always allocates a fresh array, which is where every stored value comes from.
 */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  enabled: true,
  strength: 45,
  linked: true,
  audioStrength: 45,
  videoStrength: 45,
  audio: true,
  video: true,
  nightEq: false,
  disabledSites: [],
  nightOnly: true,
  nightStart: 21 * 60,
  nightEnd: 7 * 60,
  skipMusic: true,
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
  notes: string[];
  stale: boolean;
}
