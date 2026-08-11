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
 * highlights roll off instead of clipping. `a` is solved so that full-scale
 * input lands exactly on the requested white point.
 *
 * The adaptation is scene-gated: dark scenes engage the shadow lift, bright
 * scenes engage the exposure dim and the highlight shoulder, and a normally
 * exposed scene engages *neither* — the curve converges on the identity and
 * the video passes through untouched. The corrections are for the extremes;
 * applying them to content that needs none is what washes an image out.
 *
 * Two things make the result read as "dimmer" rather than "flatter":
 *
 *  - **The drive signal is linear light.** `mean` averages gamma-encoded luma,
 *    which is a measure of how dark a frame *looks*, dominated by however much
 *    of the frame is dark. A dashcam shot is half black dashboard and half
 *    overcast sky: its encoded mean says "normal", while the sky is throwing
 *    real light at the viewer. `light` averages in linear light and answers the
 *    question that actually matters — how much light is coming off the screen —
 *    so the exposure servo and the shadow-lift veto both run off it.
 *
 *  - **Slope is allocated by content.** A curve that dims must lose slope
 *    somewhere; the only question is where. A fixed shoulder always spends it
 *    at the top of the range, which on a bright scene is exactly where the
 *    pixels are densest. Given the frame histogram, `buildToneCurve` instead
 *    redistributes slope towards the levels the scene actually occupies and
 *    away from the empty ones, in proportion to how much range the dimming took
 *    away. Without a histogram it falls back to the plain parametric curve.
 *
 * Everything in this module is pure so it can be unit tested without a DOM,
 * and so the render loop can cheaply diff the produced curve.
 */
import type { VideoParams } from './types';
import { approach, clamp, clamp01, lerp, round, smoothstep } from './math';

/** Luminance histogram resolution used by `computeSceneStats`. */
export const HIST_BINS = 64;

/** Per-frame luminance summary, all values normalised to 0..1. */
export interface SceneStats {
  mean: number;
  /** ~10th percentile luma: how deep the shadows sit. */
  shadow: number;
  /** ~90th percentile luma: where the highlights sit. */
  highlight: number;
  /** ~99.5th percentile luma, robust stand-in for peak white. */
  peak: number;
  /**
   * Mean *linear* luminance, re-encoded onto the same 0..1 scale as `mean`:
   * how much light the frame emits, rather than how dark it looks. Always
   * >= `mean`, and much larger for high-contrast frames.
   *
   * Optional: a caller with only a coarse summary may omit it, and `mean` is
   * used instead. That is the pre-linear-light behaviour, and it under-reads
   * mixed scenes — it is a fallback, not an equivalent.
   */
  light?: number;
  /**
   * Normalised luminance histogram, `HIST_BINS` entries summing to 1. Optional
   * for the same reason; without it the tone curve keeps its parametric shape.
   */
  histogram?: ArrayLike<number>;
}

/**
 * Where the adaptation is heading. Recomputed only when a frame is actually
 * analysed; the integration towards it runs on every presented frame.
 *
 * The split exists because the two halves have very different costs. Deciding
 * the targets needs a pixel read-back, which is the expensive part and the
 * reason the engine skips frames at high resolutions. Moving towards them is a
 * handful of `exp` calls. Fusing the two made the skip rate govern both, so a
 * video that could only afford analysis every fourth frame also only got its
 * curve rewritten every fourth frame — and a ramp delivered in quarter-second
 * jumps is a visible staircase, however correct each individual jump is.
 */
export interface AdaptTargets {
  exposure: number;
  lift: number;
  roll: number;
  /** Raw histogram of the last analysed frame, or null when frames carry none. */
  histogram: Float32Array | null;
}

export interface AdaptState {
  exposure: number;
  liftScale: number;
  rollScale: number;
  /** 0..1 flash-guard amount, decays over time. */
  flash: number;
  prevMean: number;
  initialized: boolean;
  /** Resting place for the three scales above; see {@link AdaptTargets}. */
  targets: AdaptTargets;
  /**
   * Time-smoothed frame histogram, or null when frames carry none. Smoothed
   * because a curve rebuilt from raw per-frame statistics visibly pumps.
   */
  histogram?: Float32Array | null;
  /**
   * The *raw* histogram of the previous analysed frame, kept only so the next
   * one can measure how far the scene moved. Deliberately not the smoothed
   * `histogram`: that one lags by design, and comparing against a lagged
   * reference turns half a second of ordinary motion into an apparent cut.
   */
  prevHistogram?: Float32Array | null;
  /**
   * How much of the last step was treated as a scene change rather than as
   * continuous motion, 0..1. At 1 the state snapped straight onto its targets.
   * Exposed so the render loop can push the resulting curve immediately.
   */
  cut: number;
}

