import { describe, expect, it } from 'vitest';
import {
  LIFT_FLOOR,
  ROLL_FLOOR,
  adaptBounds,
  applyCurve,
  buildToneCurve,
  computeSceneStats,
  createAdaptState,
  cssApproxFilter,
  curveToTableValues,
  resolveCurve,
  solveKneeScale,
  staticAdaptState,
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

describe('adaptBounds', () => {
  it('brackets the adaptive range', () => {
    const { bright, dark } = adaptBounds();
    expect(dark.liftScale).toBeGreaterThan(bright.liftScale);
    expect(bright.rollScale).toBeGreaterThan(dark.rollScale);
    expect(bright.liftScale).toBeCloseTo(LIFT_FLOOR, 6);
    expect(dark.rollScale).toBeCloseTo(ROLL_FLOOR, 6);
    for (const state of [bright, dark]) {
      expect(state.flash).toBe(0);
      expect(state.exposure).toBe(1);
      expect(state.initialized).toBe(true);
    }
  });

  it('collapses onto the identity when bypassed', () => {
    const bypass = mapVideoStrength(0);
    const { bright, dark } = adaptBounds();
    expect(buildToneCurve(bypass, dark, 5)).toEqual(buildToneCurve(bypass, bright, 5));
  });

  it('opens shadows more at the dark end and holds highlights more at the bright end', () => {
    const params = mapVideoStrength(45);
    const { bright, dark } = adaptBounds();
    expect(applyCurve(resolveCurve(params, dark), 0.05)).toBeGreaterThan(
      applyCurve(resolveCurve(params, bright), 0.05),
    );
    expect(resolveCurve(params, bright).whitePoint).toBeLessThan(
      resolveCurve(params, dark).whitePoint,
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
