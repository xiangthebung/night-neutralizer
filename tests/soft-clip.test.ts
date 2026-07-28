import { describe, expect, it } from 'vitest';
import {
  IDENTITY_SOFT_CLIP,
  buildSoftClipCurve,
  isIdentitySoftClip,
  softClip,
} from '../src/core/soft-clip';
import { mapAudioStrength } from '../src/core/strength';

const active = mapAudioStrength(100).safety;

describe('softClip', () => {
  it('is exactly the identity below the knee', () => {
    for (const x of [0, 0.1, 0.5, 0.85, 0.9, -0.5, -0.9]) {
      expect(softClip(active, x)).toBe(x);
    }
  });

  it('never exceeds the ceiling, however hot the input', () => {
    for (const x of [0.95, 1, 1.5, 4, 50, -1, -4, -50]) {
      expect(Math.abs(softClip(active, x))).toBeLessThanOrEqual(active.ceiling);
    }
  });

  it('is monotonic and symmetric', () => {
    let previous = -Infinity;
    for (let x = 0; x <= 3; x += 0.01) {
      const y = softClip(active, x);
      expect(y).toBeGreaterThanOrEqual(previous - 1e-12);
      expect(softClip(active, -x)).toBeCloseTo(-y, 12);
      previous = y;
    }
  });

  it('costs a full-scale signal only a fraction of a dB', () => {
    const loss = 20 * Math.log10(softClip(active, 1));
    expect(loss).toBeLessThan(0);
    expect(loss).toBeGreaterThan(-1);
  });

  it('reduces slope as it approaches the ceiling', () => {
    const slope = (x: number) => (softClip(active, x + 0.01) - softClip(active, x)) / 0.01;
    expect(slope(0.5)).toBeCloseTo(1, 6);
    expect(slope(0.95)).toBeLessThan(1);
    expect(slope(1.5)).toBeLessThan(slope(0.95));
  });

  it('passes everything through when identity', () => {
    expect(isIdentitySoftClip(IDENTITY_SOFT_CLIP)).toBe(true);
    for (const x of [-1, -0.3, 0, 0.3, 1]) {
      expect(softClip(IDENTITY_SOFT_CLIP, x)).toBe(x);
    }
  });
});

describe('buildSoftClipCurve', () => {
  it('spans -headroom..+headroom with an odd sample count', () => {
    const curve = buildSoftClipCurve(active, 2048);
    expect(curve.length % 2).toBe(1);
    expect(curve[0]).toBeCloseTo(-softClip(active, active.headroom), 6);
    expect(curve[curve.length - 1]).toBeCloseTo(softClip(active, active.headroom), 6);
    expect(curve[(curve.length - 1) / 2]).toBe(0);
  });

  it('is monotonic and bounded', () => {
    const curve = buildSoftClipCurve(active);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i] as number).toBeGreaterThanOrEqual(curve[i - 1] as number);
      expect(Math.abs(curve[i] as number)).toBeLessThanOrEqual(active.ceiling);
    }
  });

  it('keeps the sampled identity region on the identity line', () => {
    // WaveShaper interpolates linearly between samples, so exact identity
    // samples mean an exactly transparent region.
    const curve = buildSoftClipCurve(active);
    const mid = (curve.length - 1) / 2;
    const step = active.headroom / mid;
    for (let i = 0; i <= mid; i++) {
      const x = i * step;
      if (x > active.knee) break;
      expect(curve[mid + i] as number).toBeCloseTo(x, 6);
    }
  });

  it('degenerates to a straight line when identity', () => {
    const curve = buildSoftClipCurve(IDENTITY_SOFT_CLIP, 5);
    expect([...curve]).toEqual([-1, -0.5, 0, 0.5, 1]);
  });
});
