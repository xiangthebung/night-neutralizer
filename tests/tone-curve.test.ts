import { describe, expect, it } from 'vitest';
import {
  COMFORT_LIGHT,
  DARK_LIFT_FLOOR,
  DARK_ROLL_FLOOR,
  FLASH_CUT_RESIDUAL,
  HIST_BINS,
  adaptBounds,
  advanceAdaptState,
  applyCurve,
  brightWhitePoint,
  buildToneCurve,
  computeSceneStats,
  createAdaptState,
  cssApproxFilter,
  curveToTableValues,
  imageAdaptState,
  resolveCurve,
  sceneShift,
  slopeWeights,
  solveKneeScale,
  staticAdaptState,
  toEncodedLight,
  toLinearLight,
  updateAdaptState,
  whitePointCeiling,
  type SceneStats,
} from '../src/core/tone-curve';
import { mapVideoStrength } from '../src/core/strength';

const params = mapVideoStrength(60);
const maxParams = mapVideoStrength(100);

function flatFrame(luma: number, pixels = 64): Uint8ClampedArray {
  const data = new Uint8ClampedArray(pixels * 4);
  const value = Math.round(luma * 255);
  for (let i = 0; i < pixels; i++) {
    data[i * 4] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }
  return data;
}

describe('computeSceneStats', () => {
  it('handles an empty buffer', () => {
    expect(computeSceneStats(new Uint8ClampedArray(0))).toEqual({
      mean: 0,
      shadow: 0,
      highlight: 0,
      peak: 0,
      light: 0,
    });
  });

  it('measures a flat mid-grey frame', () => {
    const stats = computeSceneStats(flatFrame(0.5));
    expect(stats.mean).toBeCloseTo(0.5, 2);
    expect(stats.shadow).toBeCloseTo(0.5, 1);
    expect(stats.highlight).toBeCloseTo(0.5, 1);
  });

  it('separates shadows from highlights in a split frame', () => {
    const data = new Uint8ClampedArray(100 * 4);
    for (let i = 0; i < 100; i++) {
      const value = i < 50 ? 10 : 240;
      data[i * 4] = value;
      data[i * 4 + 1] = value;
      data[i * 4 + 2] = value;
      data[i * 4 + 3] = 255;
    }
    const stats = computeSceneStats(data);
    expect(stats.shadow).toBeLessThan(0.15);
    expect(stats.highlight).toBeGreaterThan(0.85);
    expect(stats.mean).toBeGreaterThan(0.4);
    expect(stats.mean).toBeLessThan(0.6);
  });

  it('uses Rec.709 weights', () => {
    const green = new Uint8ClampedArray([0, 255, 0, 255]);
    const blue = new Uint8ClampedArray([0, 0, 255, 255]);
    expect(computeSceneStats(green).mean).toBeCloseTo(0.7152, 3);
    expect(computeSceneStats(blue).mean).toBeCloseTo(0.0722, 3);
  });
});