export function createAdaptState(): AdaptState {
  // Neutral until the first analysed frame snaps it onto the scene: a video we
  // have not measured yet must look untouched, not pre-treated.
  return {
    exposure: 1,
    liftScale: 0,
    rollScale: 0,
    flash: 0,
    prevMean: 0,
    initialized: false,
    targets: { exposure: 1, lift: 0, roll: 0, histogram: null },
    histogram: null,
    prevHistogram: null,
    cut: 0,
  };
}

/**
 * Fixed state used when frames cannot be analysed (DRM, tainted canvas). The
 * result is an honest static curve: no scene tracking, no flash guard, and no
 * histogram, so the slope allocation stays out of it too.
 */
export function staticAdaptState(params: VideoParams): AdaptState {
  const lift = params.adapt.staticLiftScale;
  const roll = params.adapt.staticRollScale;
  return {
    exposure: 1,
    liftScale: lift,
    rollScale: roll,
    flash: 0,
    prevMean: 0,
    initialized: true,
    // Its own resting place, so advancing it is a no-op rather than a slow
    // drift back to the identity curve.
    targets: { exposure: 1, lift, roll, histogram: null },
    histogram: null,
    prevHistogram: null,
    cut: 0,
  };
}

/**
 * How far towards the exposure servo's floor an unmeasured still is dimmed.
 *
 * `minExposure` is the servo's answer to a frame it has *measured* to be over
 * the light budget. Applying it to every picture on a page would dim the dark
 * half of them exactly as hard as the bright half; unity would dim none of
 * them. Half way is the honest constant for content whose brightness is
 * unknown, and it still scales with the slider, so the setting keeps ownership
 * of how large the effect is.
 */
export const IMAGE_EXPOSURE_SHARE = 0.5;

/**
 * Fixed state used for still images.
 *
 * Stills are treated blind, and the reason is the canvas taint rule rather than
 * cost: most pictures on a page are served from another origin without CORS
 * headers, so their pixels cannot be read at all. Measuring the minority that
 * can be read would tone two photographs sitting side by side differently
 * depending on which CDN happened to serve them, which is a worse artefact than
 * treating both the same.
 *
 * So the curve is the half of the tone map that is safe without knowing what it
 * is looking at: a modest exposure reduction and the highlight shoulder, with
 * the shadow lift held at zero.
 *
 * The lift is the part that must not run blind. It exists to open up a night
 * scene, and it brightens everything below the knee to do it — applied to a
 * page of photographs it would raise the light coming off the screen, which is
 * the opposite of the point. The shoulder has no such failure mode: it only
 * ever darkens, and only above the knee, so on a dark picture it does nothing
 * at all. That is why it is armed in full here while the lift is not armed at
 * all.
 */
export function imageAdaptState(params: VideoParams): AdaptState {
  const exposure = lerp(1, clamp(params.adapt.minExposure, 0.2, 1), IMAGE_EXPOSURE_SHARE);
  return {
    exposure,
    liftScale: 0,
    rollScale: 1,
    flash: 0,
    prevMean: 0,
    initialized: true,
    // Its own resting place: nothing advances this state, but a caller that
    // does must find it already where it belongs.
    targets: { exposure, lift: 0, roll: 1, histogram: null },
    histogram: null,
    prevHistogram: null,
    cut: 0,
  };
}

