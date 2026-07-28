/**
 * Adaptive tone mapping maths.
 *
 * The curve is a three-stage transfer function evaluated per channel:
 *
 *   1. exposure       v = x * exposure            (scene-dependent dimming)
 *   2. shadow opening v = v^(1/gamma) then a small black-point lift
 *   3. highlight knee v > k  ->  k + a*(1 - e^-((v-k)/a))
 *
 * Stage 3 is C1-continuous at the knee (slope exactly 1 there) and its slope
 * decreases monotonically afterwards, so mid-tone contrast survives while
 * highlights roll off instead of clipping. `a` is solved so that input 1.0
 * lands exactly on the requested white point.
 *
 * Everything in this module is pure so it can be unit tested without a DOM,
 * and so the render loop can cheaply diff the produced curve.
 */
import type { VideoParams } from './types';
import { approach, clamp, clamp01, round } from './math';

/** Per-frame luminance summary, all values normalised to 0..1. */
export interface SceneStats {
  mean: number;
  /** ~10th percentile luma: how deep the shadows sit. */
  shadow: number;
  /** ~90th percentile luma: where the highlights sit. */
  highlight: number;
  /** ~99.5th percentile luma, robust stand-in for peak white. */
  peak: number;
}

export interface AdaptState {
  exposure: number;
  liftScale: number;
  rollScale: number;
  /** 0..1 flash-guard amount, decays over time. */
  flash: number;
  prevMean: number;
  initialized: boolean;
}

export function createAdaptState(): AdaptState {
  return { exposure: 1, liftScale: 0.6, rollScale: 0.7, flash: 0, prevMean: 0, initialized: false };
}

/**
 * Fixed state used when frames cannot be analysed (DRM, tainted canvas). The
 * result is an honest static curve: no scene tracking, no flash guard.
 */
export function staticAdaptState(params: VideoParams): AdaptState {
  return {
    exposure: 1,
    liftScale: params.adapt.staticLiftScale,
    rollScale: params.adapt.staticRollScale,
    flash: 0,
    prevMean: 0,
    initialized: true,
  };
}

const HIST_BINS = 64;

/** Smallest luma rise that can count as a flash, regardless of how fast it is. */
const FLASH_MIN_JUMP = 0.06;
/** Luma rise that produces the maximum dim. */
const FLASH_FULL_JUMP = 0.35;
/**
 * Lower bounds for the adaptive scales, so the curve is never scaled away.
 * Exported so the popup can draw the band the curve moves within.
 */
export const LIFT_FLOOR = 0.55;
export const ROLL_FLOOR = 0.6;

/** The two ends of the adaptive range: a bright scene and a dark one. */
export function adaptBounds(): { bright: AdaptState; dark: AdaptState } {
  const base = { exposure: 1, flash: 0, prevMean: 0, initialized: true };
  return {
    bright: { ...base, liftScale: LIFT_FLOOR, rollScale: 1 },
    dark: { ...base, liftScale: 1, rollScale: ROLL_FLOOR },
  };
}

/**
 * Luminance statistics from an RGBA byte buffer (as produced by
 * `CanvasRenderingContext2D.getImageData`). Uses Rec.709 luma weights.
 */
export function computeSceneStats(rgba: ArrayLike<number>): SceneStats {
  const hist = new Uint32Array(HIST_BINS);
  let total = 0;
  let sum = 0;

  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const r = rgba[i] as number;
    const g = rgba[i + 1] as number;
    const b = rgba[i + 2] as number;
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    sum += luma;
    total++;
    const bin = Math.min(HIST_BINS - 1, (luma * HIST_BINS) | 0);
    hist[bin] = (hist[bin] as number) + 1;
  }

  if (total === 0) return { mean: 0, shadow: 0, highlight: 0, peak: 0 };

  const percentile = (p: number): number => {
    const wanted = p * total;
    let seen = 0;
    for (let bin = 0; bin < HIST_BINS; bin++) {
      seen += hist[bin] as number;
      if (seen >= wanted) return (bin + 0.5) / HIST_BINS;
    }
    return 1;
  };

  return {
    mean: clamp01(sum / total),
    shadow: percentile(0.1),
    highlight: percentile(0.9),
    peak: percentile(0.995),
  };
}