describe('solveKneeScale', () => {
  it('solves the soft-knee equation', () => {
    const span = 0.4;
    const target = 0.25;
    const a = solveKneeScale(span, target);
    expect(a * (1 - Math.exp(-span / a))).toBeCloseTo(target, 6);
  });

  it('returns infinity when no compression is required', () => {
    expect(solveKneeScale(0.4, 0.4)).toBe(Number.POSITIVE_INFINITY);
    expect(solveKneeScale(0, 0.1)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('buildToneCurve', () => {
  it('is the identity when bypassed', () => {
    const curve = buildToneCurve(mapVideoStrength(0), createAdaptState(), 5);
    expect(curve).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('is monotonic and inside [0,1] across the whole strength range', () => {
    for (const strength of [1, 10, 25, 45, 70, 90, 100]) {
      const p = mapVideoStrength(strength);
      for (const state of [createAdaptState(), staticAdaptState(p)]) {
        const curve = buildToneCurve(p, state);
        expect(curve).toHaveLength(33);
        for (let i = 0; i < curve.length; i++) {
          const value = curve[i] as number;
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
          if (i > 0) expect(value).toBeGreaterThanOrEqual(curve[i - 1] as number);
        }
      }
    }
  });

  it('lifts shadows without crushing black', () => {
    const state = { ...createAdaptState(), liftScale: 1, initialized: true };
    const curve = buildToneCurve(maxParams, state);
    const first = curve[0] as number;
    const low = curve[2] as number; // x = 0.0625
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(0.1);
    // A dark input must end up clearly brighter than it started.
    expect(low).toBeGreaterThan(0.0625 * 1.5);
  });

  it('is clearly visible at the default strength on a dark scene', () => {
    // The regression the user hit: at the default the curve moved shadows by
    // hundredths and highlights by thousandths.
    const defaults = mapVideoStrength(45);
    let state = createAdaptState();
    for (let i = 0; i < 80; i++) {
      state = updateAdaptState(
        state,
        { mean: 0.18, shadow: 0.04, highlight: 0.45, peak: 0.6 },
        defaults,
        0.125,
      );
    }
    const resolved = resolveCurve(defaults, state);
    expect(applyCurve(resolved, 0.05)).toBeGreaterThan(0.1); // >2x
    expect(applyCurve(resolved, 0.1)).toBeGreaterThan(0.17);
    expect(applyCurve(resolved, 1)).toBeLessThan(0.94); // whites pulled back
  });

  it('never scales the shoulder away while a scene is dark', () => {
    // Bright cuts arrive *from* dark scenes, so the roll-off has to already be
    // in place when the cut happens.
    const defaults = mapVideoStrength(45);
    let state = createAdaptState();
    for (let i = 0; i < 200; i++) {
      state = updateAdaptState(
        state,
        { mean: 0.08, shadow: 0.02, highlight: 0.2, peak: 0.3 },
        defaults,
        0.125,
      );
    }
    expect(state.rollScale).toBeGreaterThanOrEqual(0.55);
    expect(resolveCurve(defaults, state).whitePoint).toBeLessThan(0.95);
  });

  it('compresses highlights below the original white point', () => {
    const state = { ...createAdaptState(), rollScale: 1, initialized: true };
    const curve = buildToneCurve(maxParams, state);
    expect(curve[curve.length - 1] as number).toBeLessThan(0.95);
  });

  it('reduces slope towards the highlights (soft shoulder)', () => {
    const state = { ...createAdaptState(), liftScale: 1, rollScale: 1, initialized: true };
    const curve = buildToneCurve(maxParams, state, 65);
    const slope = (i: number) => (curve[i + 1] as number) - (curve[i] as number);
    const shadowSlope = slope(2);
    const midSlope = slope(32);
    const highlightSlope = slope(60);
    expect(shadowSlope).toBeGreaterThan(midSlope);
    expect(midSlope).toBeGreaterThan(highlightSlope);
  });

  it('keeps mid-tones from washing out', () => {
    const state = { ...createAdaptState(), liftScale: 1, rollScale: 1, initialized: true };
    const resolved = resolveCurve(maxParams, state);
    const mid = applyCurve(resolved, 0.5);
    // Lifted, but nowhere near flat grey.
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(0.72);
  });

  it('dims everything when the flash guard fires', () => {
    const calm = { ...createAdaptState(), initialized: true, flash: 0 };
    const flashing = { ...calm, flash: 1 };
    const a = buildToneCurve(maxParams, calm);
    const b = buildToneCurve(maxParams, flashing);
    expect(b[24] as number).toBeLessThan(a[24] as number);
  });
});

describe('updateAdaptState', () => {
  const stats = (mean: number, shadow = mean * 0.4, highlight = Math.min(1, mean * 1.6)): SceneStats => ({
    mean,
    shadow,
    highlight,
    peak: Math.min(1, highlight + 0.05),
  });

  it('snaps on the first sample and marks itself initialised', () => {
    const next = updateAdaptState(createAdaptState(), stats(0.8), params, 0.125);
    expect(next.initialized).toBe(true);
    expect(next.flash).toBe(0);
    expect(next.exposure).toBeLessThan(1);
  });

  it('pulls exposure down for bright scenes and leaves dark scenes alone', () => {
    let state = updateAdaptState(createAdaptState(), stats(0.75), params, 0.125);
    for (let i = 0; i < 40; i++) state = updateAdaptState(state, stats(0.75), params, 0.125);
    expect(state.exposure).toBeLessThan(0.9);
    expect(state.exposure).toBeGreaterThanOrEqual(params.adapt.minExposure);

    let dark = updateAdaptState(createAdaptState(), stats(0.08), params, 0.125);
    for (let i = 0; i < 40; i++) dark = updateAdaptState(dark, stats(0.08), params, 0.125);
    expect(dark.exposure).toBeCloseTo(1, 3);
    expect(dark.liftScale).toBeGreaterThan(0.8);
  });

  it('opens shadows more in dark scenes than in bright ones', () => {
    let dark = createAdaptState();
    let bright = createAdaptState();
    for (let i = 0; i < 60; i++) {
      dark = updateAdaptState(dark, stats(0.1), params, 0.125);
      bright = updateAdaptState(bright, stats(0.6, 0.4), params, 0.125);
    }
    expect(dark.liftScale).toBeGreaterThan(bright.liftScale);
  });

  it('dims faster than it recovers', () => {
    // The asymmetry governs *continuous* change; a cut snaps in both directions
    // (see the scene-change suite). So drive both directions from the same
    // distance to the same target, with the scene held still so nothing snaps.
    let settled = createAdaptState();
    for (let i = 0; i < 40; i++) settled = updateAdaptState(settled, stats(0.9), params, 0.125);
    const target = settled.exposure;
    const gap = 0.2;

    const dimming = updateAdaptState({ ...settled, exposure: target + gap }, stats(0.9), params, 0.125);
    const recovering = updateAdaptState({ ...settled, exposure: target - gap }, stats(0.9), params, 0.125);
    expect(dimming.cut).toBe(0);
    expect(recovering.cut).toBe(0);

    expect(target + gap - dimming.exposure).toBeGreaterThan(recovering.exposure - (target - gap));
  });

  it('detects a hard cut at any sampling rate, and a fade at none', () => {
    // The threshold is a rate (luma/second), so the behaviour must not depend
    // on how often we sample. With a per-sample delta it did.
    const settle = (dt: number) => {
      let state = createAdaptState();
      for (let i = 0; i < Math.ceil(2 / dt); i++) {
        state = updateAdaptState(state, stats(0.12), params, dt);
      }
      return state;
    };

    for (const dt of [1 / 60, 1 / 30, 0.125]) {
      const before = settle(dt);
      const cut = updateAdaptState(before, stats(0.92), params, dt);
      // The guard fires, damped by the snap that now handles the servo's lag...
      expect(cut.flash).toBeGreaterThan(0.2);
      // ...and what the viewer actually gets is a picture that is already much
      // dimmer on this very frame, rather than dimTau later.
      expect(resolveCurve(params, cut).exposure).toBeLessThan(
        resolveCurve(params, before).exposure * 0.8,
      );
    }

    // A deliberate 2 s fade from 0.12 to 0.92 must never trip the guard,
    // whatever the sampling rate.
    for (const dt of [1 / 60, 1 / 30, 0.125]) {
      let state = settle(dt);
      const steps = Math.round(2 / dt);
      for (let i = 1; i <= steps; i++) {
        state = updateAdaptState(state, stats(0.12 + (0.8 * i) / steps), params, dt);
        expect(state.flash).toBeLessThan(0.05);
      }
    }
  });

  it('scales the dim with the size of the jump', () => {
    let base = createAdaptState();
    for (let i = 0; i < 60; i++) base = updateAdaptState(base, stats(0.2), params, 1 / 60);
    const small = updateAdaptState(base, stats(0.29), params, 1 / 60);
    const large = updateAdaptState(base, stats(0.9), params, 1 / 60);
    expect(small.flash).toBeGreaterThan(0);
    expect(small.flash).toBeLessThan(0.5);
    // The guard alone no longer carries the whole response to a big jump — the
    // snap does most of it — so the ordering is on the rendered result.
    expect(large.flash).toBeGreaterThan(small.flash);
    expect(resolveCurve(params, large).exposure).toBeLessThan(
      resolveCurve(params, small).exposure * 0.9,
    );

    // ...and a tiny wobble is ignored entirely.
    const wobble = updateAdaptState(base, stats(0.24), params, 1 / 60);
    expect(wobble.flash).toBe(0);
    expect(wobble.cut).toBe(0);
  });

  it('dims the rendered white level meaningfully when a flash fires', () => {
    const calm = { ...createAdaptState(), initialized: true, liftScale: 0.8, rollScale: 0.8 };
    const flashing = { ...calm, flash: 1 };
    const before = applyCurve(resolveCurve(params, calm), 1);
    const after = applyCurve(resolveCurve(params, flashing), 1);
    // >=15% drop in encoded white is ~30% less emitted light.
    expect(after).toBeLessThan(before * 0.85);
    // The guard takes more light out of the highlights than out of the
    // mid-tones, which is where the glare actually is.
    const midBefore = applyCurve(resolveCurve(params, calm), 0.4);
    const midAfter = applyCurve(resolveCurve(params, flashing), 0.4);
    expect(before - after).toBeGreaterThan(midBefore - midAfter);
  });

  it('reacts to a sudden luminance jump with the flash guard', () => {
    let state = createAdaptState();
    for (let i = 0; i < 20; i++) state = updateAdaptState(state, stats(0.15), params, 0.125);
    expect(state.flash).toBe(0);

    const flashed = updateAdaptState(state, stats(0.95), params, 0.125);
    expect(flashed.flash).toBeGreaterThan(0.2);

    // ...and decays once the scene settles.
    let after = flashed;
    for (let i = 0; i < 40; i++) after = updateAdaptState(after, stats(0.95), params, 0.125);
    expect(after.flash).toBeLessThan(0.05);
  });

  it('ignores gradual brightening (no false flash)', () => {
    let state = createAdaptState();
    for (let i = 0; i < 30; i++) {
      state = updateAdaptState(state, stats(0.1 + i * 0.02), params, 0.125);
      expect(state.flash).toBeLessThan(0.05);
    }
  });

  it('stays bounded with hostile input', () => {
    let state = createAdaptState();
    const hostile: SceneStats = { mean: Number.NaN, shadow: -5, highlight: 12, peak: Number.NaN };
    for (let i = 0; i < 10; i++) state = updateAdaptState(state, hostile, params, Number.NaN);
    expect(Number.isFinite(state.exposure)).toBe(true);
    expect(state.exposure).toBeGreaterThan(0);
    expect(state.liftScale).toBeGreaterThanOrEqual(0);
    expect(state.liftScale).toBeLessThanOrEqual(1);
    expect(state.rollScale).toBeGreaterThanOrEqual(0);
    expect(state.rollScale).toBeLessThanOrEqual(1);
  });

  it('never adapts when the params are a bypass', () => {
    const bypass = mapVideoStrength(0);
    const curve = buildToneCurve(bypass, updateAdaptState(createAdaptState(), stats(0.9), bypass, 0.1));
    expect(curve[curve.length - 1]).toBe(1);
    expect(curve[0]).toBe(0);
  });
});

describe('scene gating (the washed-out-normal-video regression)', () => {
  // The original release applied the night curve to every scene: global floors
  // on the lift and roll-off meant a normally exposed video had its blacks
  // greyed, its mid-tones gamma-brightened and its whites pulled down — washed
  // out and sometimes brighter than the original. These tests pin the fix.
  //
  // The invariant is "never washed out", not "never touched": a frame over the
  // light budget is dimmed on purpose, and dimming by a scale is not washing
  // out. What must never happen is a lifted black point, a gamma-brightened
  // mid-tone or a flattened top on a scene that did not ask for one.
  const settle = (p: ReturnType<typeof mapVideoStrength>, s: SceneStats, ticks = 80) => {
    let state = createAdaptState();
    for (let i = 0; i < ticks; i++) state = updateAdaptState(state, s, p, 0.125);
    return state;
  };

  it('leaves a scene inside the light budget completely alone', () => {
    // The dead band, and the proof that the exposure servo is not simply
    // dimming everything: a mid-exposed frame that is not throwing much light
    // gets the identity, not a slightly-dimmer version of itself.
    const defaults = mapVideoStrength(45);
    const state = settle(defaults, {
      mean: 0.35,
      shadow: 0.2,
      highlight: 0.52,
      peak: 0.6,
      light: COMFORT_LIGHT,
    });
    const resolved = resolveCurve(defaults, state);
    expect(resolved.exposure).toBeCloseTo(1, 6);
    expect(resolved.lift).toBe(0);
    expect(resolved.gamma).toBe(1);
    for (const x of [0, 0.25, 0.5, 0.75, 1]) {
      expect(applyCurve(resolved, x)).toBeCloseTo(x, 6);
    }
  });

  it('dims a normally exposed video without washing it out', () => {
    // A normal frame that *is* over the light budget does come down — that is
    // the whole job at night — but it comes down by a clean scale. Nothing
    // greys the blacks, nothing flattens the mid-tones, nothing touches the
    // colour: it reads as "the brightness came down", not "the contrast went".
    const defaults = mapVideoStrength(45);
    const state = settle(defaults, { mean: 0.45, shadow: 0.12, highlight: 0.78, peak: 0.9 });
    const resolved = resolveCurve(defaults, state);
    expect(resolved.lift).toBe(0);
    expect(resolved.gamma).toBe(1);
    expect(resolved.saturation).toBe(1);
    expect(applyCurve(resolved, 0)).toBe(0); // blacks stay black
    expect(resolved.exposure).toBeLessThan(0.95); // ...and it really is dimmer
    // Everything below the shoulder is the input times one constant, so every
    // ratio in the picture survives intact.
    for (const x of [0.1, 0.25, 0.5]) {
      expect(applyCurve(resolved, x)).toBeCloseTo(x * resolved.exposure, 6);
    }
  });

  it('does not treat ordinary true blacks in a normal scene as crushed shadows', () => {
    // A well-exposed frame legitimately contains near-black pixels; that alone
    // must not engage the night lift.
    const defaults = mapVideoStrength(45);
    const state = settle(defaults, { mean: 0.4, shadow: 0.02, highlight: 0.7, peak: 0.85 });
    expect(state.liftScale).toBeLessThan(0.01);
    expect(resolveCurve(defaults, state).lift).toBeLessThan(0.001);
  });

  it('dims a bright scene without lifting its blacks or flattening mid-tones', () => {
    const defaults = mapVideoStrength(45);
    const state = settle(defaults, { mean: 0.7, shadow: 0.35, highlight: 0.9, peak: 0.98 });
    const resolved = resolveCurve(defaults, state);
    expect(resolved.exposure).toBeCloseTo(defaults.adapt.minExposure, 2);
    expect(resolved.lift).toBe(0);
    expect(resolved.gamma).toBe(1);
    expect(applyCurve(resolved, 0)).toBe(0);
    // Whites are genuinely neutralised...
    expect(applyCurve(resolved, 1)).toBeLessThan(0.87);
    // ...while dark detail scales with the exposure instead of being greyed:
    // the result reads as "the brightness came down", not "the contrast went".
    expect(applyCurve(resolved, 0.1)).toBeCloseTo(0.1 * resolved.exposure, 3);
  });

  it('still fully engages on a dark scene (the half that already worked)', () => {
    const defaults = mapVideoStrength(45);
    const state = settle(defaults, { mean: 0.12, shadow: 0.03, highlight: 0.3, peak: 0.4 });
    expect(state.liftScale).toBeGreaterThanOrEqual(DARK_LIFT_FLOOR);
    expect(state.rollScale).toBeCloseTo(DARK_ROLL_FLOOR, 2);
    const resolved = resolveCurve(defaults, state);
    expect(applyCurve(resolved, 0.05)).toBeGreaterThan(0.1); // >2x on deep shadow
    expect(resolved.saturation).toBeGreaterThan(1.05);
  });
});

/**
 * A frame built from flat regions, as `[encoded luma, fraction of the frame]`.
 * Enough to reproduce the shapes that broke the mean-driven classifier.
 */
function sceneFrame(regions: Array<[number, number]>, pixels = 48 * 27): Uint8ClampedArray {
  const data = new Uint8ClampedArray(pixels * 4);
  let i = 0;
  for (const [luma, fraction] of regions) {
    const value = Math.round(luma * 255);
    for (let k = 0; k < Math.round(fraction * pixels) && i < pixels; k++, i++) {
      data[i * 4] = value;
      data[i * 4 + 1] = value;
      data[i * 4 + 2] = value;
      data[i * 4 + 3] = 255;
    }
  }
  for (; i < pixels; i++) data[i * 4 + 3] = 255;
  return data;
}

/** Emitted light of a frame after the curve, on the same scale as `stats.light`. */
function litAfter(stats: SceneStats, curve: readonly number[]): number {
  const at = (x: number): number => {
    const position = x * (curve.length - 1);
    const low = Math.floor(position);
    const high = Math.min(curve.length - 1, low + 1);
    const a = curve[low] as number;
    return a + ((curve[high] as number) - a) * (position - low);
  };
  let linear = 0;
  for (let bin = 0; bin < HIST_BINS; bin++) {
    const share = (stats.histogram?.[bin] as number) ?? 0;
    linear += share * toLinearLight(at((bin + 0.5) / HIST_BINS));
  }
  return toEncodedLight(linear);
}

const settleOn = (p: ReturnType<typeof mapVideoStrength>, stats: SceneStats, ticks = 300) => {
  let state = createAdaptState();
  for (let i = 0; i < ticks; i++) state = updateAdaptState(state, stats, p, 1 / 30);
  return state;
};

// The dashcam clip that motivated all of this: a black car interior filling the
// bottom of the frame, an overcast sky filling the top. Its encoded mean is
// ordinary; the light coming off the screen is not.
const DASHCAM: Array<[number, number]> = [
  [0.06, 0.45],
  [0.78, 0.25],
  [0.45, 0.15],
  [0.35, 0.15],
];
// A real night scene: dark, and genuinely emitting very little.
const NIGHT: Array<[number, number]> = [
  [0.03, 0.5],
  [0.12, 0.3],
  [0.25, 0.15],
  [0.6, 0.05],
];
// The same night scene with light moving around inside it. A large share of the
// frame changes bin, but only to a neighbouring level: motion, not a cut.
const NIGHT_SHUFFLED: Array<[number, number]> = [
  [0.03, 0.2],
  [0.12, 0.6],
  [0.25, 0.15],
  [0.6, 0.05],
];

/** Bin-by-bin distance between two histograms; 0 when they are identical. */
function histL1(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let total = 0;
  for (let bin = 0; bin < HIST_BINS; bin++) {
    total += Math.abs((a[bin] as number) - (b[bin] as number));
  }
  return total;
}

describe('linear-light measurement', () => {
  it('reads emitted light, not how dark the frame looks', () => {
    const stats = computeSceneStats(sceneFrame(DASHCAM));
    // The encoded mean says "ordinary scene"; the light says otherwise, and the
    // gap between them is the whole bug: half the frame being black dragged the
    // mean down while the sky went on glaring.
    expect(stats.mean).toBeLessThan(0.36);
    expect(stats.light as number).toBeGreaterThan(0.44);
  });

  it('never reads below the encoded mean, and matches it on a flat frame', () => {
    for (const luma of [0.05, 0.2, 0.5, 0.8, 1]) {
      // Within a histogram bin of each other: `light` is summed off the bin
      // centres, which is far below the precision the adaptation acts on.
      const flat = computeSceneStats(flatFrame(luma, 256));
      expect(Math.abs((flat.light as number) - flat.mean)).toBeLessThan(1 / HIST_BINS);
    }
    for (const regions of [DASHCAM, NIGHT]) {
      const stats = computeSceneStats(sceneFrame(regions));
      expect(stats.light as number).toBeGreaterThanOrEqual(stats.mean);
    }
  });

  it('still reports usable percentiles alongside the histogram', () => {
    // Regression guard: normalising the bins in place used to happen before the
    // percentiles were read off them, which silently pinned all three to 1.
    const stats = computeSceneStats(sceneFrame(DASHCAM));
    expect(stats.shadow).toBeLessThan(0.15);
    expect(stats.highlight).toBeGreaterThan(0.7);
    expect(stats.peak).toBeGreaterThanOrEqual(stats.highlight);
    const sum = [...(stats.histogram as Float32Array)].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
  });
});

describe('a bright scene inside a dark frame', () => {
  const defaults = mapVideoStrength(45);

  it('is not mistaken for a night scene', () => {
    // The reported failure: the extension made this frame *brighter*, because
    // the mean and the near-black interior together read as "crushed shadows".
    const state = settleOn(defaults, computeSceneStats(sceneFrame(DASHCAM)));
    expect(state.liftScale).toBeLessThan(0.01);
    const resolved = resolveCurve(defaults, state);
    expect(resolved.lift).toBe(0);
    expect(resolved.gamma).toBe(1);
    expect(applyCurve(resolved, 0.06)).toBeLessThan(0.06); // the interior stays dark
  });

  it('actually comes down instead of only losing its highlights', () => {
    const stats = computeSceneStats(sceneFrame(DASHCAM));
    const state = settleOn(defaults, stats);
    const curve = buildToneCurve(defaults, state, 65);
    const after = litAfter(stats, curve);
    // The old behaviour: exposure never engaged, the shoulder shaved ~10% off
    // the very brightest pixels, and the frame as a whole emitted just as much
    // light as before.
    expect(after).toBeLessThan((stats.light as number) * 0.9);
  });

  it('leaves a genuinely dark scene to the shadow lift', () => {
    // The veto keys on emitted light, so it must not fire on real night
    // content just because that content also has a bright element in it.
    const state = settleOn(defaults, computeSceneStats(sceneFrame(NIGHT)));
    expect(state.liftScale).toBeGreaterThan(DARK_LIFT_FLOOR);
    expect(state.exposure).toBeCloseTo(1, 6);
  });
});

describe('dark-mode content (the lift must never add light)', () => {
  const defaults = mapVideoStrength(45);

  // A screencast of a dark-mode editor, as the 48x27 analysis canvas sees it:
  // fine text is box-filtered into the background it sits on, so the frame is
  // mostly flat dark fill with the light arriving through the text rows, a
  // webcam inset and the tab bar. Encoded mean 0.25 — comfortably "dark" — while
  // emitted light lands at 0.33 against a budget of 0.36.
  const DARK_MODE_UI: Array<[number, number]> = [
    [0.118, 0.5],
    [0.29, 0.22],
    [0.176, 0.1],
    [0.627, 0.06],
    [0.51, 0.07],
    [0.804, 0.05],
  ];

  it('does not open the shadows of a frame already emitting its budget', () => {
    // The reported failure: the extension lifted a dark-mode screencast because
    // the mean said "night scene", and shipped 16.5% *more* light at the viewer
    // than the source did. The old veto band sat above COMFORT_LIGHT rather than
    // below it, so a frame at 0.333 against a 0.36 budget still got a lift of
    // 0.63.
    const stats = computeSceneStats(sceneFrame(DARK_MODE_UI));
    expect(stats.light as number).toBeLessThan(COMFORT_LIGHT);
    expect(stats.mean).toBeLessThan(defaults.adapt.targetLuma); // it does look dark

    const state = settleOn(defaults, stats);
    expect(state.liftScale).toBeLessThan(0.15);
  });

  it('leaves the flat background where the source put it, at every strength', () => {
    // 0.118 is the editor background: 30/255 in the source. The old veto let it
    // reach 46/255 at the default strength and 75/255 at the top of the slider,
    // which is the grey wash in the report. There is no detail in a flat fill to
    // recover, so the only thing that lift ever bought was emitted light.
    const stats = computeSceneStats(sceneFrame(DARK_MODE_UI));
    for (const strength of [1, 20, 45, 70, 100]) {
      const params = mapVideoStrength(strength);
      const resolved = resolveCurve(params, settleOn(params, stats));
      expect(applyCurve(resolved, 0.118) * 255).toBeLessThan(40);
    }
  });

  it('stops the lift from being what drives this frame’s light', () => {
    // Measured against the same curve with the lift taken out, so this isolates
    // the correction the veto governs from the shoulder and the slope
    // allocation, which are doing their own (opposite) work on the same frame.
    // The old veto let the lift add up to 29% on this scene; it is now bounded
    // by single digits across the whole slider.
    const stats = computeSceneStats(sceneFrame(DARK_MODE_UI));
    for (const strength of [1, 20, 45, 70, 100]) {
      const params = mapVideoStrength(strength);
      const state = settleOn(params, stats);
      const lifted = litAfter(stats, buildToneCurve(params, state, 65));
      const flat = litAfter(stats, buildToneCurve(params, { ...state, liftScale: 0 }, 65));
      expect(lifted).toBeLessThan(flat * 1.08);
    }
  });

  it('still opens a night scene that has the budget to spare', () => {
    // The other half of the bargain. This scene emits 0.23 against the same
    // budget, so it keeps the full lift it had before the veto was rebased —
    // the fix must cost genuinely dark content exactly nothing.
    const state = settleOn(defaults, computeSceneStats(sceneFrame(NIGHT)));
    expect(state.liftScale).toBeGreaterThan(DARK_LIFT_FLOOR);
  });

  it('fades the lift out as the frame approaches the budget', () => {
    // Monotone and continuous, so there is no pair of near-identical frames one
    // of which is lifted and one of which is not.
    const lifts = [0.1, 0.18, 0.26, 0.34, 0.42].map((share) => {
      // A flat dark field plus a bright patch: same shape, more emitted light.
      const stats = computeSceneStats(
        sceneFrame([
          [0.06, 1 - share],
          [0.85, share],
        ]),
      );
      return { light: stats.light as number, lift: settleOn(defaults, stats).liftScale };
    });
    for (let i = 1; i < lifts.length; i++) {
      expect((lifts[i] as { light: number }).light).toBeGreaterThan(
        (lifts[i - 1] as { light: number }).light,
      );
      expect((lifts[i] as { lift: number }).lift).toBeLessThanOrEqual(
        (lifts[i - 1] as { lift: number }).lift + 1e-9,
      );
    }
    expect((lifts.at(-1) as { lift: number }).lift).toBeLessThan(0.01);
  });
});

describe('slope allocation', () => {
  const defaults = mapVideoStrength(45);
  const stats = computeSceneStats(sceneFrame(DASHCAM));
  const state = settleOn(defaults, stats);

  const slope = (curve: readonly number[], a: number, b: number): number => {
    const i = Math.round(a * (curve.length - 1));
    const j = Math.round(b * (curve.length - 1));
    return ((curve[j] as number) - (curve[i] as number)) / (b - a);
  };

  it('keeps more contrast where the scene actually lives', () => {
    const allocated = buildToneCurve(defaults, state, 65);
    const plain = buildToneCurve(defaults, { ...state, histogram: null }, 65);
    // The fixed shoulder spends its slope at the top of the range, which on a
    // bright scene is exactly where the pixels are densest.
    expect(slope(allocated, 0.4, 0.6)).toBeGreaterThan(slope(plain, 0.4, 0.6));
    expect(slope(allocated, 0.75, 0.95)).toBeGreaterThan(slope(plain, 0.75, 0.95));
  });

  it('redistributes contrast without changing the endpoints', () => {
    const allocated = buildToneCurve(defaults, state, 65);
    const plain = buildToneCurve(defaults, { ...state, histogram: null }, 65);
    expect(allocated[0] as number).toBeCloseTo(plain[0] as number, 6);
    expect(allocated.at(-1) as number).toBeCloseTo(plain.at(-1) as number, 6);
  });

  it('stays monotonic and bounded on every scene and strength', () => {
    for (const strength of [1, 20, 45, 70, 100]) {
      const params = mapVideoStrength(strength);
      for (const regions of [DASHCAM, NIGHT, [[0.9, 1]] as Array<[number, number]>]) {
        const scene = computeSceneStats(sceneFrame(regions));
        const curve = buildToneCurve(params, settleOn(params, scene), 65);
        for (let i = 0; i < curve.length; i++) {
          const value = curve[i] as number;
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
          if (i > 0) expect(value).toBeGreaterThanOrEqual(curve[i - 1] as number);
        }
      }
    }
  });

  it('does nothing to a curve that is not giving anything up', () => {
    // No dimming, nothing to pay back. A scene being left alone must be left
    // alone by this stage too, rather than quietly contrast-enhanced.
    const flat = new Float32Array(HIST_BINS).fill(1 / HIST_BINS);
    expect(slopeWeights(flat, 32, 0)).toBeNull();

    const inBudget: SceneStats = {
      mean: 0.35,
      shadow: 0.2,
      highlight: 0.52,
      peak: 0.6,
      light: COMFORT_LIGHT,
      histogram: computeSceneStats(sceneFrame([[0.35, 1]])).histogram,
    };
    const curve = buildToneCurve(defaults, settleOn(defaults, inBudget), 33);
    curve.forEach((value, i) => expect(value).toBeCloseTo(i / 32, 6));
  });

  it('caps how much any one level can claim', () => {
    // A large flat region — a black dashboard, a letterbox bar — would take
    // slope proportional to its area under plain equalisation and amplify its
    // own noise for it. The bound is on the *rendered* curve, so it is measured
    // against the unallocated one rather than off the raw weights.
    const spike: Array<[number, number]> = [
      [0.07, 0.9],
      [0.5, 0.05],
      [0.85, 0.05],
    ];
    const scene = computeSceneStats(sceneFrame(spike));
    const spiked = settleOn(defaults, scene);
    const allocated = buildToneCurve(defaults, spiked, 65);
    const plain = buildToneCurve(defaults, { ...spiked, histogram: null }, 65);

    // The bound that holds is on the *spread* between levels, not on any one
    // level's ratio to the unallocated curve. A histogram this concentrated pins
    // every interval against one bound or the other — here 11 at the ceiling and
    // 53 at the floor — so the bounded allocation no longer sums to the range the
    // curve is supposed to have, and `redistribute` closes the gap by scaling all
    // of them uniformly. That is the documented trade (the endpoint wins over the
    // bounds), and it multiplies the individual ratios by a common factor while
    // leaving the spread between them exactly where the bounds put it. So the
    // scale-invariant form is what actually guards against equalisation: no level
    // may claim more than `MAX/MIN` times the treatment of any other.
    const ratios: number[] = [];
    for (let i = 0; i < allocated.length - 1; i++) {
      const was = (plain[i + 1] as number) - (plain[i] as number);
      const now = (allocated[i + 1] as number) - (allocated[i] as number);
      if (was > 1e-12) ratios.push(now / was);
    }
    expect(ratios.length).toBeGreaterThan(32);
    expect(Math.max(...ratios) / Math.min(...ratios)).toBeLessThanOrEqual(1.8 / 0.55 + 1e-9);
    // ...and the cap must not cost the frame any overall range: what is taken
    // from one level has to be given to another.
    expect(allocated.at(-1) as number).toBeCloseTo(plain.at(-1) as number, 6);
  });

  it('produces weights that only say where slope should go, not how much', () => {
    const flat = new Float32Array(HIST_BINS).fill(1 / HIST_BINS);
    expect(slopeWeights(flat, 32, 1)).not.toBeNull();
    for (const regions of [DASHCAM, NIGHT]) {
      const scene = computeSceneStats(sceneFrame(regions));
      const weights = slopeWeights(scene.histogram as Float32Array, 32, 1) as Float64Array;
      for (const weight of weights) expect(weight).toBeGreaterThan(0);
      expect([...weights].reduce((a, b) => a + b, 0) / weights.length).toBeCloseTo(1, 6);
    }
  });

  it('smooths the histogram over time so the curve cannot pump', () => {
    // Light moving around *within* a scene: the histogram may only follow a
    // fraction of the way per frame, or the LUT jumps on every noisy frame.
    // (A cut is the other case, and deliberately snaps — see below.)
    const params = mapVideoStrength(45);
    const scene = computeSceneStats(sceneFrame(NIGHT));
    const shuffled = computeSceneStats(sceneFrame(NIGHT_SHUFFLED));
    let state = createAdaptState();
    for (let i = 0; i < 60; i++) state = updateAdaptState(state, scene, params, 1 / 30);

    const before = state.histogram as Float32Array;
    const next = updateAdaptState(state, shuffled, params, 1 / 30);
    expect(next.cut).toBe(0);

    const available = histL1(before, shuffled.histogram as Float32Array);
    const moved = histL1(before, next.histogram as Float32Array);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(available * 0.2);
  });

  it('snaps the histogram on a cut, so the slope allocation is not half a scene behind', () => {
    const params = mapVideoStrength(45);
    const dark = computeSceneStats(sceneFrame(NIGHT));
    const bright = computeSceneStats(sceneFrame(DASHCAM));
    let state = createAdaptState();
    for (let i = 0; i < 60; i++) state = updateAdaptState(state, dark, params, 1 / 30);

    const next = updateAdaptState(state, bright, params, 1 / 30);
    expect(next.cut).toBe(1);
    expect(histL1(next.histogram as Float32Array, bright.histogram as Float32Array)).toBeCloseTo(
      0,
      6,
    );
  });
});

describe('scene-change snapping', () => {
  // The taus exist to hide a correction inside continuous motion. At a cut
  // there is nothing to hide it in and nothing that needs hiding, because the
  // cut masks anything done on the same frame — while easing there is visible
  // as the picture drifting for up to recoverTau after the scene arrives.
  const p = mapVideoStrength(45);
  const night = computeSceneStats(sceneFrame(NIGHT));
  const dashcam = computeSceneStats(sceneFrame(DASHCAM));
  const flat = (luma: number) => computeSceneStats(flatFrame(luma, 1296));

  const hold = (scene: SceneStats, dt = 1 / 60, seconds = 4) => {
    let state = createAdaptState();
    for (let i = 0; i < Math.round(seconds / dt); i++) state = updateAdaptState(state, scene, p, dt);
    return state;
  };

  it('lands the whole state on its target on the frame of the cut', () => {
    const before = hold(night);
    const after = updateAdaptState(before, dashcam, p, 1 / 60);
    expect(after.cut).toBe(1);

    // One frame in, the state is exactly where four seconds of easing puts it.
    const settled = hold(dashcam);
    expect(after.exposure).toBeCloseTo(settled.exposure, 10);
    expect(after.liftScale).toBeCloseTo(settled.liftScale, 10);
    expect(after.rollScale).toBeCloseTo(settled.rollScale, 10);
    // ...and it really did move; the two scenes are not accidentally alike.
    expect(Math.abs(after.exposure - before.exposure)).toBeGreaterThan(0.1);
  });

  it('opens a dark scene immediately on a cut out of a bright one', () => {
    // recoverTau is 1.6 s and the lift tau 1.2 s, so this direction was the
    // worse of the two: a cut from daylight to a night interior spent over a
    // second both over-dimmed and under-lifted.
    const before = hold(dashcam);
    const after = updateAdaptState(before, night, p, 1 / 60);
    const settled = hold(night);
    expect(after.exposure).toBeCloseTo(settled.exposure, 10);
    expect(after.liftScale).toBeCloseTo(settled.liftScale, 10);
    expect(after.liftScale).toBeGreaterThan(before.liftScale + 0.3);
  });

  it('reaches its dimmest at the cut and only recovers from there', () => {
    // The user-visible point of the whole exercise: no delayed dip. Before, the
    // servo eased down over dimTau while the flash guard covered the gap, so
    // the darkest frame arrived a few hundred ms *after* the cut.
    let state = hold(night);
    const trace: number[] = [];
    for (let i = 0; i < 120; i++) {
      state = updateAdaptState(state, flat(0.98), p, 1 / 60);
      trace.push(resolveCurve(p, state).exposure);
    }
    expect(trace[0] as number).toBeCloseTo(Math.min(...trace), 10);
    for (let i = 1; i < trace.length; i++) {
      expect(trace[i] as number).toBeGreaterThanOrEqual((trace[i - 1] as number) - 1e-9);
    }
  });

  it('damps the flash guard by however much the snap already covered', () => {
    // The guard had two jobs: cover the servo's lag and blunt the transient. On
    // a snap the first is gone, so it is scaled back rather than stacked on top
    // of an already-correct exposure.
    const after = updateAdaptState(hold(night), flat(0.98), p, 1 / 60);
    expect(after.cut).toBe(1);
    expect(after.flash).toBeGreaterThan(0);
    expect(after.flash).toBeLessThanOrEqual(FLASH_CUT_RESIDUAL);
    // The combined response stays close to where the new scene settles, instead
    // of punching well past it and crawling back.
    const settled = resolveCurve(p, hold(flat(0.98))).exposure;
    expect(resolveCurve(p, after).exposure).toBeGreaterThan(settled * 0.7);
  });

  it('leaves the flash guard alone when the servo has no room to snap', () => {
    // Content already pinned at minExposure — a bright test pattern, a daylight
    // scene — cannot be dimmed any further by the servo, so the guard is the
    // only transient protection it has. Damping on the bare presence of a cut
    // removed most of the response to a white flash over exactly that content.
    const before = hold(flat(0.6));
    expect(before.exposure).toBeCloseTo(p.adapt.minExposure, 6);

    const pinned = updateAdaptState(before, flat(1), p, 1 / 60);
    expect(pinned.cut).toBe(1);
    expect(pinned.flash).toBeGreaterThan(0.9);

    // The identical transition, from a state where the servo *does* have room:
    // same jump, same guard magnitude, but now the snap covers it.
    const withRoom = updateAdaptState({ ...before, exposure: 1 }, flat(1), p, 1 / 60);
    expect(withRoom.flash).toBeLessThan(pinned.flash * 0.6);
  });

  it('does not snap on motion within a scene', () => {
    const after = updateAdaptState(hold(night), computeSceneStats(sceneFrame(NIGHT_SHUFFLED)), p, 1 / 60);
    expect(after.cut).toBe(0);
  });

  it('treats a flat-frame fade as motion even though every pixel changes bin', () => {
    // The case that rules out a bin-by-bin difference metric. A low-contrast
    // frame holds all its mass in one bin, so a slow fade relocates 100% of it
    // on every bin crossing. Measuring how *far* the mass moved reads the same
    // event as one bin width, which is what it is.
    for (const dt of [1 / 60, 1 / 30, 0.125]) {
      let state = hold(flat(0.1), dt, 1);
      const steps = Math.round(2 / dt);
      for (let i = 1; i <= steps; i++) {
        state = updateAdaptState(state, flat(0.1 + (0.8 * i) / steps), p, dt);
        expect(state.cut).toBe(0);
      }
    }
  });

  it('snaps a hard cut at every sampling rate, including the 8 Hz fallback', () => {
    for (const dt of [1 / 60, 1 / 30, 0.125]) {
      const after = updateAdaptState(hold(flat(0.1), dt, 1), flat(0.9), p, dt);
      expect(after.cut).toBe(1);
    }
  });

  it('falls back to the mean when frames carry no histogram, and cannot over-trigger', () => {
    // |Δmean| is a strict lower bound on the transport distance, so a caller
    // with only a coarse summary detects fewer cuts, never phantom ones.
    const meanDelta = dashcam.mean - night.mean;
    expect(sceneShift(dashcam.histogram, night.histogram, meanDelta)).toBeGreaterThanOrEqual(
      Math.abs(meanDelta) - 1e-12,
    );
    expect(sceneShift(undefined, undefined, meanDelta)).toBeCloseTo(Math.abs(meanDelta), 12);

    // Stripped of histograms, the same pair still reads as a cut.
    const strip = (s: SceneStats): SceneStats => ({ ...s, histogram: undefined });
    let state = createAdaptState();
    for (let i = 0; i < 60; i++) state = updateAdaptState(state, strip(night), p, 1 / 60);
    expect(updateAdaptState(state, strip(dashcam), p, 1 / 60).cut).toBe(1);
  });

  it('reports no cut once a scene is running, so the curve push stays throttled', () => {
    let state = hold(night);
    for (let i = 0; i < 30; i++) {
      state = updateAdaptState(state, night, p, 1 / 60);
      expect(state.cut).toBe(0);
    }
  });
});

describe('per-frame advance', () => {
  // The engine skips the pixel read-back when it is expensive, but it must not
  // skip the *integration*: a state that only moves on analysed frames delivers
  // a ramp in `stride`-sized jumps. Measured in Chrome at stride 4, that was 3.4
  // 8-bit levels per jump eight times a second — plainly visible on flat areas —
  // against 1.3 levels per frame once the two halves were separated.
  const p = mapVideoStrength(45);
  const night = computeSceneStats(sceneFrame(NIGHT));
  const dashcam = computeSceneStats(sceneFrame(DASHCAM));

  const settled = (scene: SceneStats) => {
    let state = createAdaptState();
    for (let i = 0; i < 240; i++) state = updateAdaptState(state, scene, p, 1 / 60);
    return state;
  };

  it('keeps moving on a frame with no statistics at all', () => {
    // The whole point: no `SceneStats` argument exists, and the curve still
    // advances towards wherever the last analysed frame aimed it.
    const aimed = updateAdaptState(settled(night), dashcam, p, 1 / 60);
    const stale = { ...aimed, exposure: 1, liftScale: 1, rollScale: 0 };
    const moved = advanceAdaptState(stale, p, 1 / 60);
    expect(moved.exposure).toBeLessThan(stale.exposure);
    expect(moved.liftScale).toBeLessThan(stale.liftScale);
    expect(moved.rollScale).toBeGreaterThan(stale.rollScale);
    // An advanced frame is never a scene change: nothing was looked at.
    expect(moved.cut).toBe(0);
  });

  it('reaches the same place whether or not the frames between were analysed', () => {
    // Skipping a read-back costs *detection latency* — the targets are a frame
    // or three stale — and nothing else. Held on one scene the targets do not
    // move, so the two paths must agree to the last bit.
    const start = settled(night);
    const aimed = updateAdaptState(start, dashcam, p, 1 / 60);

    let analysed = aimed;
    for (let i = 0; i < 12; i++) analysed = updateAdaptState(analysed, dashcam, p, 1 / 60);

    let skipped = aimed;
    for (let i = 0; i < 12; i++) skipped = advanceAdaptState(skipped, p, 1 / 60);

    expect(skipped.exposure).toBeCloseTo(analysed.exposure, 12);
    expect(skipped.liftScale).toBeCloseTo(analysed.liftScale, 12);
    expect(skipped.rollScale).toBeCloseTo(analysed.rollScale, 12);
    expect(skipped.flash).toBeCloseTo(analysed.flash, 12);
  });

  it('takes smaller steps than the sampling rate alone would allow', () => {
    // The regression, stated as maths. Four frames of easing must land within a
    // whisker of one step of four frames' worth — same destination — while no
    // individual increment is anywhere near as large.
    // Aimed at the bright scene but still sitting on the dark one's numbers,
    // which is what a mid-ramp frame looks like. Feeding the two scenes in
    // directly would not do: that pair reads as a cut and snaps, leaving no
    // gap to cross.
    const start = settled(night);
    const aimed = updateAdaptState(start, dashcam, p, 1 / 60);
    const gap = { ...aimed, exposure: start.exposure };

    let perFrame = gap;
    let worstIncrement = 0;
    for (let i = 0; i < 4; i++) {
      const next = advanceAdaptState(perFrame, p, 1 / 60);
      worstIncrement = Math.max(worstIncrement, Math.abs(next.exposure - perFrame.exposure));
      perFrame = next;
    }
    const oneJump = advanceAdaptState(gap, p, 4 / 60);
    const jump = Math.abs(oneJump.exposure - gap.exposure);

    // Exact, not approximate: an exponential approach composes, so four steps
    // of dt and one of 4dt are the same number.
    expect(perFrame.exposure).toBeCloseTo(oneJump.exposure, 12);
    // The ideal is a quarter of the jump; the taus buy a little back.
    expect(jump).toBeGreaterThan(0.01);
    expect(worstIncrement).toBeLessThan(jump * 0.35);
  });

  it('leaves a state with nowhere to go exactly where it is', () => {
    // A fresh state and the static (DRM) one both rest on their own targets, so
    // advancing either cannot drag it towards some other curve.
    for (const state of [createAdaptState(), staticAdaptState(p)]) {
      let held = state;
      for (let i = 0; i < 60; i++) held = advanceAdaptState(held, p, 1 / 60);
      expect(held.exposure).toBeCloseTo(state.exposure, 12);
      expect(held.liftScale).toBeCloseTo(state.liftScale, 12);
      expect(held.rollScale).toBeCloseTo(state.rollScale, 12);
    }
  });

  it('measures rates against the last analysed frame, not the last advance', () => {
    // The rate gates divide by an interval. Handing them one frame while the
    // statistics span four would read every ordinary pan as four times as fast
    // as it is, and fire the cut snap and the flash guard on motion.
    const start = settled(night);
    // Far enough to clear the magnitude gate — below it nothing is a cut at any
    // speed — so that the rate is the only thing left to disagree about.
    const pan = computeSceneStats(sceneFrame(NIGHT.map(([l, w]) => [l + 0.15, w])));

    const honest = updateAdaptState(start, pan, p, 1 / 60, 4 / 60);
    const inflated = updateAdaptState(start, pan, p, 1 / 60, 1 / 60);
    expect(inflated.cut).toBeGreaterThan(0.4);
    expect(honest.cut).toBeLessThan(inflated.cut);
    expect(honest.flash).toBeLessThanOrEqual(inflated.flash);

    // Omitting it is the every-frame case, and must change nothing.
    const implied = updateAdaptState(start, pan, p, 1 / 60);
    expect(implied.cut).toBe(inflated.cut);
    expect(implied.exposure).toBeCloseTo(inflated.exposure, 12);
  });
});

describe('white-point ceiling', () => {
  // Everything else in this module answers the frame in front of it, which is
  // the wrong shape for a cut: the bright frame is on screen before anything has
  // measured it. Detection costs a frame at best, `frameStride` frames when the
  // sampler has backed off, and a cut that only partly registers earns only
  // partial snap credit — so the reactive path has no worst case. The ceiling is
  // the standing limit that covers all of it, armed from where the viewer has
  // been rather than from what just arrived.
  const p = mapVideoStrength(45);
  const NIGHT_STATS = computeSceneStats(sceneFrame(NIGHT));
  const WHITE_STATS = computeSceneStats(flatFrame(0.98, 4096));
  const peakOf = (state: ReturnType<typeof createAdaptState>) =>
    applyCurve(resolveCurve(p, state), 1);

  it('states the ceiling in closed form without drifting from the general path', () => {
    // `brightWhitePoint` is hand-rolled arithmetic so it can be called every
    // frame without running `solveKneeScale`, and so `resolveCurve` can consume
    // it without recursing. The bright bound carries `darkAdapt: 0`, so the
    // general path leaves it uncapped — which makes this a direct comparison of
    // the shortcut against the code it is a shortcut for.
    for (let strength = 0; strength <= 100; strength += 5) {
      const params = mapVideoStrength(strength);
      expect(brightWhitePoint(params)).toBeCloseTo(
        resolveCurve(params, adaptBounds(params).bright).whitePoint,
        12,
      );
    }
  });

  it('never lets the peak rise across a cut, however late the cut is noticed', () => {
    // The invariant the whole change exists for, stated over the worst case:
    // eight presented frames of a white scene carrying a night scene's
    // measurements. `advanceAdaptState` is exactly what the engine runs on a
    // frame it chose not to analyse, so this is the stride-8 path verbatim.
    const settled = settleOn(p, NIGHT_STATS);
    const before = peakOf(settled);

    let blind = settled;
    for (let i = 0; i < 8; i++) {
      blind = advanceAdaptState(blind, p, 1 / 60);
      expect(peakOf(blind)).toBeLessThanOrEqual(before + 1e-9);
    }

    let after = updateAdaptState(blind, WHITE_STATS, p, 1 / 60, 8 / 60);
    expect(peakOf(after)).toBeLessThanOrEqual(before + 1e-9);
    for (let i = 0; i < 600; i++) after = updateAdaptState(after, WHITE_STATS, p, 1 / 60);
    expect(peakOf(after)).toBeLessThanOrEqual(before + 1e-9);
  });

  it('holds an unmeasured white frame near the bright-scene white point', () => {
    // The magnitude, pinned. Without the ceiling a night scene sat at a white
    // point above 0.9 — full exposure, and a shoulder that can only soften the
    // top of a range nothing had lowered yet — so an unnoticed white frame came
    // through at 0.9 before settling near 0.71. That gap was the flash.
    const settled = settleOn(p, NIGHT_STATS);
    expect(settled.darkAdapt).toBeGreaterThan(0.95);

    const capped = peakOf(settled);
    const uncapped = applyCurve(resolveCurve(p, { ...settled, darkAdapt: 0 }), 1);
    expect(uncapped).toBeGreaterThan(0.9);
    expect(capped).toBeLessThan(brightWhitePoint(p) * 1.02);

    // Stated in the units that matter for being flashed: the eye responds to
    // emitted light, not to the encoded level, so the encoded 0.93 -> 0.72 here
    // is 43% off the light a full-frame white actually puts on the screen. The
    // figure tracks the slider, since the ceiling is the bright-scene white
    // point and that is where the strength mapping already lives: 18% at 25,
    // 43% at 45, 60% at 60, 79% at 100.
    const reduction = 1 - toLinearLight(capped) / toLinearLight(uncapped);
    expect(reduction).toBeGreaterThan(0.4);

    const strong = mapVideoStrength(100);
    let night = createAdaptState();
    for (let i = 0; i < 300; i++) night = updateAdaptState(night, NIGHT_STATS, strong, 1 / 30);
    const hard = 1 - toLinearLight(applyCurve(resolveCurve(strong, night), 1)) /
      toLinearLight(applyCurve(resolveCurve(strong, { ...night, darkAdapt: 0 }), 1));
    expect(hard).toBeGreaterThan(reduction);
  });

  it('does not release on the very cut it exists to cover', () => {
    // A cut out of a night scene is precisely the moment the incoming frame
    // stops reading as dark. Everything else snaps onto its target here, and
    // snapping this one would drop the ceiling on the frame it was holding.
    const night = settleOn(p, NIGHT_STATS);
    const cut = updateAdaptState(night, WHITE_STATS, p, 1 / 60);
    expect(cut.cut).toBe(1);
    expect(cut.rollScale).toBeCloseTo(cut.targets.roll, 6);
    expect(cut.targets.darkAdapt).toBe(0);
    expect(cut.darkAdapt).toBeGreaterThan(0.95);
  });

  it('arms slowly and releases more slowly still', () => {
    const dt = 1 / 60;
    const cap = 60 * 60;

    let arming = createAdaptState();
    let armFrames = 0;
    while (arming.darkAdapt < 0.63 && armFrames < cap) {
      arming = updateAdaptState(arming, NIGHT_STATS, p, dt);
      armFrames++;
    }
    let releasing = settleOn(p, NIGHT_STATS);
    let releaseFrames = 0;
    while (releasing.darkAdapt > 0.37 && releaseFrames < cap) {
      releasing = updateAdaptState(releasing, WHITE_STATS, p, dt);
      releaseFrames++;
    }

    expect(armFrames).toBeLessThan(cap);
    expect(releaseFrames).toBeLessThan(cap);
    // Seconds, not frames: anything on the order of a shot length would track
    // the scene, which is the one thing this must not do.
    expect(armFrames / 60).toBeGreaterThan(1);
    expect(releaseFrames).toBeGreaterThan(armFrames);
  });

  it('does not arm on a normally exposed scene', () => {
    // The identity-on-normal-content rule outranks the ceiling: a scene that is
    // neither dark nor over the light budget gets an unmodified curve, and
    // `whitePointCeiling` returning exactly 1 is what makes that a no-op rather
    // than a small correction that happens to round away.
    const normal = settleOn(p, computeSceneStats(flatFrame(0.4, 4096)));
    expect(normal.darkAdapt).toBe(0);
    expect(whitePointCeiling(p, normal)).toBe(1);
    expect(applyCurve(resolveCurve(p, normal), 1)).toBeGreaterThan(0.85);
  });

  it('stays out of the modes that cannot measure a scene', () => {
    // Static mode is DRM and tainted canvases; image mode is cross-origin
    // stills. Neither can know whether the viewer is dark-adapted, and arming
    // the ceiling blind would dim protected video below everything else at the
    // same slider position.
    for (const params of [mapVideoStrength(45), mapVideoStrength(100)]) {
      for (const state of [staticAdaptState(params), imageAdaptState(params)]) {
        expect(state.darkAdapt).toBe(0);
        expect(whitePointCeiling(params, state)).toBe(1);
      }
    }
  });

  it('yields to the flash guard rather than overriding it', () => {
    // The cap is a `min`, so a guard that has already pulled the white point
    // below the ceiling keeps its own, lower answer.
    const night = settleOn(p, NIGHT_STATS);
    const flashing = { ...night, flash: 1 };
    expect(peakOf(flashing)).toBeLessThan(peakOf(night));
  });
});

describe('adaptBounds', () => {
  it('brackets the adaptive range', () => {
    const { bright, dark } = adaptBounds(params);
    expect(dark.liftScale).toBeGreaterThan(bright.liftScale);
    expect(bright.rollScale).toBeGreaterThan(dark.rollScale);
    // A bright scene gets no shadow lift at all, and a dark one keeps the
    // shoulder armed at its dark-scene floor.
    expect(bright.liftScale).toBe(0);
    expect(dark.rollScale).toBeCloseTo(DARK_ROLL_FLOOR, 6);
    // Bright scenes are additionally dimmed; dark scenes never are.
    expect(bright.exposure).toBeCloseTo(params.adapt.minExposure, 6);
    expect(dark.exposure).toBe(1);
    for (const state of [bright, dark]) {
      expect(state.flash).toBe(0);
      expect(state.initialized).toBe(true);
    }
  });

  it('collapses onto the identity when bypassed', () => {
    const bypass = mapVideoStrength(0);
    const { bright, dark } = adaptBounds(bypass);
    expect(buildToneCurve(bypass, dark, 5)).toEqual(buildToneCurve(bypass, bright, 5));
  });

  it('opens shadows more at the dark end and holds both ends to the same ceiling', () => {
    const p = mapVideoStrength(45);
    const { bright, dark } = adaptBounds(p);
    expect(applyCurve(resolveCurve(p, dark), 0.05)).toBeGreaterThan(
      applyCurve(resolveCurve(p, bright), 0.05),
    );
    // The two ends of the adaptive range used to differ at the top, the dark one
    // sitting higher because only exposure had brought the bright one down. That
    // gap was the flash: a cut out of a night scene spent its first frames at the
    // dark bound's white point before anything had measured them. The ceiling is
    // set to the bright bound's settled white, so the range now meets at the top
    // and no scene can put more light on screen than sustained bright content is
    // already held to.
    for (const state of [dark, bright]) {
      expect(applyCurve(resolveCurve(p, state), 1)).toBeCloseTo(brightWhitePoint(p), 10);
    }
  });
});

describe('staticAdaptState', () => {
  it('does not apply strength twice', () => {
    // The params already carry strength; scaling the static state by it as well
    // made DRM/static mode much weaker than adaptive mode at the same slider
    // position, which also made the popup preview look like a straight line.
    expect(staticAdaptState(mapVideoStrength(45)).liftScale).toBe(
      staticAdaptState(mapVideoStrength(100)).liftScale,
    );
    const curve = buildToneCurve(mapVideoStrength(45), staticAdaptState(mapVideoStrength(45)));
    expect(curve[0] as number).toBeGreaterThan(0.015);
    expect(curve[curve.length - 1] as number).toBeLessThan(0.95);
  });

  it('produces a fixed, non-adaptive curve', () => {
    const state = staticAdaptState(maxParams);
    expect(state.exposure).toBe(1);
    expect(state.flash).toBe(0);
    expect(state.liftScale).toBeCloseTo(maxParams.adapt.staticLiftScale, 6);
    const a = buildToneCurve(maxParams, state);
    const b = buildToneCurve(maxParams, staticAdaptState(maxParams));
    expect(a).toEqual(b);
  });

  it('still lifts shadows and rolls off highlights', () => {
    const curve = buildToneCurve(maxParams, staticAdaptState(maxParams));
    expect(curve[0] as number).toBeGreaterThan(0);
    expect(curve[curve.length - 1] as number).toBeLessThan(1);
  });
});

/**
 * Stills are toned blind (their pixels are usually cross-origin and therefore
 * unreadable), so the only guarantee available is the direction of the effect:
 * whatever the picture turns out to contain, the curve must not make it
 * brighter. That is the property worth pinning, because the one part of the
 * tone map that *would* brighten it — the shadow lift — is also the part every
 * other caller of this module wants.
 */
describe('imageAdaptState', () => {
  const strengths = [1, 20, 45, 60, 80, 100];

  it('never brightens any input level, at any strength', () => {
    for (const strength of strengths) {
      const p = mapVideoStrength(strength);
      const curve = buildToneCurve(p, imageAdaptState(p), 65);
      curve.forEach((value, index) => {
        expect(value).toBeLessThanOrEqual(index / (curve.length - 1) + 1e-9);
      });
    }
  });

  it('keeps black at black and pulls white down', () => {
    const state = imageAdaptState(params);
    const curve = buildToneCurve(params, state);
    expect(curve[0]).toBe(0);
    expect(curve[curve.length - 1] as number).toBeLessThan(0.85);
  });

  it('is a true bypass at strength 0, like everything else here', () => {
    const off = mapVideoStrength(0);
    const curve = buildToneCurve(off, imageAdaptState(off), 9);
    curve.forEach((value, index) => expect(value).toBeCloseTo(index / 8, 6));
  });

  it('dims harder as the slider goes up', () => {
    const white = (strength: number): number => {
      const p = mapVideoStrength(strength);
      const curve = buildToneCurve(p, imageAdaptState(p));
      return curve[curve.length - 1] as number;
    };
    for (let i = 1; i < strengths.length; i++) {
      expect(white(strengths[i] as number)).toBeLessThan(white(strengths[i - 1] as number));
    }
  });

  it('sits half way to the exposure servo’s floor', () => {
    for (const strength of strengths) {
      const p = mapVideoStrength(strength);
      expect(imageAdaptState(p).exposure).toBeCloseTo((1 + p.adapt.minExposure) / 2, 6);
    }
  });

  it('leaves saturation alone, because it flattens nothing', () => {
    // The saturation boost pays for the flattening the shadow gamma causes, and
    // this curve has no shadow gamma. Applying it anyway would over-saturate
    // every picture on the page.
    for (const strength of strengths) {
      const p = mapVideoStrength(strength);
      expect(resolveCurve(p, imageAdaptState(p)).saturation).toBe(1);
      expect(resolveCurve(p, imageAdaptState(p)).lift).toBe(0);
    }
  });

  it('is fixed: nothing about it depends on history', () => {
    const a = buildToneCurve(maxParams, imageAdaptState(maxParams));
    const b = buildToneCurve(maxParams, imageAdaptState(maxParams));
    expect(a).toEqual(b);
    const state = imageAdaptState(maxParams);
    expect(state.flash).toBe(0);
    expect(state.histogram).toBeNull();
    // Its own resting place: advancing it must be a no-op rather than a drift.
    const advanced = advanceAdaptState(state, maxParams, 1);
    expect(advanced.exposure).toBeCloseTo(state.exposure, 9);
    expect(advanced.liftScale).toBeCloseTo(0, 9);
    expect(advanced.rollScale).toBeCloseTo(1, 9);
  });

  it('never brightens through the CSS fallback either', () => {
    // The css-basic path is a two-point fit rather than the real curve, so it
    // can disagree with it — but not about the direction.
    const css = cssApproxFilter(params, imageAdaptState(params));
    const brightness = Number(/brightness\(([\d.]+)\)/.exec(css)?.[1]);
    expect(brightness).toBeLessThanOrEqual(1);
  });
});

describe('curveToTableValues', () => {
  it('renders a compact SVG table', () => {
    expect(curveToTableValues([0, 0.123456, 1])).toBe('0 0.1235 1');
  });
});

describe('cssApproxFilter', () => {
  it('is none when bypassed', () => {
    expect(cssApproxFilter(mapVideoStrength(0), createAdaptState())).toBe('none');
  });

  it('produces a valid filter list with reduced contrast', () => {
    const css = cssApproxFilter(maxParams, staticAdaptState(maxParams));
    expect(css).toMatch(/^brightness\([\d.]+\) contrast\([\d.]+\) saturate\([\d.]+\)$/);
    const contrast = Number(/contrast\(([\d.]+)\)/.exec(css)?.[1]);
    expect(contrast).toBeLessThan(1);
    expect(contrast).toBeGreaterThan(0.15);
  });
});
