/**
 * The live meter is the popup's proof that something is happening, so its two
 * numbers are pinned to the same functions the engines use — the strength
 * mapping for the audio gain, the tone curve's own light model for the
 * picture — and its wording is tested at the boundaries where a number would
 * be misleading.
 */
import { describe, expect, it } from 'vitest';
import { audioGainNowDb, describeMeter, lightRatio } from '../src/core/meter';
import { chromiumInternalMakeupDb, mapAudioStrength, mapVideoStrength } from '../src/core/strength';
import {
  adaptBounds,
  buildToneCurve,
  computeSceneStats,
  staticAdaptState,
} from '../src/core/tone-curve';

describe('audioGainNowDb', () => {
  it('is the whole path from the element to the sink', () => {
    const params = mapAudioStrength(45);
    const expected =
      params.preGainDb +
      chromiumInternalMakeupDb(params.compressor.thresholdDb, params.compressor.ratio) +
      params.makeupGainDb;
    expect(audioGainNowDb(params, 0)).toBeCloseTo(expected, 10);
    // A whisper at the default is lifted by about the caption's "+9 dB".
    expect(audioGainNowDb(params, 0)).toBeGreaterThan(9);
    expect(audioGainNowDb(params, 0)).toBeLessThan(11);
  });

  it('falls with the compressor and the limiter, and never rises with them', () => {
    const params = mapAudioStrength(45);
    const quiet = audioGainNowDb(params, 0);
    const loud = audioGainNowDb(params, -11);
    expect(loud).toBeCloseTo(quiet - 11, 10);
    expect(audioGainNowDb(params, -11, -1.5)).toBeCloseTo(loud - 1.5, 10);
    // A positive "reduction" is nonsense from the node and is ignored.
    expect(audioGainNowDb(params, 4)).toBeCloseTo(quiet, 10);
    expect(audioGainNowDb(params, Number.NaN)).toBeCloseTo(quiet, 10);
  });

  it('is zero in bypass', () => {
    expect(audioGainNowDb(mapAudioStrength(0), -6)).toBe(0);
  });
});

describe('lightRatio', () => {
  const uniform = (bins: number): Float32Array => new Float32Array(bins).fill(1 / bins);

  it('is 1 for the identity curve', () => {
    const identity = Array.from({ length: 33 }, (_, i) => i / 32);
    expect(lightRatio(identity, uniform(64))).toBeCloseTo(1, 6);
    expect(lightRatio(identity, null)).toBeCloseTo(1, 6);
  });

  it('reads a dimming curve below 1 and a lifting curve above it', () => {
    const params = mapVideoStrength(45);
    const bounds = adaptBounds(params);
    const bright = buildToneCurve(params, bounds.bright);
    const dark = buildToneCurve(params, bounds.dark);
    // A bright scene: mass in the top bins.
    const brightFrame = new Float32Array(64);
    for (let bin = 40; bin < 64; bin++) brightFrame[bin] = 1 / 24;
    // A night scene: mass in the bottom bins.
    const darkFrame = new Float32Array(64);
    for (let bin = 0; bin < 8; bin++) darkFrame[bin] = 1 / 8;
    expect(lightRatio(bright, brightFrame) as number).toBeLessThan(0.8);
    expect(lightRatio(dark, darkFrame) as number).toBeGreaterThan(1.5);
  });

  it('weights by the frame when it has one, and by a full ramp when it has none', () => {
    // A frame that is all white sees only what the curve does to white; the
    // same curve over a ramp is a different, milder number.
    const params = mapVideoStrength(45);
    const fixed = buildToneCurve(params, staticAdaptState(params));
    const white = new Float32Array(64);
    white[63] = 1;
    const onWhite = lightRatio(fixed, white) as number;
    const onRamp = lightRatio(fixed, null) as number;
    expect(onWhite).toBeLessThan(1);
    expect(onRamp).toBeLessThan(1);
    expect(Math.abs(onWhite - onRamp)).toBeGreaterThan(0.02);
    // And the ramp answer is what a real histogram of a ramp gives.
    const rgba = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) rgba.set([i, i, i, 255], i * 4);
    const ramp = computeSceneStats(rgba).histogram;
    expect(lightRatio(fixed, ramp) as number).toBeCloseTo(onRamp, 2);
  });

  it('answers null rather than a nonsense number', () => {
    expect(lightRatio([], null)).toBeNull();
    expect(lightRatio([0.5], null)).toBeNull();
    expect(lightRatio([0, 1], new Float32Array(64))).toBeNull();
  });
});

describe('describeMeter', () => {
  const on = (gainDb: number | null, ratio: number | null): string =>
    describeMeter({
      held: false,
      audio: { active: true, gainDb },
      video: { active: true, lightRatio: ratio },
    });

  it('prints the two halves the way the popup shows them', () => {
    expect(on(9.4, 0.69)).toBe('+9 dB now · −31% light now');
    expect(on(-1.6, 0.9)).toBe('−2 dB now · −10% light now');
    expect(on(0.2, 1.2)).toBe('±0 dB now · +20% light now');
  });

  it('switches to a multiplier once the lift is large, since "+180%" reads badly', () => {
    expect(on(9, 2.84)).toBe('+9 dB now · 2.8× light now');
    expect(on(9, 1.5)).toBe('+9 dB now · 1.5× light now');
    expect(on(9, 1.49)).toBe('+9 dB now · +49% light now');
  });

  it('says "as is" instead of printing a change nobody could see', () => {
    expect(on(9, 1.0)).toBe('+9 dB now · Picture as is now');
    expect(on(9, 1.01)).toBe('+9 dB now · Picture as is now');
    expect(on(9, null)).toBe('+9 dB now · Picture as is now');
  });

  it('leaves out a half that is not running, and says so when the sound is waiting', () => {
    expect(
      describeMeter({
        held: false,
        audio: { active: false, gainDb: null },
        video: { active: true, lightRatio: 0.74 },
      }),
    ).toBe('−26% light now');
    expect(
      describeMeter({
        held: false,
        audio: { active: true, gainDb: null },
        video: { active: false, lightRatio: null },
      }),
    ).toBe('Sound waiting');
    expect(
      describeMeter({
        held: false,
        audio: { active: false, gainDb: null },
        video: { active: false, lightRatio: null },
      }),
    ).toBe('');
  });

  it('names the comparison while Compare is held, whatever the numbers say', () => {
    expect(
      describeMeter({
        held: true,
        audio: { active: true, gainDb: 9 },
        video: { active: true, lightRatio: 0.7 },
      }),
    ).toBe('Original sound and picture');
  });

  it('stays short enough for the popup row', () => {
    for (const [gain, ratio] of [
      [24, 0.5],
      [-12, 4.9],
      [0, 1],
      [9.4, 0.69],
    ] as const) {
      expect(on(gain, ratio).length).toBeLessThanOrEqual(30);
    }
  });
});
