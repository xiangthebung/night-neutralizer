import { describe, expect, it } from 'vitest';
import {
  audioTransferDb,
  chromiumInternalMakeupDb,
  describeStrength,
  mapAudioStrength,
  mapEqStrength,
  mapSettings,
  mapStrength,
  mapVideoStrength,
  normalizeStrength,
} from '../src/core/strength';
import { dbToGain } from '../src/core/math';
import { sanitizeSettings } from '../src/core/settings';
import { isIdentitySoftClip } from '../src/core/soft-clip';
import { DEFAULT_SETTINGS } from '../src/core/types';

const STEPS = Array.from({ length: 101 }, (_, i) => i);

describe('normalizeStrength', () => {
  it('clamps into the slider domain', () => {
    expect(normalizeStrength(-40)).toBe(0);
    expect(normalizeStrength(0)).toBe(0);
    expect(normalizeStrength(45)).toBe(45);
    expect(normalizeStrength(100)).toBe(100);
    expect(normalizeStrength(1000)).toBe(100);
  });

  it('treats any non-finite input as bypass', () => {
    // Garbage in must mean "do nothing", never "maximum processing".
    expect(normalizeStrength(Number.NaN)).toBe(0);
    expect(normalizeStrength(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeStrength(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('mapAudioStrength', () => {
  it('is a true bypass at 0', () => {
    const params = mapAudioStrength(0);
    expect(params.bypass).toBe(true);
    expect(params.compressor.ratio).toBe(1);
    expect(params.limiter.ratio).toBe(1);
    expect(params.preGainDb).toBe(0);
    expect(params.makeupGainDb).toBe(0);
    expect(dbToGain(params.preGainDb)).toBeCloseTo(1, 10);
    expect(dbToGain(params.makeupGainDb)).toBeCloseTo(1, 10);
  });

  it('bypasses for out-of-range and invalid input', () => {
    expect(mapAudioStrength(-10).bypass).toBe(true);
    expect(mapAudioStrength(Number.NaN).bypass).toBe(true);
  });

  it('engages above 0', () => {
    for (const strength of [1, 5, 45, 99, 100]) {
      expect(mapAudioStrength(strength).bypass).toBe(false);
    }
  });

  it('increases compression monotonically with strength', () => {
    let previousRatio = -Infinity;
    let previousThreshold = Infinity;
    let previousKnee = Infinity;
    for (const strength of STEPS.slice(1)) {
      const { compressor } = mapAudioStrength(strength);
      expect(compressor.ratio).toBeGreaterThanOrEqual(previousRatio);
      expect(compressor.thresholdDb).toBeLessThanOrEqual(previousThreshold);
      expect(compressor.kneeDb).toBeLessThanOrEqual(previousKnee);
      previousRatio = compressor.ratio;
      previousThreshold = compressor.thresholdDb;
      previousKnee = compressor.kneeDb;
    }
  });

  it('lengthens release with strength to avoid pumping', () => {
    const gentle = mapAudioStrength(20);
    const strong = mapAudioStrength(100);
    expect(strong.compressor.release).toBeGreaterThan(gentle.compressor.release);
    expect(strong.compressor.attack).toBeLessThan(gentle.compressor.attack);
  });

  it('targets peaks just below full scale, accounting for the node\u2019s own make-up', () => {
    // Chromium's compressor adds its own make-up gain. Modelling the chain
    // without it double-compensates: an offline render measured +32 dB on quiet
    // material and peaks at +3.3 dBFS (clipping) before this was corrected.
    const p = mapAudioStrength(100);
    const peakOut =
      p.compressor.thresholdDb +
      (p.preGainDb - p.compressor.thresholdDb) / p.compressor.ratio +
      chromiumInternalMakeupDb(p.compressor.thresholdDb, p.compressor.ratio);
    expect(peakOut + p.makeupGainDb).toBeCloseTo(-4, 6);
    expect(peakOut + p.makeupGainDb).toBeLessThan(0);
  });

  it('keeps the modelled steady-state peak below full scale at every strength', () => {
    for (const strength of STEPS) {
      const p = mapAudioStrength(strength);
      if (p.bypass) continue;
      const peakOut =
        p.compressor.thresholdDb +
        (p.preGainDb - p.compressor.thresholdDb) / p.compressor.ratio +
        chromiumInternalMakeupDb(p.compressor.thresholdDb, p.compressor.ratio);
      expect(peakOut + p.makeupGainDb).toBeLessThanOrEqual(0);
    }
  });

  it('always ends in a bounded safety stage', () => {
    expect(isIdentitySoftClip(mapAudioStrength(0).safety)).toBe(true);
    for (const strength of [1, 45, 100]) {
      const safety = mapAudioStrength(strength).safety;
      expect(isIdentitySoftClip(safety)).toBe(false);
      expect(safety.ceiling).toBeLessThan(1);
      expect(safety.knee).toBeLessThan(safety.ceiling);
      expect(safety.headroom).toBeGreaterThan(1);
    }
  });
});

describe('chromiumInternalMakeupDb', () => {
  it('is zero when the compressor is not compressing', () => {
    expect(chromiumInternalMakeupDb(-28, 1)).toBe(0);
    expect(chromiumInternalMakeupDb(0, 4)).toBe(0);
  });

  it('grows with both depth and ratio', () => {
    expect(chromiumInternalMakeupDb(-28, 4)).toBeGreaterThan(chromiumInternalMakeupDb(-14, 4));
    expect(chromiumInternalMakeupDb(-28, 4)).toBeGreaterThan(chromiumInternalMakeupDb(-28, 2));
  });

  it('stays below the full reduction it compensates for', () => {
    const reduction = 28 * (1 - 1 / 4);
    expect(chromiumInternalMakeupDb(-28, 4)).toBeLessThan(reduction);
    expect(chromiumInternalMakeupDb(-28, 4)).toBeGreaterThan(0);
  });

  it('boosts quiet content more than loud content', () => {
    const p = mapAudioStrength(70);
    const quietIn = -45;
    const loudIn = 0;
    const process = (inputDb: number): number => {
      const driven = inputDb + p.preGainDb;
      const compressed =
        driven <= p.compressor.thresholdDb
          ? driven
          : p.compressor.thresholdDb + (driven - p.compressor.thresholdDb) / p.compressor.ratio;
      return compressed + p.makeupGainDb;
    };
    const quietOut = process(quietIn);
    const loudOut = process(loudIn);
    expect(quietOut - quietIn).toBeGreaterThan(loudOut - loudIn);
    // The range must shrink, never invert.
    expect(loudOut).toBeGreaterThan(quietOut);
    expect(loudOut - quietOut).toBeLessThan(loudIn - quietIn);
  });

  it('keeps every value inside the Web Audio parameter ranges', () => {
    for (const strength of STEPS) {
      const p = mapAudioStrength(strength);
      for (const stage of [p.compressor, p.limiter]) {
        expect(stage.thresholdDb).toBeGreaterThanOrEqual(-100);
        expect(stage.thresholdDb).toBeLessThanOrEqual(0);
        expect(stage.kneeDb).toBeGreaterThanOrEqual(0);
        expect(stage.kneeDb).toBeLessThanOrEqual(40);
        expect(stage.ratio).toBeGreaterThanOrEqual(1);
        expect(stage.ratio).toBeLessThanOrEqual(20);
        expect(stage.attack).toBeGreaterThanOrEqual(0);
        expect(stage.attack).toBeLessThanOrEqual(1);
        expect(stage.release).toBeGreaterThanOrEqual(0);
        expect(stage.release).toBeLessThanOrEqual(1);
      }
      expect(p.makeupGainDb).toBeGreaterThanOrEqual(0);
      expect(p.makeupGainDb).toBeLessThanOrEqual(24);
      expect(Number.isFinite(p.preGainDb)).toBe(true);
    }
  });

  it('has no discontinuity next to bypass', () => {
    const nearZero = mapAudioStrength(1);
    expect(nearZero.compressor.ratio).toBeLessThan(1.05);
    expect(nearZero.makeupGainDb).toBeLessThan(0.5);
    expect(nearZero.preGainDb).toBeLessThan(0.5);
  });

  it('keeps limiter latency-friendly and fast', () => {
    const p = mapAudioStrength(60);
    expect(p.limiter.ratio).toBe(20);
    expect(p.limiter.attack).toBeLessThanOrEqual(0.005);
    expect(p.limiter.thresholdDb).toBeLessThan(0);
    expect(p.limiter.thresholdDb).toBeGreaterThan(-3);
  });
});

describe('mapVideoStrength', () => {
  it('is a bypass at 0', () => {
    const p = mapVideoStrength(0);
    expect(p.bypass).toBe(true);
    expect(p.blackLift).toBe(0);
    expect(p.shadowGamma).toBe(1);
    expect(p.highlightCompression).toBe(0);
    expect(p.saturation).toBe(1);
    expect(p.adapt.enabled).toBe(false);
    expect(p.adapt.flashDim).toBe(0);
  });

  it('increases shadow lift and highlight roll-off monotonically', () => {
    let lift = -1;
    let gamma = -1;
    let roll = -1;
    let knee = Infinity;
    for (const strength of STEPS.slice(1)) {
      const p = mapVideoStrength(strength);
      expect(p.blackLift).toBeGreaterThanOrEqual(lift);
      expect(p.shadowGamma).toBeGreaterThanOrEqual(gamma);
      expect(p.highlightCompression).toBeGreaterThanOrEqual(roll);
      expect(p.kneeStart).toBeLessThanOrEqual(knee);
      lift = p.blackLift;
      gamma = p.shadowGamma;
      roll = p.highlightCompression;
      knee = p.kneeStart;
    }
  });

  it('keeps the black lift small enough not to wash the image out', () => {
    // The absolute black lift is the part that greys out an image, so it stays
    // small; the shadow gamma does the visible work instead.
    expect(mapVideoStrength(100).blackLift).toBeLessThanOrEqual(0.08);
    expect(mapVideoStrength(100).shadowGamma).toBeLessThanOrEqual(2);
  });

  it('produces a visible effect at the default strength', () => {
    // Regression guard: the first release was mapped so gently that the video
    // effect was imperceptible at the default setting.
    const p = mapVideoStrength(DEFAULT_SETTINGS.strength);
    expect(p.shadowGamma).toBeGreaterThan(1.3);
    expect(p.highlightCompression).toBeGreaterThan(0.1);
    expect(p.adapt.flashDim).toBeGreaterThan(0.15);
    expect(p.adapt.minExposure).toBeLessThan(0.9);
  });

  it('compensates saturation as contrast is reduced', () => {
    expect(mapVideoStrength(100).saturation).toBeGreaterThan(mapVideoStrength(20).saturation);
    expect(mapVideoStrength(100).saturation).toBeLessThan(1.25);
  });

  it('makes the flash guard more sensitive at higher strength', () => {
    const gentle = mapVideoStrength(20);
    const strong = mapVideoStrength(100);
    expect(strong.adapt.flashRate).toBeLessThan(gentle.adapt.flashRate);
    expect(strong.adapt.flashDim).toBeGreaterThan(gentle.adapt.flashDim);
    expect(strong.adapt.minExposure).toBeLessThan(gentle.adapt.minExposure);
  });

  it('dims faster than it recovers', () => {
    const p = mapVideoStrength(50);
    expect(p.adapt.dimTau).toBeLessThan(p.adapt.recoverTau);
  });
});

describe('mapStrength', () => {
  it('returns both halves consistently', () => {
    const p = mapStrength(45);
    expect(p.audio.bypass).toBe(false);
    expect(p.video.bypass).toBe(false);
    const off = mapStrength(0);
    expect(off.audio.bypass).toBe(true);
    expect(off.video.bypass).toBe(true);
  });
});

describe('describeStrength', () => {
  it('labels the buckets', () => {
    expect(describeStrength(0)).toBe('Bypass');
    expect(describeStrength(10)).toBe('Very gentle');
    expect(describeStrength(30)).toBe('Gentle');
    expect(describeStrength(45)).toBe('Balanced');
    expect(describeStrength(70)).toBe('Strong');
    expect(describeStrength(85)).toBe('Very strong');
    expect(describeStrength(100)).toBe('Maximum');
  });

  it('only calls the very top of the range maximum', () => {
    // "80 · maximum" next to a slider that is plainly not at the end reads as a
    // bug in the readout.
    expect(describeStrength(80)).not.toBe('Maximum');
    expect(describeStrength(94)).not.toBe('Maximum');
    expect(describeStrength(95)).toBe('Maximum');
  });

  it('never labels a non-zero strength as bypass', () => {
    for (const strength of STEPS.slice(1)) {
      expect(describeStrength(strength)).not.toBe('Bypass');
    }
  });
});

describe('mapEqStrength', () => {
  it('is flat when the toggle is off', () => {
    for (const strength of [0, 45, 100]) {
      const eq = mapEqStrength(strength, false);
      expect(eq.enabled).toBe(false);
      expect(eq.lowShelfDb).toBe(0);
      expect(eq.presenceDb).toBe(0);
    }
  });

  it('is flat at strength 0 even when the toggle is on', () => {
    // Strength 0 has to stay a true bypass whatever else is switched on.
    const eq = mapEqStrength(0, true);
    expect(eq.enabled).toBe(false);
    expect(eq.lowShelfDb).toBe(0);
    expect(eq.presenceDb).toBe(0);
  });

  it('cuts the low end and lifts presence, never the other way round', () => {
    for (const strength of STEPS.slice(1)) {
      const eq = mapEqStrength(strength, true);
      expect(eq.lowShelfDb).toBeLessThan(0);
      expect(eq.presenceDb).toBeGreaterThan(0);
      // A narrow bell here would sound like a telephone.
      expect(eq.presenceQ).toBeLessThan(1.5);
      // Bass, not midrange, is what travels through walls.
      expect(eq.lowShelfHz).toBeLessThan(300);
      // Consonants, not sibilance.
      expect(eq.presenceHz).toBeGreaterThan(1500);
      expect(eq.presenceHz).toBeLessThan(5000);
    }
  });

  it('grows monotonically with strength', () => {
    let previousCut = 1;
    let previousLift = -1;
    for (const strength of STEPS) {
      const eq = mapEqStrength(strength, true);
      expect(eq.lowShelfDb).toBeLessThanOrEqual(previousCut);
      expect(eq.presenceDb).toBeGreaterThanOrEqual(previousLift);
      previousCut = eq.lowShelfDb;
      previousLift = eq.presenceDb;
    }
  });

  it('stays within a sane range at maximum', () => {
    const eq = mapEqStrength(100, true);
    expect(eq.lowShelfDb).toBeGreaterThan(-12);
    expect(eq.presenceDb).toBeLessThan(6);
  });
});

describe('night EQ in the audio chain', () => {
  it('is carried on the audio params', () => {
    expect(mapAudioStrength(60, false).eq.enabled).toBe(false);
    expect(mapAudioStrength(60, true).eq.enabled).toBe(true);
    expect(mapAudioStrength(0, true).eq.enabled).toBe(false);
  });

  it('pays for the presence lift out of make-up gain', () => {
    // The lift sits before the compressor, so ignoring it would hand the
    // limiter a signal hotter than the headroom model promises.
    //
    // Make-up gain cannot go negative, so at the very bottom of the range there
    // is less of it than the lift costs and the compensation is only partial.
    // The shortfall there is a fraction of a dB, well inside what the limiter
    // and the soft clipper absorb.
    for (const strength of [20, 45, 70, 100]) {
      const plain = mapAudioStrength(strength, false);
      const shaped = mapAudioStrength(strength, true);
      const paid = plain.makeupGainDb - shaped.makeupGainDb;
      expect(paid).toBeCloseTo(Math.min(plain.makeupGainDb, shaped.eq.presenceDb), 6);
      expect(paid).toBeGreaterThan(0);
    }
  });

  it('leaves at most a fraction of a dB of the lift uncompensated', () => {
    for (const strength of STEPS.slice(1)) {
      const plain = mapAudioStrength(strength, false);
      const shaped = mapAudioStrength(strength, true);
      const shortfall = shaped.eq.presenceDb - (plain.makeupGainDb - shaped.makeupGainDb);
      expect(shortfall).toBeLessThan(0.5);
      expect(shortfall).toBeGreaterThanOrEqual(-1e-9); // fp noise, not a real overshoot
    }
  });

  it('never asks for negative make-up gain', () => {
    for (const strength of STEPS) {
      expect(mapAudioStrength(strength, true).makeupGainDb).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('audioTransferDb', () => {
  const LEVELS = [-60, -50, -40, -30, -20, -12, -6, -3, -1, 0];

  it('is the identity when bypassed', () => {
    const params = mapAudioStrength(0);
    for (const level of LEVELS) {
      expect(audioTransferDb(params, level)).toBeCloseTo(level, 10);
    }
  });

  it('never exceeds the soft clipper ceiling', () => {
    for (const strength of STEPS) {
      for (const nightEq of [false, true]) {
        const params = mapAudioStrength(strength, nightEq);
        const ceilingDb = 20 * Math.log10(params.safety.ceiling);
        for (const level of LEVELS) {
          expect(audioTransferDb(params, level)).toBeLessThanOrEqual(ceilingDb + 1e-9);
        }
      }
    }
  });

  it('is monotonic: louder in is never quieter out', () => {
    for (const strength of [15, 45, 75, 100]) {
      const params = mapAudioStrength(strength);
      for (let index = 1; index < LEVELS.length; index++) {
        const previous = audioTransferDb(params, LEVELS[index - 1] as number);
        const current = audioTransferDb(params, LEVELS[index] as number);
        expect(current).toBeGreaterThanOrEqual(previous - 1e-9);
      }
    }
  });

  it('lifts quiet material and holds loud material down', () => {
    const params = mapAudioStrength(70);
    expect(audioTransferDb(params, -45)).toBeGreaterThan(-45);
    expect(audioTransferDb(params, 0)).toBeLessThan(0);
  });

  it('shrinks the dynamic range further as strength rises', () => {
    let previousRange = Number.POSITIVE_INFINITY;
    for (const strength of [10, 30, 50, 70, 90, 100]) {
      const params = mapAudioStrength(strength);
      const range = audioTransferDb(params, -6) - audioTransferDb(params, -45);
      expect(range).toBeLessThan(previousRange);
      expect(range).toBeGreaterThan(0);
      previousRange = range;
    }
  });
});

describe('mapSettings', () => {
  it('drives both halves from the master value while linked', () => {
    const settings = sanitizeSettings({
      strength: 80,
      linked: true,
      audioStrength: 5,
      videoStrength: 5,
    });
    const params = mapSettings(settings);
    expect(params.audio).toEqual(mapAudioStrength(80, false));
    expect(params.video).toEqual(mapVideoStrength(80));
  });

  it('honours the per-channel values once unlinked', () => {
    const settings = sanitizeSettings({
      strength: 80,
      linked: false,
      audioStrength: 90,
      videoStrength: 0,
    });
    const params = mapSettings(settings);
    expect(params.audio).toEqual(mapAudioStrength(90, false));
    // Video at 0 must be a genuine bypass even with audio at full strength.
    expect(params.video.bypass).toBe(true);
    expect(params.audio.bypass).toBe(false);
  });

  it('passes the night EQ switch through', () => {
    const settings = sanitizeSettings({ strength: 50, nightEq: true });
    expect(mapSettings(settings).audio.eq.enabled).toBe(true);
  });
});