/** sRGB electro-optical transfer function: encoded 0..1 -> linear light 0..1. */
export function toLinearLight(value: number): number {
  const v = clamp01(value);
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Inverse of {@link toLinearLight}. */
export function toEncodedLight(value: number): number {
  const v = clamp01(value);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Linear light of each histogram bin centre, so the mean costs no `pow` per pixel. */
const BIN_LIGHT = Float64Array.from({ length: HIST_BINS }, (_, bin) =>
  toLinearLight((bin + 0.5) / HIST_BINS),
);

/** Smallest luma rise that can count as a flash, regardless of how fast it is. */
const FLASH_MIN_JUMP = 0.06;
/** Luma rise that produces the maximum dim. */
const FLASH_FULL_JUMP = 0.35;
/**
 * Lower bounds for the adaptive scales *once a scene reads as dark*. A dark
 * scene starts from these instead of zero so the lift is decisive and the
 * highlight shoulder is already armed when a bright cut arrives. They are
 * deliberately not global floors: a normally exposed scene gets no lift and no
 * roll-off at all, because applying either to content that needs no correction
 * is exactly what washes an image out.
 */
export const DARK_LIFT_FLOOR = 0.55;
export const DARK_ROLL_FLOOR = 0.8;

/**
 * How the adaptation decides a scene needs treatment at all.
 *
 * `darkNeed` spans 0..1 as the mean falls from the target luma to black; the
 * night machinery engages smoothly over the first DARK_ENGAGE_SPAN of it, so a
 * scene is fully "dark" at mean ~0.24 and not at all at the target (0.34).
 */
const DARK_ENGAGE_SPAN = 0.3;

/**
 * Emitted light (see `SceneStats.light`) that reads as comfortable at night.
 * Above it the exposure servo dims by exactly the ratio needed to bring the
 * frame back to it, bounded by `minExposure`; at or below it nothing happens.
 *
 * A ratio rather than a threshold-and-lerp because it self-calibrates: the dim
 * is proportional to how far over budget the frame is, it is continuous at the
 * boundary, and it does not need a second "fully bright" constant tuned against
 * content nobody has measured. Multiplying every encoded value by `m` scales
 * linear light by `m^2.4`, hence emitted light by roughly `m` — so `m =
 * COMFORT_LIGHT / light` is the gain that lands the frame on budget.
 */
export const COMFORT_LIGHT = 0.36;
/** How far over the light budget a frame must be to read as fully "bright". */
const BRIGHT_NEED_FULL = 0.3;
/**
 * Emitted light at which the shadow lift starts and finishes being vetoed.
 *
 * The lift is for night scenes. A frame can read dark by mean and still be
 * throwing light at the viewer — a dark car interior wrapped around a bright
 * windscreen is the case that motivated this — and opening its shadows makes it
 * brighter *and* flatter, which is the worst of both. Emitted light settles it:
 * whatever the mean says, a frame this bright is not a night scene.
 */
const LIFT_VETO_START = 0.34;
const LIFT_VETO_FULL = 0.46;
/** p90 luma below which highlights are not glare and the shoulder stays out. */
const GLARE_START = 0.75;
/** p90 luma that counts as fully blown highlights. */
const GLARE_FULL = 0.95;

/** Time constant (s) for smoothing the frame histogram. */
const HIST_TAU = 0.5;

/**
 * Time constants (s) for the shadow lift and the highlight shoulder. Slower
 * than the exposure servo on purpose: these change the *shape* of the curve,
 * and a shape change is more visible than a level change.
 */
const LIFT_TAU = 1.2;
const ROLL_TAU = 0.8;

/**
 * Scene-change detection.
 *
 * `sceneShift` measures how far the frame's luminance distribution *travelled*
 * since the last analysed frame, in luma units. The thresholds below are then
 * the same shape as the flash guard's: a magnitude floor, because a cut between
 * two similarly lit shots moves the curve's target so little that snapping and
 * easing are indistinguishable, and a rate gate, because a deliberate fade
 * travels the same distance at a rate that is a property of the content rather
 * than of how often we happen to sample.
 *
 * At 60 Hz the magnitude floor is the binding one (0.08 luma in a 16 ms step is
 * already 4.8 luma/s of continuous change, which nothing shot by a human does).
 * The rate gate is what keeps the 8 Hz timer fallback honest: at that interval a
 * cut and a fast pan genuinely are not distinguishable, so only large, fast
 * moves get any snap credit at all.
 */
export const CUT_MIN_SHIFT = 0.08;
export const CUT_FULL_SHIFT = 0.22;
const CUT_RATE_START = 1.5;
const CUT_RATE_FULL = 4;

/**
 * How much of the flash guard survives a cut that the exposure servo has
 * already answered by itself.
 *
 * The guard was doing two jobs at once: covering the servo's lag (the scene is
 * bright *now*, the servo needs `dimTau` to get there) and blunting the
 * transient itself. Snapping removes the first job, so stacking the whole guard
 * on top of an already-correct exposure just over-dims. What remains is the
 * second job, which is real: the eye is dark-adapted at the moment of a cut out
 * of a night scene, and `flashTau` is roughly how long that lasts.
 *
 * The damping is scaled by how much dimming the snap actually delivered, not
 * merely by whether a cut happened — see `updateAdaptState`. On content already
 * pinned at `minExposure` the servo has no room left to move, the snap
 * contributes nothing, and the guard is the only transient protection there is.
 */
export const FLASH_CUT_RESIDUAL = 0.4;

/**
 * How far the luminance distribution moved between two frames, in luma units.
 *
 * This is the 1-D Wasserstein (earth-mover) distance between the two
 * histograms, which both callers below want and a plain bin-by-bin difference
 * is not. A low-contrast frame — fog, a title card, a night interior — keeps
 * nearly all of its mass in one or two bins, so a slow fade relocates *all* of
 * it every time the level crosses a bin boundary. Bin-difference metrics read
 * that as "100% of the frame changed" and would snap several times a second
 * through a two-second dissolve. Transport distance reads it as one bin width
 * (0.016), which is what it is.
 *
 * Both histograms must be normalised to sum to 1 (as `computeSceneStats`
 * produces them). When either is missing, `meanDelta` is used instead: it is a
 * strict lower bound on the transport distance, because moving mass `m` across
 * a luma gap `d` moves the mean by at most `m * d`. So the fallback can only
 * ever under-detect a cut, never invent one.
 */
export function sceneShift(
  next: ArrayLike<number> | undefined,
  previous: ArrayLike<number> | null | undefined,
  meanDelta: number,
): number {
  const fallback = clamp01(Math.abs(meanDelta));
  const bins = next?.length ?? 0;
  if (!next || !previous || bins === 0 || previous.length !== bins) return fallback;

  // One pass, carrying the running difference of the two CDFs: the integral of
  // |F - G| over 0..1 is exactly the transport distance.
  let carry = 0;
  let work = 0;
  for (let i = 0; i < bins; i++) {
    const a = next[i] as number;
    const b = previous[i] as number;
    carry += (Number.isFinite(a) ? a : 0) - (Number.isFinite(b) ? b : 0);
    work += Math.abs(carry);
  }
  // The max is a no-op for consistent inputs, since the bound above holds. It
  // matters only for a caller whose histogram and mean disagree.
  return clamp01(Math.max(work / bins, fallback));
}

/** The two ends of the adaptive range: a bright scene and a dark one. */
export function adaptBounds(params: VideoParams): { bright: AdaptState; dark: AdaptState } {
  const base = {
    flash: 0,
    prevMean: 0,
    initialized: true,
    histogram: null,
    prevHistogram: null,
    cut: 0,
  };
  const bright = { exposure: params.adapt.minExposure, liftScale: 0, rollScale: 1 };
  const dark = {
    exposure: params.adapt.maxExposure,
    liftScale: 1,
    rollScale: DARK_ROLL_FLOOR,
  };
  const resting = (s: typeof bright): AdaptTargets => ({
    exposure: s.exposure,
    lift: s.liftScale,
    roll: s.rollScale,
    histogram: null,
  });
  return {
    bright: { ...base, ...bright, targets: resting(bright) },
    dark: { ...base, ...dark, targets: resting(dark) },
  };
}

/**
 * Luminance statistics from an RGBA byte buffer (as produced by
 * `CanvasRenderingContext2D.getImageData`). Uses Rec.709 luma weights.
 */
export function computeSceneStats(rgba: ArrayLike<number>): SceneStats {
  const hist = new Float32Array(HIST_BINS);
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

  if (total === 0) {
    return { mean: 0, shadow: 0, highlight: 0, peak: 0, light: 0 };
  }

  const percentile = (p: number): number => {
    const wanted = p * total;
    let seen = 0;
    for (let bin = 0; bin < HIST_BINS; bin++) {
      seen += hist[bin] as number;
      if (seen >= wanted) return (bin + 0.5) / HIST_BINS;
    }
    return 1;
  };

  // Read the percentiles off the counts before the bins are normalised below.
  const shadow = percentile(0.1);
  const highlight = percentile(0.9);
  const peak = percentile(0.995);

  // Linear-light mean and the normalised histogram, both off the bins: 64
  // `pow`s per frame instead of one per pixel, and the bin quantisation is far
  // below the precision the adaptation acts on.
  let linear = 0;
  for (let bin = 0; bin < HIST_BINS; bin++) {
    const count = hist[bin] as number;
    linear += count * (BIN_LIGHT[bin] as number);
    hist[bin] = count / total;
  }

  return {
    mean: clamp01(sum / total),
    shadow,
    highlight,
    peak,
    light: clamp01(toEncodedLight(linear / total)),
    histogram: hist,
  };
}

/**
 * Exponentially smooth the incoming histogram into the one held in state.
 * `snap` (0..1) pulls the blend towards taking the new frame whole, so a cut
 * re-shapes the slope allocation on the same frame the rest of the state does.
 */
function blendHistogram(
  previous: Float32Array | null | undefined,
  next: ArrayLike<number> | null | undefined,
  step: number,
  snap: number,
): Float32Array | null {
  if (!next || next.length === 0) return null;
  const out = new Float32Array(next.length);
  const fresh = !previous || previous.length !== next.length;
  const k = fresh ? 1 : lerp(1 - Math.exp(-step / HIST_TAU), 1, clamp01(snap));
  for (let i = 0; i < next.length; i++) {
    const target = next[i] as number;
    const value = Number.isFinite(target) ? Math.max(0, target) : 0;
    out[i] = fresh ? value : (previous?.[i] ?? 0) + (value - (previous?.[i] ?? 0)) * k;
  }
  return out;
}

/**
 * Move the adaptation `dt` seconds closer to its current targets.
 *
 * Deliberately free of `SceneStats`: this is the half that runs on *every*
 * presented frame, including the ones the engine chose not to analyse. Nothing
 * here needs to know what the scene looks like, only where it was last seen
 * heading, so the cost is a few `exp` calls and the smoothness of the result no
 * longer depends on how often a read-back is affordable.
 *
 * `snap` (0..1) blends the eased value towards the target and is non-zero only
 * on an analysed frame that read as a scene change — see
 * {@link updateAdaptState}, which is the only caller that passes it.
 */
export function advanceAdaptState(
  state: AdaptState,
  params: VideoParams,
  dt: number,
  snap = 0,
): AdaptState {
  const cfg = params.adapt;
  const step = Number.isFinite(dt) ? clamp(dt, 1 / 240, 1) : 1 / 60;
  const cut = clamp01(snap);
  const targets = state.targets;

  // Direction is settled by where the target sits relative to where we are now.
  // An exponential approach cannot overshoot, so this cannot flip mid-ramp and
  // is the same answer the measuring frame would have computed.
  const exposureTau = targets.exposure < state.exposure ? cfg.dimTau : cfg.recoverTau;
  const ease = (current: number, target: number, tau: number): number =>
    lerp(approach(current, target, step, tau), target, cut);

  return {
    ...state,
    exposure: clamp(ease(state.exposure, targets.exposure, exposureTau), 0.2, 2),
    liftScale: clamp01(ease(state.liftScale, targets.lift, LIFT_TAU)),
    rollScale: clamp01(ease(state.rollScale, targets.roll, ROLL_TAU)),
    flash: clamp01(approach(state.flash, 0, step, cfg.flashTau)),
    histogram: blendHistogram(state.histogram, targets.histogram, step, cut),
    cut,
  };
}

/**
 * Analyse a frame: re-aim the targets, then advance by `dt` like any other
 * frame.
 *
 * Asymmetric time constants are the core of the comfort behaviour: dimming
 * happens quickly (a scene got bright, protect the viewer) while recovery is
 * slow (avoid visible breathing). A separate fast-acting flash guard handles
 * single-sample luminance jumps such as cuts to white or camera flashes.
 *
 * Those time constants are the right answer for *continuous* footage and the
 * wrong one at a cut. Easing exists to hide a correction inside content that is
 * already moving; at a cut there is nothing to hide it in, and nothing that
 * needs hiding either, because the cut itself masks any change made on the same
 * frame. Easing is actively worse there: the new scene arrives, the curve does
 * not, and the picture visibly drifts for up to `recoverTau` afterwards.
 *
 * So the state is eased and snapped in the same expression. `cut` (0..1) blends
 * between the eased value and the target and reaches 1 once the frame's
 * luminance distribution has moved far enough, fast enough, to be a scene change
 * rather than motion — see {@link sceneShift}. The first analysed frame is a
 * full cut by definition, which is where the old first-frame special case went.
 *
 * Two clocks, because a caller that skips frames has two different intervals
 * and the rate tests want the other one. `dt` is this frame's share of the
 * integration, matching what {@link advanceAdaptState} was handed on every
 * frame in between. `sinceMeasure` is how long ago the frame these statistics
 * are being compared against was taken, which is what `jump` and `shift` were
 * accumulated over — dividing those by one frame instead would read a stride of
 * 4 as a scene changing four times as fast as it is, and fire the flash guard
 * on ordinary motion. They are equal, and both default to `dt`, whenever the
 * caller analyses every frame it advances.
 */
export function updateAdaptState(
  state: AdaptState,
  stats: SceneStats,
  params: VideoParams,
  dt: number,
  sinceMeasure = dt,
): AdaptState {
  const cfg = params.adapt;
  // Clamped to a plausible frame interval: the flash test divides by it, so a
  // bogus dt must not be able to manufacture an enormous rate.
  const step = Number.isFinite(dt) ? clamp(dt, 1 / 240, 1) : 1 / 60;
  const span = Number.isFinite(sinceMeasure) ? clamp(sinceMeasure, 1 / 240, 1) : step;
  const mean = clamp01(stats.mean);
  const shadow = clamp01(stats.shadow);
  const highlight = clamp01(stats.highlight);
  // How much light the frame emits, as opposed to how dark it looks.
  const light = Math.max(clamp01(stats.light ?? stats.mean), 1e-3);

  // --- scene change --------------------------------------------------------
  // How far the distribution travelled, and how much of that reads as a cut
  // rather than as motion. Both gates are smoothstepped rather than thresholded
  // so there is no pair of near-identical frames either side of a cliff, one
  // easing and one snapping.
  const shift = sceneShift(stats.histogram, state.prevHistogram, mean - state.prevMean);
  const cut = state.initialized
    ? smoothstep(clamp01((shift - CUT_MIN_SHIFT) / (CUT_FULL_SHIFT - CUT_MIN_SHIFT))) *
      smoothstep(clamp01((shift / span - CUT_RATE_START) / (CUT_RATE_FULL - CUT_RATE_START)))
    : 1;

  // --- exposure ------------------------------------------------------------
  // Only ever pull bright scenes down. Dark scenes are opened up with the
  // shadow curve instead, because multiplying a dark frame amplifies noise.
  // The target is the gain that lands emitted light on the comfort budget,
  // floored by what the strength setting allows. Resolved before the flash
  // guard because the guard needs to know what the servo is about to do.
  const targetExposure = clamp(COMFORT_LIGHT / light, cfg.minExposure, cfg.maxExposure);

  // --- flash guard ---------------------------------------------------------
  // Two conditions must hold: the mean must rise *fast* (rate test, so the
  // result does not depend on the sampling interval) and it must rise *far*
  // enough to matter. The dim amount comes from the magnitude, so a cut from a
  // dark scene to white dims hard while a modest cut barely registers.
  let flash = state.flash;
  if (state.initialized) {
    const jump = mean - state.prevMean;
    if (jump > FLASH_MIN_JUMP && jump / span > cfg.flashRate) {
      const magnitude = clamp01((jump - FLASH_MIN_JUMP) / (FLASH_FULL_JUMP - FLASH_MIN_JUMP));
      flash = Math.max(flash, magnitude);
    }
    // Hand the guard's first job — covering the servo's lag — over to the snap,
    // but only to the extent the snap can actually do it. `snapDim` is the
    // fraction of brightness the servo is removing on this frame by itself and
    // `guardDim` is what the guard would remove; the guard is scaled back in
    // proportion to how much of its own contribution has been made redundant.
    //
    // The distinction matters on content already pinned at `minExposure`: the
    // servo has no room left, `snapDim` is 0, and the guard stays at full
    // strength because it is then the only transient protection there is.
    // Damping on the bare presence of a cut lost most of the response to a
    // white flash over a bright scene, which is where it is needed most.
    const snapDim = clamp01(1 - targetExposure / Math.max(state.exposure, 1e-3));
    const guardDim = flash * clamp01(cfg.flashDim);
    const covered = guardDim > 0 ? clamp01(snapDim / guardDim) : 0;
    flash *= 1 - cut * covered * (1 - FLASH_CUT_RESIDUAL);
    // The decay itself belongs to the per-frame half, so the guard releases on
    // the same clock whether or not this frame happened to be analysed.
  } else {
    flash = 0;
  }

  // --- scene classification ------------------------------------------------
  // One question decides whether the night machinery engages at all: does this
  // scene actually need correcting? A normally exposed scene must pass through
  // untouched — lifting its blacks and gamma-brightening its mid-tones is
  // precisely what washes an image out, and was the original release's defect.
  //
  // The two halves ask different questions of different signals. "Does this
  // look dark?" is about the distribution, so it reads the encoded mean. "Is
  // this throwing light at me?" is about output, so it reads linear light. A
  // frame can honestly answer yes to both (a night scene with a street lamp)
  // or to neither, and the gates below keep the two from fighting.
  const darkNeed = clamp01((cfg.targetLuma - mean) / cfg.targetLuma);
  const darkEngage = smoothstep(clamp01(darkNeed / DARK_ENGAGE_SPAN));
  const brightNeed = clamp01(1 - COMFORT_LIGHT / light);
  const brightEngage = smoothstep(clamp01(brightNeed / BRIGHT_NEED_FULL));
  const liftVeto = smoothstep(
    clamp01((light - LIFT_VETO_START) / (LIFT_VETO_FULL - LIFT_VETO_START)),
  );

  // --- shadow lift ---------------------------------------------------------
  // Crushed shadow detail only counts once the scene as a whole reads dark and
  // is not also emitting a lot of light: a well-exposed frame legitimately
  // contains true blacks, and those must stay black instead of engaging the
  // lift.
  const shadowNeed = clamp01((0.14 - shadow) / 0.14);
  const targetLift =
    darkEngage *
    (1 - liftVeto) *
    (DARK_LIFT_FLOOR + (1 - DARK_LIFT_FLOOR) * Math.max(darkNeed, shadowNeed));

  // --- highlight roll-off --------------------------------------------------
  // The shoulder engages for actual glare (hot top decile or a bright scene)
  // and stays armed while the scene is dark: bright cuts arrive *from* dark
  // scenes, so the roll-off has to already be in place at the moment of the
  // cut. In between — a normal scene — it disengages entirely.
  const glare = clamp01((highlight - GLARE_START) / (GLARE_FULL - GLARE_START));
  const targetRoll = clamp01(Math.max(darkEngage * DARK_ROLL_FLOOR, glare, brightEngage));

  // This frame's raw histogram serves two purposes and is copied once for both:
  // it is the comparison reference the next analysed frame measures its shift
  // against, and it is what the smoothed histogram eases towards in between.
  // Neither side writes to it. 256 bytes per analysed frame, against the ~5 KB
  // read-back that produced it.
  const frame =
    stats.histogram && stats.histogram.length > 0 ? Float32Array.from(stats.histogram) : null;

  // Re-aim, then take this frame's step like any other. Everything above is the
  // part that needed pixels; the integration below is shared with every frame
  // the engine did not analyse.
  return advanceAdaptState(
    {
      ...state,
      flash: clamp01(flash),
      prevMean: mean,
      initialized: true,
      targets: {
        exposure: targetExposure,
        lift: targetLift,
        roll: targetRoll,
        histogram: frame,
      },
      prevHistogram: frame,
    },
    params,
    step,
    cut,
  );
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
  /** Saturation compensation, scaled by how engaged the shadow lift is. */
  saturation: number;
  /** Where full-scale input lands after exposure and the shadow stage. */
  headroom: number;
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

  // Where full-scale input lands *before* the shoulder. The shoulder is placed
  // and solved against this rather than against 1.0, because exposure has
  // already moved it. Solving against 1.0 made the two stages fight: exposure
  // pulled white down, then the shoulder pulled it down again from a ceiling it
  // had already left, so the top of the range was dimmed twice and flattened
  // twice while the mid-tones got nothing.
  const headroom = clamp01(lift + (1 - lift) * Math.pow(clamp01(exposure), 1 / gamma));
  const kneeStart = clamp(params.kneeStart, 0.05, 1) * headroom;
  const shoulder = clamp01(
    params.highlightCompression * clamp01(state.rollScale) + flashAmount * FLASH_WHITE_PULL,
  );
  const whitePoint = clamp(headroom * (1 - shoulder), kneeStart + 1e-4, 1);
  const kneeScale = solveKneeScale(headroom - kneeStart, whitePoint - kneeStart);
  // The saturation boost pays for the flattening the shadow gamma causes, so
  // it scales with the lift: a fully dark scene gets the whole compensation, a
  // normal scene — whose colours were never touched — gets exactly none.
  const saturation = 1 + (params.saturation - 1) * clamp01(state.liftScale);
  return { exposure, lift, gamma, kneeStart, whitePoint, kneeScale, saturation, headroom };
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
 * Slope allocation.
 *
 * A curve that dims has less output range than input range, so its average
 * slope is below 1 and *some* contrast is going to be lost. These constants
 * decide where it is lost from.
 */
/** A level may claim at most this multiple of its uniform share of the frame. */
const SLOPE_CLIP_LIMIT = 3;
/** How far towards a population-proportional allocation to go, at full engagement. */
const SLOPE_ALLOCATION = 0.7;
/** Hard bounds on any one interval's slope multiplier. */
const SLOPE_WEIGHT_MIN = 0.55;
const SLOPE_WEIGHT_MAX = 1.8;
/** Range loss at which the allocation is fully engaged. */
const SLOPE_PAYBACK_SPAN = 0.3;

/**
 * Turn a luminance histogram into one slope multiplier per LUT interval.
 *
 * Weights average 1, so they say only where slope should move, not how much of
 * it there is: intervals the scene actually occupies get more, empty ones get
 * less. `redistribute()` applies them, sets the level and enforces the
 * per-interval bounds, since only it knows the slopes involved. `amount` is 0
 * for a curve that is not dimming (nothing to pay back, so nothing to
 * redistribute) and 1 once the dimming has cost `SLOPE_PAYBACK_SPAN` of range.
 *
 * The clip limit is what keeps this from becoming histogram equalisation: a
 * large flat region — a black dashboard, a letterbox bar — would otherwise
 * claim slope proportional to its area and get amplified noise for it.
 */
export function slopeWeights(
  histogram: ArrayLike<number>,
  intervals: number,
  amount: number,
): Float64Array | null {
  const engagement = clamp01(amount) * SLOPE_ALLOCATION;
  const bins = histogram.length;
  if (!(bins > 1) || !(intervals > 0) || engagement <= 0) return null;

  // Resample the histogram onto the LUT's interval grid.
  const mass = new Float64Array(intervals);
  let total = 0;
  for (let bin = 0; bin < bins; bin++) {
    const value = histogram[bin] as number;
    if (!Number.isFinite(value) || value <= 0) continue;
    const slot = Math.min(intervals - 1, Math.floor(((bin + 0.5) / bins) * intervals));
    mass[slot] = (mass[slot] as number) + value;
    total += value;
  }
  if (!(total > 0)) return null;

  // Blur across neighbouring intervals so no feature in the curve is narrower
  // than the LUT can represent: a spiky curve interpolates into visible
  // banding on flat gradients.
  const kernel = [1, 4, 6, 4, 1];
  const smoothed = new Float64Array(intervals);
  for (let i = 0; i < intervals; i++) {
    let sum = 0;
    let weight = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j < 0 || j >= intervals) continue;
      const kw = kernel[k + 2] as number;
      sum += (mass[j] as number) * kw;
      weight += kw;
    }
    smoothed[i] = sum / weight;
  }

  const ceiling = (total / intervals) * SLOPE_CLIP_LIMIT;
  let clipped = 0;
  for (let i = 0; i < intervals; i++) {
    const value = Math.min(smoothed[i] as number, ceiling);
    smoothed[i] = value;
    clipped += value;
  }
  const average = clipped / intervals;
  if (!(average > 0)) return null;

  // `share` averages exactly 1, so these do too: they say where slope should
  // move, not how much of it there is. `redistribute()` sets the level and
  // enforces the per-interval bounds, because only it knows the slopes the
  // multipliers are about to be applied to.
  const weights = new Float64Array(intervals);
  for (let i = 0; i < intervals; i++) {
    const share = (smoothed[i] as number) / average; // 1 == this level's fair share
    weights[i] = Math.max(0, 1 + engagement * (share - 1));
  }
  return weights;
}

/**
 * Rescale a curve's per-interval slopes by `weights`, preserving its endpoints.
 *
 * No interval may end up outside `[SLOPE_WEIGHT_MIN, SLOPE_WEIGHT_MAX]` times
 * the slope it started with — an unbounded allocation turns a large flat region
 * (a black dashboard, a letterbox bar) into amplified noise, and starves the
 * sparse ends of the range of what little slope they had. Enforcing that
 * without moving the endpoints means whatever a clamped interval gives up has
 * to be taken by the intervals still free to accept it, which needs a couple of
 * passes to settle.
 */
function redistribute(base: readonly number[], weights: ArrayLike<number>): number[] {
  const n = base.length;
  const slopes = new Float64Array(n - 1);
  let total = 0;
  for (let i = 0; i < n - 1; i++) {
    const slope = Math.max(0, (base[i + 1] as number) - (base[i] as number));
    slopes[i] = slope;
    total += slope;
  }
  if (!(total > 0)) return base.slice();

  const out = new Float64Array(n - 1);
  let weighted = 0;
  for (let i = 0; i < n - 1; i++) {
    out[i] = (slopes[i] as number) * Math.max(0, weights[i] as number);
    weighted += out[i] as number;
  }
  if (!(weighted > 0)) return base.slice();
  const scale = total / weighted;
  for (let i = 0; i < n - 1; i++) out[i] = (out[i] as number) * scale;

  for (let pass = 0; pass < 8; pass++) {
    let residual = 0;
    let freeSlope = 0;
    for (let i = 0; i < n - 1; i++) {
      const slope = slopes[i] as number;
      const capped = clamp(out[i] as number, slope * SLOPE_WEIGHT_MIN, slope * SLOPE_WEIGHT_MAX);
      residual += (out[i] as number) - capped;
      out[i] = capped;
      if (capped > slope * SLOPE_WEIGHT_MIN && capped < slope * SLOPE_WEIGHT_MAX) {
        freeSlope += slope;
      }
    }
    if (freeSlope <= 0 || Math.abs(residual) < 1e-12) break;
    for (let i = 0; i < n - 1; i++) {
      const slope = slopes[i] as number;
      if ((out[i] as number) > slope * SLOPE_WEIGHT_MIN && (out[i] as number) < slope * SLOPE_WEIGHT_MAX) {
        out[i] = (out[i] as number) + (residual * slope) / freeSlope;
      }
    }
  }

  // A histogram extreme enough that the bounds cannot absorb the residual would
  // otherwise move the white point, which the popup and the documentation quote
  // as a fixed number. The endpoint wins: relax the bounds rather than the
  // curve's stated range.
  let settled = 0;
  for (let i = 0; i < n - 1; i++) settled += out[i] as number;
  if (settled > 0 && Math.abs(settled - total) > 1e-9) {
    const fix = total / settled;
    for (let i = 0; i < n - 1; i++) out[i] = (out[i] as number) * fix;
  }

  const result = new Array<number>(n);
  result[0] = base[0] as number;
  for (let i = 0; i < n - 1; i++) {
    result[i + 1] = clamp01((result[i] as number) + (out[i] as number));
  }
  return result;
}

/**
 * Sample the transfer function into a lookup table for
 * `<feFuncR type="table">`. 33 samples is the sweet spot: SVG interpolates
 * linearly between entries, and the slope allocation is blurred so the curve
 * has no features narrower than that.
 */
export function buildToneCurve(params: VideoParams, state: AdaptState, size = 33): number[] {
  const n = Math.max(2, Math.floor(size));
  if (params.bypass) {
    return Array.from({ length: n }, (_, i) => i / (n - 1));
  }
  const resolved = resolveCurve(params, state);
  const base = new Array<number>(n);
  let previous = 0;
  for (let i = 0; i < n; i++) {
    // Guard monotonicity explicitly; downstream code and tests rely on it.
    const value = Math.max(previous, applyCurve(resolved, i / (n - 1)));
    base[i] = value;
    previous = value;
  }

  if (!state.histogram) return base;
  // Redistribute in proportion to the range the curve just gave up. A scene
  // that is being left alone has none to give up and is left exactly alone.
  const lost = 1 - ((base[n - 1] as number) - (base[0] as number));
  const weights = slopeWeights(state.histogram, n - 1, lost / SLOPE_PAYBACK_SPAN);
  return weights ? redistribute(base, weights) : base;
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
  const saturation = clamp(resolved.saturation, 0.5, 2);
  return `brightness(${round(brightness, 3)}) contrast(${round(contrast, 3)}) saturate(${round(
    saturation,
    3,
  )})`;
}
