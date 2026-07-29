/**
 * These captions are claims made to the user about what the extension is doing,
 * so they are tested against the same functions the engines use. A caption that
 * is merely plausible is worse than no caption.
 */
import { describe, expect, it } from 'vitest';
import {
  LOUD_DB,
  QUIET_DB,
  SHADOW_INPUT,
  audioEffect,
  describeAudioEffect,
  describeVideoEffect,
  videoEffect,
} from '../src/core/readings';
import { audioTransferDb, mapAudioStrength, mapVideoStrength } from '../src/core/strength';
import { adaptBounds, buildToneCurve } from '../src/core/tone-curve';

const STEPS = Array.from({ length: 101 }, (_, i) => i);

describe('videoEffect', () => {
  it('reports no effect at strength 0', () => {
    const effect = videoEffect(0);
    expect(effect.bypass).toBe(true);
    expect(effect.shadowGain).toBe(1);
    expect(effect.whiteDrop).toBe(0);
  });

  it('agrees with the curves the content script builds', () => {
    // The whole point of this module: the numbers must come from the real LUTs,
    // not from a plausible-looking approximation of them.
    for (const strength of [15, 45, 70, 100]) {
      const params = mapVideoStrength(strength);
      const bounds = adaptBounds();
      const lifted = buildToneCurve(params, bounds.dark, 65);
      const rolled = buildToneCurve(params, bounds.bright, 65);
      const effect = videoEffect(strength);

      expect(effect.whiteDrop).toBeCloseTo(1 - (rolled.at(-1) as number), 10);
      // Interpolated at 0.05, which falls between LUT entries.
      expect(effect.shadowGain * SHADOW_INPUT).toBeGreaterThan(lifted[3] as number);
      expect(effect.shadowGain * SHADOW_INPUT).toBeLessThan(lifted[4] as number);
    }
  });

  it('takes each figure from the bound where it is strongest', () => {
    // `adaptBounds()` gives the extreme of each axis, not two whole scenes:
    // `dark` is full lift with the least roll-off. Reading both numbers off one
    // bound understates the effect, which is what this guards against.
    const strength = 45;
    const params = mapVideoStrength(strength);
    const bounds = adaptBounds();
    const liftedWhite = 1 - (buildToneCurve(params, bounds.dark, 65).at(-1) as number);
    const rolledWhite = 1 - (buildToneCurve(params, bounds.bright, 65).at(-1) as number);

    expect(rolledWhite).toBeGreaterThan(liftedWhite);
    expect(videoEffect(strength).whiteDrop).toBeCloseTo(rolledWhite, 10);
  });

  it('matches the documented figures at the default strength', () => {
    // README: at strength 45, input 0.05 -> 0.134 with the lift fully engaged,
    // and white lands at 0.871 with the roll-off fully engaged. If either drifts,
    // the documentation is now wrong too.
    // The README quotes the nearest LUT entry (input 0.047), this interpolates at
    // exactly 0.05, so the ratio here sits a little above the documented 2.7x.
    const effect = videoEffect(45);
    expect(effect.shadowGain).toBeGreaterThan(2.6);
    expect(effect.shadowGain).toBeLessThan(3.1);
    expect(effect.whiteDrop).toBeGreaterThan(0.11);
    expect(effect.whiteDrop).toBeLessThan(0.15);
  });

  it('grows with strength and never inverts', () => {
    let previousGain = 0;
    let previousDrop = -1;
    for (const strength of STEPS) {
      const effect = videoEffect(strength);
      expect(effect.shadowGain).toBeGreaterThanOrEqual(previousGain - 1e-9);
      expect(effect.whiteDrop).toBeGreaterThanOrEqual(previousDrop - 1e-9);
      // Shadows are never darkened and white is never pushed above full scale.
      expect(effect.shadowGain).toBeGreaterThanOrEqual(1);
      expect(effect.whiteDrop).toBeGreaterThanOrEqual(0);
      previousGain = effect.shadowGain;
      previousDrop = effect.whiteDrop;
    }
  });
});

