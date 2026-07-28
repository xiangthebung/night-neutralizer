/**
 * Strength -> processing parameter mapping.
 *
 * This is the single place where the 0..100 slider becomes concrete DSP and
 * tone-curve numbers, which is why it is a pure module with unit tests.
 *
 * Design rules encoded here:
 *  - 0 must be a true bypass (ratio 1, unity gains, identity tone curve).
 *  - The mapping is continuous and monotonic, with a soft start (smoothstep)
 *    so small slider moves near 0 do not jump.
 *  - Peaks are targeted at roughly -3 dBFS after make-up gain so the limiter
 *    only ever catches transients instead of doing the heavy lifting.
 *  - Release time grows with strength: heavier compression with a short
 *    release is what produces audible pumping.
 */
import type { AudioParams, CompressorParams, ProcessingParams, VideoParams } from './types';
import { clamp, lerp, smoothstep } from './math';
import { IDENTITY_SOFT_CLIP } from './soft-clip';

export const STRENGTH_MIN = 0;
export const STRENGTH_MAX = 100;

/** Clamp arbitrary input into the slider domain. Non-finite input means bypass. */
export function normalizeStrength(strength: number): number {
  if (!Number.isFinite(strength)) return STRENGTH_MIN;
  return clamp(strength, STRENGTH_MIN, STRENGTH_MAX);
}

const NEUTRAL_COMPRESSOR: Readonly<CompressorParams> = Object.freeze({
  thresholdDb: 0,
  kneeDb: 0,
  ratio: 1,
  attack: 0.01,
  release: 0.25,
});

export function neutralAudioParams(): AudioParams {
  return {
    bypass: true,
    preGainDb: 0,
    compressor: { ...NEUTRAL_COMPRESSOR },
    makeupGainDb: 0,
    limiter: { ...NEUTRAL_COMPRESSOR },
    safety: { ...IDENTITY_SOFT_CLIP },
  };
}

export function neutralVideoParams(): VideoParams {
  return {
    bypass: true,
    blackLift: 0,
    shadowGamma: 1,
    kneeStart: 1,
    highlightCompression: 0,
    exposure: 1,
    saturation: 1,
    adapt: {
      enabled: false,
      targetLuma: 0.34,
      minExposure: 1,
      maxExposure: 1,
      dimTau: 0.3,
      recoverTau: 1.6,
      flashRate: Number.POSITIVE_INFINITY,
      flashDim: 0,
      flashTau: 0.55,
      staticLiftScale: 0,
      staticRollScale: 0,
    },
  };
}

/**
 * Chromium's `DynamicsCompressorNode` is not a textbook compressor: its kernel
 * applies an automatic make-up gain of roughly `0.6 x` the full-range gain
 * reduction (Blink's `DynamicsCompressorKernel` raises the inverse of the
 * full-scale saturation to the power 0.6). Any make-up gain we add sits on top
 * of that.
 *
 * Ignoring it double-compensates. An offline render of the real chain measured
 * the consequences at strength 100: +32 dB on quiet material instead of the
 * intended +22, and peaks at +3.3 dBFS, i.e. hard clipping at the sink.
 *
 * This is an approximation of Blink's curve (it uses the theoretical reduction
 * rather than the knee-shaped one, so it slightly over-estimates, which errs
 * towards quieter output). The offline measurement in `scripts/smoke.mjs`
 * bounds the residual error.
 */
export function chromiumInternalMakeupDb(thresholdDb: number, ratio: number): number {
  if (!(ratio > 1)) return 0;
  const fullRangeReductionDb = Math.max(0, -thresholdDb * (1 - 1 / ratio));
  return 0.6 * fullRangeReductionDb;
}

/**
 * Audio chain parameters.
 *
 * Signal path: source -> preGain -> compressor -> makeupGain -> limiter -> out
 */
