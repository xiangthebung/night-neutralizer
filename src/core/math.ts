/** Small numeric helpers shared by the mapping modules. Pure, no DOM. */

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

/** Classic Hermite smoothstep, used so the slider has a gentle start. */
export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** Exponential approach towards `target` over timestep `dt` with time constant `tau`. */
export function approach(current: number, target: number, dt: number, tau: number): number {
  if (!Number.isFinite(current)) return target;
  if (tau <= 0 || dt <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (gain: number): number => 20 * Math.log10(Math.max(gain, 1e-6));

/** Round to a fixed number of decimals; keeps generated CSS/SVG strings short. */
export function round(value: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}
