/**
 * Final safety stage: a soft clipper.
 *
 * Why it is needed. Every gain-based stage has a finite attack time, so an
 * abrupt full-scale transient arriving after a quiet passage is amplified by
 * the full make-up gain before the compressor and limiter can respond. An
 * offline render of the chain measured that overshoot at +0.5 dBFS, which the
 * audio sink turns into hard clipping. No arrangement of `DynamicsCompressor`
 * nodes fixes this: Web Audio has no true look-ahead limiter.
 *
 * A `WaveShaperNode` does, because it is instantaneous. The curve is exactly
 * the identity below `knee`, then bends smoothly towards `ceiling`:
 *
 *     |y| = knee + a * (1 - exp(-(|x| - knee) / a)),   a = ceiling - knee
 *
 * Slope is 1 at the knee and decreases monotonically, so it rounds peaks
 * instead of squaring them off.
 *
 * A WaveShaper maps input -1..1 onto the curve and clamps anything beyond, so
 * the signal is attenuated by `1 / headroom` first and the curve is built over
 * the wider domain. With `headroom = 2` the clipper has 6 dB of working range
 * above full scale before it degenerates into a hard clamp at `ceiling`.
 */
import { clamp } from './math';

export interface SoftClipParams {
  /** Input range the curve covers, in multiples of full scale. 1 = identity. */
  headroom: number;
  /** Below this absolute level the curve is exactly the identity. */
  knee: number;
  /** Asymptotic output ceiling, always < 1 so the sink never clips. */
  ceiling: number;
}

export const IDENTITY_SOFT_CLIP: Readonly<SoftClipParams> = Object.freeze({
  headroom: 1,
  knee: 1,
  ceiling: 1,
});

export function isIdentitySoftClip(params: SoftClipParams): boolean {
  return params.headroom === 1 && params.knee >= 1 && params.ceiling >= 1;
}

/** Transfer function for a single sample. */
export function softClip(params: SoftClipParams, x: number): number {
  const knee = clamp(params.knee, 0, 1);
  const ceiling = clamp(params.ceiling, knee, 1);
  const magnitude = Math.abs(x);
  if (magnitude <= knee) return x;

  const a = ceiling - knee;
  const shaped =
    a <= 0 ? knee : knee + a * (1 - Math.exp(-(magnitude - knee) / a));
  return x < 0 ? -shaped : shaped;
}

/**
 * Sample the curve for `WaveShaperNode.curve`. Index 0 maps to input
 * `-headroom`, the last index to `+headroom`. An odd length keeps a sample
 * exactly at zero so the curve stays symmetric.
 */
export function buildSoftClipCurve(
  params: SoftClipParams,
  length = 2049,
): Float32Array<ArrayBuffer> {
  const size = Math.max(3, length % 2 === 0 ? length + 1 : length);
  const headroom = Math.max(1, params.headroom);
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const u = (i / (size - 1)) * 2 - 1; // -1..1
    curve[i] = softClip(params, u * headroom);
  }
  return curve;
}