describe('audioEffect', () => {
  it('reports no effect at strength 0', () => {
    expect(audioEffect(0)).toEqual({ bypass: true, liftDb: 0, narrowingDb: 0 });
  });

  it('agrees with the transfer function the popup plots', () => {
    for (const strength of [15, 45, 70, 100]) {
      const params = mapAudioStrength(strength);
      const effect = audioEffect(strength);
      expect(effect.liftDb).toBeCloseTo(audioTransferDb(params, QUIET_DB) - QUIET_DB, 10);
      expect(effect.narrowingDb).toBeCloseTo(
        LOUD_DB -
          QUIET_DB -
          (audioTransferDb(params, LOUD_DB) - audioTransferDb(params, QUIET_DB)),
        10,
      );
    }
  });

  it('lifts the quiet end and narrows the span, never the reverse', () => {
    for (const strength of STEPS.slice(1)) {
      const effect = audioEffect(strength);
      expect(effect.liftDb).toBeGreaterThan(0);
      expect(effect.narrowingDb).toBeGreaterThan(0);
      // The span must never collapse or invert: that would mean quiet material
      // coming out louder than loud material.
      expect(effect.narrowingDb).toBeLessThan(LOUD_DB - QUIET_DB);
    }
  });

  it('narrows the span further as strength rises', () => {
    let previous = 0;
    for (const strength of STEPS.slice(1)) {
      const effect = audioEffect(strength);
      expect(effect.narrowingDb).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = effect.narrowingDb;
    }
  });

  it('accounts for the night EQ', () => {
    expect(audioEffect(60, true).liftDb).not.toBeCloseTo(audioEffect(60, false).liftDb, 3);
  });
});

describe('captions', () => {
  it('says plainly that nothing is happening at strength 0', () => {
    expect(describeVideoEffect(0)).toEqual(['Picture untouched', '']);
    expect(describeAudioEffect(0)).toEqual(['Sound untouched', '']);
  });

  it('states the effect in numbers at the default strength', () => {
    expect(describeVideoEffect(45)[0]).toMatch(/^Dark scenes 2\.\d× brighter$/);
    expect(describeVideoEffect(45)[1]).toMatch(/^Whites 1\d% softer$/);
    expect(describeAudioEffect(45)[0]).toMatch(/^Quiet parts \+\d+ dB$/);
    expect(describeAudioEffect(45)[1]).toMatch(/^Loud-to-quiet gap −\d+ dB$/);
  });

  it('never overstates what the chain delivers', () => {
    // Figures are floored, because the transfer model reads slightly optimistic
    // against a rendered measurement.
    for (const strength of STEPS.slice(1)) {
      const effect = audioEffect(strength);
      const [lift, gap] = describeAudioEffect(strength);
      const quoted = Number(lift.match(/\+(\d+) dB/)?.[1] ?? 0);
      const quotedGap = Number(gap.match(/−(\d+) dB/)?.[1] ?? 0);
      expect(quoted).toBeLessThanOrEqual(effect.liftDb);
      expect(quotedGap).toBeLessThanOrEqual(effect.narrowingDb);
    }
  });

  it('avoids meaningless numbers at the very bottom of the range', () => {
    // "Dark scenes 1.0× brighter" and "Whites 0% softer" are worse than words.
    for (const strength of [1, 2, 3]) {
      for (const line of [...describeVideoEffect(strength), ...describeAudioEffect(strength)]) {
        expect(line).not.toMatch(/1\.0×/);
        expect(line).not.toMatch(/\b0%/);
        expect(line).not.toMatch(/\+0 dB/);
        expect(line).not.toMatch(/−0 dB/);
      }
    }
  });

  it('produces captions short enough for the popup column', () => {
    // Each caption line sits in a ~136 px column at 10 px; past roughly 30
    // characters it wraps and the popup outgrows Chrome's 600 px cap.
    for (const strength of STEPS) {
      for (const line of [...describeVideoEffect(strength), ...describeAudioEffect(strength)]) {
        expect(line.length).toBeLessThanOrEqual(30);
      }
    }
  });
});
