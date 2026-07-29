/**
 * Plain-language readings of what a strength setting actually does.
 *
 * Why this exists: a curve with unlabelled axes is not self-explanatory. "in →
 * out" underneath a shape means something to whoever wrote it and nothing to
 * whoever is trying to decide where to put the slider. So the popup states the
 * effect in numbers, and the graph becomes the supporting detail.
 *
 * Why it is a pure module rather than popup code: these sentences are claims
 * about what the extension is doing, so they have to be derived from the same
 * functions the engines use, and they have to be testable. A caption that is
 * merely plausible is worse than no caption.
 */
import { adaptBounds, buildToneCurve } from './tone-curve';
import { audioTransferDb, mapAudioStrength, mapVideoStrength } from './strength';

/** Input level treated as "a whispered line". */
export const QUIET_DB = -45;
/** Input level treated as "a full-scale peak". */
export const LOUD_DB = 0;
/** Where crushed shadow detail lives, as a fraction of full brightness. */
export const SHADOW_INPUT = 0.05;

export interface VideoEffect {
  bypass: boolean;
  /** How much more of a near-black input becomes visible, as a multiplier. */
  shadowGain: number;
  /** How far the white point is pulled back, as a fraction of full scale. */
  whiteDrop: number;
}

export interface AudioEffect {
  bypass: boolean;
  /** Gain applied to a whisper, in dB. */
  liftDb: number;
  /** How much the quiet-to-loud span shrinks, in dB. */
  narrowingDb: number;
}

/** Sample a LUT at an arbitrary input, interpolating between entries. */
function sampleCurve(curve: readonly number[], input: number): number {
  if (curve.length === 0) return input;
  const position = Math.min(Math.max(input, 0), 1) * (curve.length - 1);
  const low = Math.floor(position);
  const high = Math.min(curve.length - 1, low + 1);
  const fraction = position - low;
  const a = curve[low] ?? input;
  const b = curve[high] ?? a;
  return a + (b - a) * fraction;
}

/**
 * The video effect, with each half quoted at its own most-engaged state.
 *
 * `adaptBounds()` returns the extreme of each *axis*, not two whole scenes:
 * `dark` is full shadow lift with the *least* highlight roll-off, and `bright` is
 * the reverse. Reading both numbers off one bound therefore pairs the largest
 * shadow lift with the smallest highlight softening and understates the effect.
 *
 * Since the two caption lines describe two different situations anyway — what
 * happens to a dark scene, and what happens to whites — each is taken from the
 * bound where it actually applies. Together they span the same range as the
 * shaded band on the graph.
 */
export function videoEffect(strength: number): VideoEffect {
  const params = mapVideoStrength(strength);
  if (params.bypass) return { bypass: true, shadowGain: 1, whiteDrop: 0 };

  const bounds = adaptBounds();
  const lifted = buildToneCurve(params, bounds.dark, 65);
  const rolled = buildToneCurve(params, bounds.bright, 65);
  return {
    bypass: false,
    shadowGain: sampleCurve(lifted, SHADOW_INPUT) / SHADOW_INPUT,
    whiteDrop: 1 - sampleCurve(rolled, 1),
  };
}

export function audioEffect(strength: number, nightEq = false): AudioEffect {
  const params = mapAudioStrength(strength, nightEq);
  if (params.bypass) return { bypass: true, liftDb: 0, narrowingDb: 0 };

  const quietOut = audioTransferDb(params, QUIET_DB);
  const loudOut = audioTransferDb(params, LOUD_DB);
  return {
    bypass: false,
    liftDb: quietOut - QUIET_DB,
    // The span between a whisper and a peak is the number that matters: it is
    // what lets the volume come down without the dialogue disappearing.
    narrowingDb: LOUD_DB - QUIET_DB - (loudOut - quietOut),
  };
}

/**
 * Two short lines for the video graph's caption. The second may be empty, which
 * callers should treat as "nothing more to say".
 *
 * Figures are rounded *down* so a caption never promises more than the chain
 * delivers: `audioTransferDb()` models the settled response and reads slightly
 * optimistic against a rendered measurement.
 */
export function describeVideoEffect(strength: number): [string, string] {
  const effect = videoEffect(strength);
  if (effect.bypass) return ['Picture untouched', ''];

  const drop = Math.floor(effect.whiteDrop * 100);
  return [
    effect.shadowGain >= 1.05
      ? `Dark scenes ${effect.shadowGain.toFixed(1)}× brighter`
      : 'Dark scenes barely lifted',
    drop >= 1 ? `Whites ${drop}% softer` : 'Whites unchanged',
  ];
}

export function describeAudioEffect(strength: number, nightEq = false): [string, string] {
  const effect = audioEffect(strength, nightEq);
  if (effect.bypass) return ['Sound untouched', ''];

  const lift = Math.floor(effect.liftDb);
  const narrowing = Math.floor(effect.narrowingDb);
  return [
    lift >= 1 ? `Quiet parts +${lift} dB` : 'Quiet parts barely raised',
    narrowing >= 1 ? `Loud-to-quiet gap −${narrowing} dB` : 'Gap unchanged',
  ];
}
