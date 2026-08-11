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
 *  - Peaks are targeted at up to -4 dBFS after make-up gain so the limiter
 *    only ever catches transients instead of doing the heavy lifting.
 *  - Release time grows with strength: heavier compression with a short
 *    release is what produces audible pumping.
 */
import type {
  AudioParams,
  CompressorParams,
  EqParams,
  ProcessingParams,
  Settings,
  VideoParams,
} from './types';
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

/** Flat EQ: the nodes stay in the graph, they just do nothing. */
const NEUTRAL_EQ: Readonly<EqParams> = Object.freeze({
  enabled: false,
  lowShelfHz: 120,
  lowShelfDb: 0,
  presenceHz: 2600,
  presenceDb: 0,
  presenceQ: 0.9,
});

export function neutralEqParams(): EqParams {
  return { ...NEUTRAL_EQ };
}

export function neutralAudioParams(): AudioParams {
  return {
    bypass: true,
    preGainDb: 0,
    eq: neutralEqParams(),
    compressor: { ...NEUTRAL_COMPRESSOR },
    makeupGainDb: 0,
    limiter: { ...NEUTRAL_COMPRESSOR },
    safety: { ...IDENTITY_SOFT_CLIP },
  };
}

/**
 * Night EQ.
 *
 * Compression solves "I cannot hear the dialogue", but the reason you turn the
 * volume down at night is low frequency: bass passes through walls and floors
 * where midrange does not. So the low shelf comes down, and a wide bell in the
 * consonant range comes up to buy back intelligibility that would otherwise be
 * lost with it.
 *
 * Both are scaled by the same smoothstepped strength as everything else, so
 * strength 0 stays a true bypass even with the toggle on. The presence lift is
 * kept modest and wide (Q 0.9) because a narrow boost here sounds like a
 * telephone, and 2.6 kHz is where consonants live rather than sibilance.
 */
export function mapEqStrength(strength: number, enabled: boolean): EqParams {
  const t = normalizeStrength(strength) / 100;
  if (!enabled || t <= 0) return neutralEqParams();
  const s = smoothstep(t);
  return {
    enabled: true,
    lowShelfHz: 120,
    lowShelfDb: lerp(0, -7, s),
    presenceHz: 2600,
    presenceDb: lerp(0, 3.5, s),
    presenceQ: 0.9,
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
 * Signal path:
 *   source -> preGain -> lowShelf -> presence -> compressor -> makeupGain
 *          -> limiter -> safetyTrim -> softClip -> out
 *
 * @param strength 0..100 slider position.
 * @param nightEq  Whether the tone-shaping stage is engaged.
 */
export function mapAudioStrength(strength: number, nightEq = false): AudioParams {
  const t = normalizeStrength(strength) / 100;
  if (t <= 0) return neutralAudioParams();

  const s = smoothstep(t);
  const eq = mapEqStrength(strength, nightEq);

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
  //
  // The presence lift is subtracted rather than ignored: it sits *before* the
  // compressor, so broadband material arrives hotter than the peak model above
  // assumes. Paying for it in make-up gain keeps the same headroom guarantee
  // instead of leaning on the limiter to absorb the difference.
  const targetPeakDb = lerp(0, -4, s) - eq.presenceDb;
  const makeupGainDb = clamp(targetPeakDb - peakOutDb, 0, 24);

  return {
    bypass: false,
    preGainDb,
    eq,
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
    // Both of these are fractions of the range the curve still has after
    // exposure, not of full scale. Exposure is what makes a bright scene
    // *darker*; the shoulder only softens the top of whatever is left, so it
    // stays up in the highlights where glare lives. A knee low enough to reach
    // into the mid-tones flattens the part of the picture the viewer is
    // actually looking at, which reads as washed out rather than dimmed.
    kneeStart: lerp(0.9, 0.6, s),
    highlightCompression: lerp(0, 0.22, s),
    exposure: 1,
    saturation: lerp(1, 1.18, s),
    adapt: {
      enabled: true,
      targetLuma: 0.34,
      // How far the exposure servo is allowed to dim a scene that is over the
      // light budget. This is the ceiling on the whole effect for bright
      // content: at the previous 0.65 the strongest possible response to a
      // blazing daylight scene was -35%, and at the default strength -15%,
      // which is not enough to read as "it got darker".
      minExposure: lerp(1, 0.5, s),
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

export function mapStrength(strength: number, nightEq = false): ProcessingParams {
  return {
    audio: mapAudioStrength(strength, nightEq),
    video: mapVideoStrength(strength),
  };
}

/**
 * The whole settings object in one call. Everything that drives the engines
 * goes through here, so the sound group's own switches cannot be honoured in
 * one place and forgotten in another.
 */
export function mapSettings(settings: Settings): ProcessingParams {
  return {
    audio: mapAudioStrength(settings.audioStrength, settings.nightEq),
    video: mapVideoStrength(settings.videoStrength),
  };
}

/**
 * Steady-state output level for a given input level, in dBFS.
 *
 * This is a *model* of the chain, not a measurement of it: it assumes the
 * signal has been at `inputDb` long enough for the attack and release to have
 * settled, and it uses Chromium's soft-knee shape analytically rather than
 * rendering audio. Transients land above this line by design.
 *
 * It exists so the popup can draw the audio side of the slider the same way it
 * draws the video tone curve, from the real parameters rather than from a
 * decorative picture. `scripts/smoke.mjs` renders the actual chain offline and
 * bounds the error between the two.
 */
export function audioTransferDb(params: AudioParams, inputDb: number): number {
  if (params.bypass) return inputDb;

  // Chromium's knee spans `threshold .. threshold + knee`, with a quadratic
  // interpolation of the gain reduction across it.
  const stage = (levelDb: number, { thresholdDb, kneeDb, ratio }: CompressorParams): number => {
    if (!(ratio > 1)) return levelDb;
    const over = levelDb - thresholdDb;
    if (over <= 0) return levelDb;
    const slope = 1 - 1 / ratio;
    if (kneeDb > 0 && over < kneeDb) return levelDb - (slope * over * over) / (2 * kneeDb);
    return levelDb - slope * (over - kneeDb / 2);
  };

  let level = inputDb + params.preGainDb;
  // Broadband speech and music carry most of their energy below the presence
  // bell, so only part of its gain shows up in the overall level.
  if (params.eq.enabled) level += params.eq.presenceDb * 0.5 + params.eq.lowShelfDb * 0.35;
  level = stage(level, params.compressor);
  level += chromiumInternalMakeupDb(params.compressor.thresholdDb, params.compressor.ratio);
  level += params.makeupGainDb;
  level = stage(level, params.limiter);

  // The soft clipper's ceiling, expressed in dB, is the hard bound.
  const ceilingDb = 20 * Math.log10(Math.max(params.safety.ceiling, 1e-6));
  return Math.min(level, ceilingDb);
}

/**
 * Human-readable bucket for the popup.
 *
 * "Maximum" is reserved for the top of the range. Applying it from 80 upwards
 * meant the popup read "80 · maximum" with the slider visibly short of the end,
 * which is a small lie the rest of this UI does not tell.
 */
export function describeStrength(strength: number): string {
  const value = normalizeStrength(strength);
  if (value <= 0) return 'Bypass';
  if (value < 20) return 'Very gentle';
  if (value < 40) return 'Gentle';
  if (value < 60) return 'Balanced';
  if (value < 80) return 'Strong';
  if (value < 95) return 'Very strong';
  return 'Maximum';
}
