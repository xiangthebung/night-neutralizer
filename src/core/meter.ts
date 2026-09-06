/**
 * The live meter: what the extension is applying *right now*, in two numbers.
 *
 * The captions in `readings.ts` describe what a setting does in general — the
 * curve at its most engaged, the transfer function settled on a whisper. This
 * module describes the moment: the gain the audio chain is adding to the
 * signal currently passing through it, and how much the tone curve currently
 * on the filter is changing the light of the frame currently on screen. The
 * two are the proof a first-time user is looking for, because they move when
 * the film does — up on a quiet line, down on an explosion, down again when a
 * night scene cuts to daylight.
 *
 * Pure, and fed by the engines through the live port (`core/messages.ts`), so
 * the popup's wording and the content script's arithmetic are tested in one
 * place and cannot drift apart.
 */
import { chromiumInternalMakeupDb } from './strength';
import { HIST_BINS, toLinearLight } from './tone-curve';
import type { AudioParams } from './types';

/**
 * Net gain the audio chain is applying at this instant, in dB.
 *
 * `reductionDb` is what `DynamicsCompressorNode.reduction` reports: the gain
 * reduction the compressor is currently applying, 0 or negative, *before* the
 * kernel's own make-up. So the whole path from the element to the sink is
 * pre-gain, the reduction, Chromium's internal make-up (see
 * `chromiumInternalMakeupDb`), our make-up, and whatever the limiter is
 * currently taking off. On a quiet line the reduction is ~0 and this reads
 * about +9 dB at the default; on a full-scale burst the reduction swallows the
 * gain and it reads a little below 0.
 */
export function audioGainNowDb(
  params: AudioParams,
  reductionDb: number,
  limiterReductionDb = 0,
): number {
  if (params.bypass) return 0;
  const reduction = Number.isFinite(reductionDb) ? Math.min(0, reductionDb) : 0;
  const limiter = Number.isFinite(limiterReductionDb) ? Math.min(0, limiterReductionDb) : 0;
  return (
    params.preGainDb +
    reduction +
    chromiumInternalMakeupDb(params.compressor.thresholdDb, params.compressor.ratio) +
    params.makeupGainDb +
    limiter
  );
}

/** Sample a LUT at an arbitrary input, interpolating between entries. */
function sampleCurve(curve: ArrayLike<number>, input: number): number {
  const n = curve.length;
  if (n === 0) return input;
  const position = Math.min(Math.max(input, 0), 1) * (n - 1);
  const low = Math.floor(position);
  const high = Math.min(n - 1, low + 1);
  const fraction = position - low;
  const a = curve[low] ?? input;
  const b = curve[high] ?? a;
  return a + (b - a) * fraction;
}

/**
 * How much light the frame emits after the curve, over how much it emitted
 * before, in linear light.
 *
 * Weighted by the frame's own luminance histogram when there is one, so the
 * figure is about the picture on screen: a night scene is mostly near-black
 * bins, and the lift there can double the light a frame gives off while a
 * bright scene loses a third of its. Without a histogram — a protected player,
 * whose frames cannot be read — every level is weighted equally, which is the
 * curve's effect on a full ramp and the only honest number available.
 *
 * Null when the curve is the identity or nothing is applied, so the caller can
 * say "unchanged" rather than print a ratio of 1.00.
 */
export function lightRatio(
  curve: ArrayLike<number>,
  histogram: ArrayLike<number> | null | undefined,
): number | null {
  if (curve.length < 2) return null;
  const bins = histogram && histogram.length > 1 ? histogram.length : HIST_BINS;
  let before = 0;
  let after = 0;
  let mass = 0;
  for (let bin = 0; bin < bins; bin++) {
    const weight = histogram && histogram.length > 1 ? (histogram[bin] as number) : 1;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    const input = (bin + 0.5) / bins;
    before += weight * toLinearLight(input);
    after += weight * toLinearLight(sampleCurve(curve, input));
    mass += weight;
  }
  if (!(mass > 0) || !(before > 0)) return null;
  const ratio = after / before;
  return Number.isFinite(ratio) ? ratio : null;
}

export interface MeterReading {
  /** True while Compare is held: the tab is showing the site's own output. */
  held: boolean;
  audio: { active: boolean; gainDb: number | null };
  video: { active: boolean; lightRatio: number | null };
}

/**
 * The meter as the popup prints it: `+9 dB now · −31% light now`.
 *
 * The audio half is the net gain on the signal at this moment, whole decibels,
 * always signed. The picture half is the change in emitted light: a percentage
 * when the curve is dimming, a multiplier once it is lifting by half or more,
 * because "+180% light" is a number nobody reads and "2.8× light" is. Both are
 * suffixed *now*, because that is the difference between this line and the
 * captions above it. A half that is not running is left out; with neither
 * running the line is empty and the caller hides it.
 */
export function describeMeter(reading: MeterReading): string {
  if (reading.held) return 'Original sound and picture';
  const parts: string[] = [];
  if (reading.audio.active) {
    const gain = reading.audio.gainDb;
    if (gain === null || !Number.isFinite(gain)) parts.push('Sound waiting');
    else {
      const whole = Math.round(gain);
      parts.push(`${whole > 0 ? '+' : whole < 0 ? '−' : '±'}${Math.abs(whole)} dB now`);
    }
  }
  if (reading.video.active) {
    const ratio = reading.video.lightRatio;
    if (ratio === null || !Number.isFinite(ratio) || Math.abs(ratio - 1) < 0.015) {
      parts.push('Picture as is now');
    } else if (ratio >= 1.5) {
      parts.push(`${ratio.toFixed(1)}× light now`);
    } else {
      const percent = Math.round((ratio - 1) * 100);
      parts.push(`${percent > 0 ? '+' : '−'}${Math.abs(percent)}% light now`);
    }
  }
  return parts.join(' · ');
}
