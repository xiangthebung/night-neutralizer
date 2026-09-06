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
import { adaptBounds, buildToneCurve, staticAdaptState } from './tone-curve';
import { audioTransferDb, mapAudioStrength, mapVideoStrength } from './strength';
import { DEFAULT_SETTINGS } from './types';

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
 * `dark` is full shadow lift, and `bright` is full exposure dim. The shadow
 * figure therefore has to be read off `dark`, or it pairs the caption with a
 * scene the lift never applies to and understates the effect.
 *
 * The white figure is quoted from `bright` for symmetry rather than necessity:
 * since the white-point ceiling landed, both bounds resolve to the same white,
 * so this line describes what happens to highlights anywhere in the adaptive
 * range instead of at one end of it. `readings.test.ts` holds the two to each
 * other, so if that ever stops being true this comment fails with it.
 */
export function videoEffect(strength: number): VideoEffect {
  const params = mapVideoStrength(strength);
  if (params.bypass) return { bypass: true, shadowGain: 1, whiteDrop: 0 };

  const bounds = adaptBounds(params);
  const lifted = buildToneCurve(params, bounds.dark, 65);
  const rolled = buildToneCurve(params, bounds.bright, 65);
  return {
    bypass: false,
    shadowGain: sampleCurve(lifted, SHADOW_INPUT) / SHADOW_INPUT,
    whiteDrop: 1 - sampleCurve(rolled, 1),
  };
}

/**
 * The same two figures for the fixed curve a protected player gets.
 *
 * A separate reading rather than a flag on `videoEffect`, because the two are
 * claims about different curves: the adaptive one moves between its bounds as
 * scenes change, the fixed one is one curve for every scene and takes its
 * exposure from a setting instead of a measurement. The popup quotes this one
 * whenever the tab in front of the user reports `static`, so the caption
 * describes the player they are watching rather than the one they are not.
 */
export function staticVideoEffect(
  strength: number,
  protectedBrightness: number = DEFAULT_SETTINGS.protectedBrightness,
): VideoEffect {
  const params = mapVideoStrength(strength, protectedBrightness);
  if (params.bypass) return { bypass: true, shadowGain: 1, whiteDrop: 0 };

  const curve = buildToneCurve(params, staticAdaptState(params), 65);
  return {
    bypass: false,
    shadowGain: sampleCurve(curve, SHADOW_INPUT) / SHADOW_INPUT,
    whiteDrop: 1 - sampleCurve(curve, 1),
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
  return captionVideoEffect(videoEffect(strength));
}

/**
 * The caption for a protected player: same wording, computed from the fixed
 * curve, so "Whites 28% softer" is not shown over a video whose whites are
 * being softened by some other amount.
 */
export function describeStaticVideoEffect(
  strength: number,
  protectedBrightness: number = DEFAULT_SETTINGS.protectedBrightness,
): [string, string] {
  return captionVideoEffect(staticVideoEffect(strength, protectedBrightness));
}

function captionVideoEffect(effect: VideoEffect): [string, string] {
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