/**
 * Advance the adaptation loop by `dt` seconds.
 *
 * Asymmetric time constants are the core of the comfort behaviour: dimming
 * happens quickly (a scene got bright, protect the viewer) while recovery is
 * slow (avoid visible breathing). A separate fast-acting flash guard handles
 * single-sample luminance jumps such as cuts to white or camera flashes.
 */
export function updateAdaptState(
  state: AdaptState,
  stats: SceneStats,
  params: VideoParams,
  dt: number,
): AdaptState {
  const cfg = params.adapt;
  // Clamped to a plausible frame interval: the flash test divides by it, so a
  // bogus dt must not be able to manufacture an enormous rate.
  const step = Number.isFinite(dt) ? clamp(dt, 1 / 240, 1) : 1 / 60;
  const mean = clamp01(stats.mean);
  const shadow = clamp01(stats.shadow);
  const highlight = clamp01(stats.highlight);

  // --- flash guard ---------------------------------------------------------
  // Two conditions must hold: the mean must rise *fast* (rate test, so the
  // result does not depend on the sampling interval) and it must rise *far*
  // enough to matter. The dim amount comes from the magnitude, so a cut from a
  // dark scene to white dims hard while a modest cut barely registers.
  let flash = state.flash;
  if (state.initialized) {
    const jump = mean - state.prevMean;
    if (jump > FLASH_MIN_JUMP && jump / step > cfg.flashRate) {
      const magnitude = clamp01((jump - FLASH_MIN_JUMP) / (FLASH_FULL_JUMP - FLASH_MIN_JUMP));
      flash = Math.max(flash, magnitude);
    }
    flash = approach(flash, 0, step, cfg.flashTau);
  } else {
    flash = 0;
  }

  // --- exposure ------------------------------------------------------------
  // Only ever pull bright scenes down. Dark scenes are opened up with the
  // shadow curve instead, because multiplying a dark frame amplifies noise.
  const targetExposure =
    mean > cfg.targetLuma
      ? clamp(cfg.targetLuma / Math.max(mean, 0.02), cfg.minExposure, cfg.maxExposure)
      : cfg.maxExposure;
  const exposureTau = targetExposure < state.exposure ? cfg.dimTau : cfg.recoverTau;

  // --- shadow lift ---------------------------------------------------------
  const darkNeed = clamp01((cfg.targetLuma - mean) / cfg.targetLuma);
  const shadowNeed = clamp01((0.14 - shadow) / 0.14);
  const targetLift = clamp(LIFT_FLOOR + (1 - LIFT_FLOOR) * Math.max(darkNeed, shadowNeed), 0, 1);

  // --- highlight roll-off --------------------------------------------------
  // The floor matters more than it looks: bright cuts arrive *from* dark
  // scenes, so if the shoulder were scaled away while the scene is dark there
  // would be nothing in place at the moment of the cut.
  const highlightNeed = clamp01((highlight - 0.55) / 0.35);
  const brightNeed = clamp01((mean - cfg.targetLuma) / 0.35);
  const targetRoll = clamp(ROLL_FLOOR + (1 - ROLL_FLOOR) * Math.max(highlightNeed, brightNeed), 0, 1);

  if (!state.initialized) {
    // Snap on the first analysed frame so playback does not start with a
    // visible ramp.
    return {
      exposure: targetExposure,
      liftScale: targetLift,
      rollScale: targetRoll,
      flash: 0,
      prevMean: mean,
      initialized: true,
    };
  }

  return {
    exposure: clamp(approach(state.exposure, targetExposure, step, exposureTau), 0.2, 2),
    liftScale: clamp01(approach(state.liftScale, targetLift, step, 1.2)),
    rollScale: clamp01(approach(state.rollScale, targetRoll, step, 0.8)),
    flash: clamp01(flash),
    prevMean: mean,
    initialized: true,
  };
}

/**
 * Solve `a * (1 - exp(-span / a)) = target` for a > 0.
 * The left side increases monotonically from 0 to `span`, so bisection is
 * both safe and fast (and cheaper than pulling in a solver).
 */
