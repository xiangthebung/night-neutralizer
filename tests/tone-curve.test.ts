import { describe, expect, it } from 'vitest';
import {
  COMFORT_LIGHT,
  DARK_LIFT_FLOOR,
  DARK_ROLL_FLOOR,
  HIST_BINS,
  adaptBounds,
  applyCurve,
  buildToneCurve,
  computeSceneStats,
  createAdaptState,
  cssApproxFilter,
  curveToTableValues,
  resolveCurve,
  slopeWeights,
  solveKneeScale,
  staticAdaptState,
  toEncodedLight,
  toLinearLight,
  updateAdaptState,
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
    let state = updateAdaptState(createAdaptState(), stats(0.3), params, 0.125);
    const dimming = updateAdaptState(state, stats(0.9), params, 0.125);
    const dropIn1Tick = state.exposure - dimming.exposure;

    state = dimming;
    for (let i = 0; i < 12; i++) state = updateAdaptState(state, stats(0.9), params, 0.125);
    const settled = state.exposure;
    const recovering = updateAdaptState(state, stats(0.2), params, 0.125);
    const riseIn1Tick = recovering.exposure - settled;

    expect(dropIn1Tick).toBeGreaterThan(riseIn1Tick);
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
      const cut = updateAdaptState(settle(dt), stats(0.92), params, dt);
      expect(cut.flash).toBeGreaterThan(0.5);
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
    expect(large.flash).toBeGreaterThan(0.9);

    // ...and a tiny wobble is ignored entirely.
    const wobble = updateAdaptState(base, stats(0.24), params, 1 / 60);
    expect(wobble.flash).toBe(0);
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
    for (let i = 0; i < allocated.length - 1; i++) {
      const was = (plain[i + 1] as number) - (plain[i] as number);
      const now = (allocated[i + 1] as number) - (allocated[i] as number);
      expect(now).toBeGreaterThanOrEqual(was * 0.55 - 1e-9);
      expect(now).toBeLessThanOrEqual(was * 1.8 + 1e-9);
    }
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
    const params = mapVideoStrength(45);
    let state = createAdaptState();
    const dark = computeSceneStats(sceneFrame(NIGHT));
    const bright = computeSceneStats(sceneFrame(DASHCAM));
    for (let i = 0; i < 60; i++) state = updateAdaptState(state, dark, params, 1 / 30);
    const before = state.histogram as Float32Array;
    const next = updateAdaptState(state, bright, params, 1 / 30).histogram as Float32Array;
    // One frame of a completely different scene may only move the histogram a
    // fraction of the way, or the LUT would jump on every noisy frame.
    let moved = 0;
    for (let bin = 0; bin < HIST_BINS; bin++) {
      moved += Math.abs((next[bin] as number) - (before[bin] as number));
    }
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(0.4);
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

  it('opens shadows more at the dark end and holds highlights more at the bright end', () => {
    const p = mapVideoStrength(45);
    const { bright, dark } = adaptBounds(p);
    expect(applyCurve(resolveCurve(p, dark), 0.05)).toBeGreaterThan(
      applyCurve(resolveCurve(p, bright), 0.05),
    );
    expect(applyCurve(resolveCurve(p, bright), 1)).toBeLessThan(
      applyCurve(resolveCurve(p, dark), 1),
    );
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
