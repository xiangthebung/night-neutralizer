/** Shared data shapes. */
import type { SoftClipParams } from './soft-clip';

export type { SoftClipParams };

export interface Settings {
  /** Master switch. When false nothing is processed anywhere. */
  enabled: boolean;
  /** 0 = bypass, 100 = strongest compression. */
  strength: number;
  /** Audio dynamic-range compression on/off. */
  audio: boolean;
  /** Video tone mapping on/off. */
  video: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  enabled: true,
  strength: 45,
  audio: true,
  video: true,
});

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

export interface AudioParams {
  /** True when the chain should be acoustically transparent. */
  bypass: boolean;
  /** Gain in front of the compressor, pushes quiet material into the knee. */
  preGainDb: number;
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
  | 'blocked'
  | 'unsupported';

export interface FrameStatus {
  frameId: number;
  at: number;
  top: boolean;
  settings: Settings;
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
  mediaElements: number;
  audio: { state: AudioState; processed: number; skipped: number };
  video: { mode: VideoMode; elements: number; technique: FrameStatus['video']['technique'] };
  notes: string[];
  stale: boolean;
}