export function solveKneeScale(span: number, target: number): number {
  if (!(span > 0) || !(target > 0)) return Number.POSITIVE_INFINITY;
  if (target >= span) return Number.POSITIVE_INFINITY; // no compression needed
  let lo = 1e-6;
  let hi = 1e4;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const value = mid * (1 - Math.exp(-span / mid));
    if (value < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface ResolvedCurve {
  exposure: number;
  lift: number;
  gamma: number;
  kneeStart: number;
  whitePoint: number;
  kneeScale: number;
}

/** Extra white-point reduction per unit of flash, on top of the exposure dip. */
const FLASH_WHITE_PULL = 0.45;

/** Combine static params with the adaptive state into concrete curve numbers. */
export function resolveCurve(params: VideoParams, state: AdaptState): ResolvedCurve {
  // A flash does two things: it dips exposure (whole image) and it pulls the
  // white point down (highlights specifically). Exposure alone is not enough,
  // because the shoulder damps most of it right where the glare lives.
  const flashAmount = clamp01(state.flash) * clamp01(params.adapt.flashDim);
  const exposure = clamp(
    params.exposure * clamp(state.exposure, 0.2, 2) * (1 - flashAmount),
    0.2,
    2,
  );
  const lift = clamp(params.blackLift * clamp01(state.liftScale), 0, 0.2);
  const gamma = clamp(1 + (params.shadowGamma - 1) * clamp01(state.liftScale), 1, 3);
  const kneeStart = clamp(params.kneeStart, 0.05, 1);
  const span = 1 - kneeStart;
  const whitePoint = clamp(
    1 - params.highlightCompression * clamp01(state.rollScale) - flashAmount * FLASH_WHITE_PULL,
    kneeStart + 1e-4,
    1,
  );
  const kneeScale = solveKneeScale(span, whitePoint - kneeStart);
  return { exposure, lift, gamma, kneeStart, whitePoint, kneeScale };
}

/** Evaluate the transfer function for a single normalised channel value. */
export function applyCurve(curve: ResolvedCurve, x: number): number {
  let v = clamp01(x) * curve.exposure;
  if (v > 1) v = 1;
  if (v > 0 && curve.gamma !== 1) v = Math.pow(v, 1 / curve.gamma);
  v = curve.lift + (1 - curve.lift) * v;
  if (v > curve.kneeStart && Number.isFinite(curve.kneeScale)) {
    const a = curve.kneeScale;
    v = curve.kneeStart + a * (1 - Math.exp(-(v - curve.kneeStart) / a));
  }
  return clamp01(v);
}

/**
 * Sample the transfer function into a lookup table for
 * `<feFuncR type="table">`. 33 samples is the sweet spot: SVG interpolates
 * linearly between entries, and the curve has no features narrower than that.
 */
export function buildToneCurve(params: VideoParams, state: AdaptState, size = 33): number[] {
  const n = Math.max(2, Math.floor(size));
  if (params.bypass) {
    return Array.from({ length: n }, (_, i) => i / (n - 1));
  }
  const resolved = resolveCurve(params, state);
  const out = new Array<number>(n);
  let previous = 0;
  for (let i = 0; i < n; i++) {
    // Guard monotonicity explicitly; downstream code and tests rely on it.
    const value = Math.max(previous, applyCurve(resolved, i / (n - 1)));
    out[i] = value;
    previous = value;
  }
  return out;
}

export function curveToTableValues(curve: readonly number[], decimals = 4): string {
  return curve.map((v) => round(v, decimals)).join(' ');
}

/**
 * Fallback for engines without SVG filter support: fit `brightness()` and
 * `contrast()` to the same curve through two sample points. This is a linear
 * approximation, it cannot reproduce the shoulder, and the video engine
 * reports the technique as `css-basic` when it is used.
 */
export function cssApproxFilter(params: VideoParams, state: AdaptState): string {
  if (params.bypass) return 'none';
  const resolved = resolveCurve(params, state);
  const y2 = applyCurve(resolved, 0.2);
  const y8 = applyCurve(resolved, 0.8);
  const slope = (y8 - y2) / 0.6;
  const contrast = clamp(1 - 2 * y2 + 0.4 * slope, 0.2, 1.5);
  const brightness = clamp(slope / contrast, 0.4, 1.6);
  const saturation = clamp(params.saturation, 0.5, 2);
  return `brightness(${round(brightness, 3)}) contrast(${round(contrast, 3)}) saturate(${round(
    saturation,
    3,
  )})`;
}