export function mapAudioStrength(strength: number): AudioParams {
  const t = normalizeStrength(strength) / 100;
  if (t <= 0) return neutralAudioParams();

  const s = smoothstep(t);

  // Threshold and knee have to be chosen together. Chromium's soft knee spans
  // `threshold .. threshold + knee`, and inside it the effective ratio is far
  // below the nominal one. With an early threshold and a wide knee, full-scale
  // material sits inside the knee and is hardly compressed at all: an offline
  // render of the previous values measured only 0.05 dB of reduction on a
  // 0 dBFS passage at the default strength. These values keep the knee upper
  // edge below full scale from the mid range upwards.
  const thresholdDb = lerp(-10, -30, s);
  const ratio = lerp(1, 4, s);
  const kneeDb = lerp(24, 8, s);
  const attack = lerp(0.03, 0.008, s);
  const release = lerp(0.25, 0.42, s);
  const preGainDb = lerp(0, 5, s);

  // Where a 0 dBFS peak lands after pre-gain, compression, and the
  // compressor's own internal make-up.
  const peakOutDb =
    thresholdDb +
    (preGainDb - thresholdDb) / ratio +
    chromiumInternalMakeupDb(thresholdDb, ratio);
  // Target steady-state peak. Interpolated from 0 so the mapping stays
  // continuous with the bypass case at strength 0. -4 dBFS leaves room for the
  // transient overshoot that any finite attack time allows.
  const targetPeakDb = lerp(0, -4, s);
  const makeupGainDb = clamp(targetPeakDb - peakOutDb, 0, 24);

  return {
    bypass: false,
    preGainDb,
    compressor: { thresholdDb, kneeDb, ratio, attack, release },
    makeupGainDb,
    limiter: {
      thresholdDb: lerp(-0.5, -2, s),
      kneeDb: 2,
      ratio: 20,
      attack: 0.002,
      release: 0.1,
    },
    // Engages only on transients that outrun the limiter's attack. The knee
    // stays above anything the chain produces in steady state.
    safety: { headroom: 2, knee: 0.9, ceiling: 0.99 },
  };
}

/**
 * Video tone-mapping parameters. The adaptive loop scales `blackLift`,
 * `shadowGamma` and `highlightCompression` per scene; these are the ceilings.
 */
export function mapVideoStrength(strength: number): VideoParams {
  const t = normalizeStrength(strength) / 100;
  if (t <= 0) return neutralVideoParams();

  const s = smoothstep(t);

  return {
    bypass: false,
    blackLift: lerp(0, 0.075, s),
    shadowGamma: lerp(1, 1.95, s),
    kneeStart: lerp(0.88, 0.42, s),
    highlightCompression: lerp(0, 0.35, s),
    exposure: 1,
    saturation: lerp(1, 1.18, s),
    adapt: {
      enabled: true,
      targetLuma: 0.34,
      minExposure: lerp(1, 0.65, s),
      maxExposure: 1,
      dimTau: 0.3,
      recoverTau: 1.6,
      // 4.0 -> 1.2 luma/s. A hard cut moves the mean in a single frame
      // (tens of luma units per second), while a deliberate fade moves at
      // well under 1 luma/s, so the two are cleanly separated.
      flashRate: lerp(4, 1.2, s),
      flashDim: lerp(0, 0.45, s),
      flashTau: 0.55,
      // Deliberately not scaled by strength: `blackLift`, `shadowGamma` and
      // `highlightCompression` already carry it. Scaling here as well made
      // static mode (DRM, unreadable frames) markedly weaker than adaptive
      // mode at the same slider position. These sit in the upper half of the
      // adaptive range, since a fixed curve has to cover both dark and bright
      // scenes.
      staticLiftScale: 0.8,
      staticRollScale: 0.85,
    },
  };
}

export function mapStrength(strength: number): ProcessingParams {
  return {
    audio: mapAudioStrength(strength),
    video: mapVideoStrength(strength),
  };
}

/** Human-readable bucket for the popup. */
export function describeStrength(strength: number): string {
  const value = normalizeStrength(strength);
  if (value <= 0) return 'Bypass';
  if (value < 20) return 'Very gentle';
  if (value < 40) return 'Gentle';
  if (value < 60) return 'Balanced';
  if (value < 80) return 'Strong';
  return 'Maximum';
}
