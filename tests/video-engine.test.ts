// @vitest-environment jsdom
/**
 * The frame-skip control law.
 *
 * This is the piece that decides how often the engine looks at the video, so it
 * sets the ceiling on how smooth the effect can possibly be — no amount of good
 * adaptation maths helps if the curve only reaches the compositor every eighth
 * frame. It is also the piece least visible from outside: in a browser its only
 * observable is the update rate, and `performance.now()` is clamped to 100 us
 * without cross-origin isolation, so measuring a cheap read-back mostly
 * measures the clock. Hence a direct test of the law itself.
 */
import { describe, expect, it } from 'vitest';
import { nextFrameStride } from '../src/content/video-engine';

const BUDGET = 1.2;

/** Run the law to convergence, and report whether it actually converged. */
function settle(costMs: number, from = 1, budget = BUDGET) {
  let stride = from;
  const seen: number[] = [stride];
  for (let i = 0; i < 20; i++) {
    const next = nextFrameStride(stride, costMs, budget);
    if (next === stride) return { stride, steps: seen, converged: true };
    stride = next;
    seen.push(stride);
  }
  return { stride, steps: seen, converged: false };
}

describe('nextFrameStride', () => {
  it('samples every frame when the read-back is cheap', () => {
    // The measured cost on the synthetic smoke clip is ~0.015 ms, two orders of
    // magnitude inside the budget.
    for (const cost of [0, 0.015, 0.2, 0.5]) {
      expect(settle(cost).stride).toBe(1);
    }
  });

  it('settles instead of ratcheting to the maximum', () => {
    // The regression. The old law compared the raw per-sample cost against the
    // budget; that number does not change when frames are skipped, so anything
    // over the line drove the stride to 8 and left it there. A 2.4 ms read-back
    // needs to skip exactly one frame in two, not seven in eight.
    const settled = settle(2.4);
    expect(settled.converged).toBe(true);
    expect(settled.stride).toBe(2);
    expect(settled.stride * BUDGET).toBeGreaterThanOrEqual(2.4);
  });

  it('converges from any starting stride to the same place', () => {
    // Includes costs that land exactly on a band edge (2.4 = 2 x budget,
    // 4.8 = 4 x budget). With both comparisons strict those were stable at two
    // strides at once, so where the engine ended up depended on how it got
    // there and a video could stay a step coarser than it needed to.
    for (const cost of [0.1, 0.6, 0.9, 1.2, 2.4, 4, 4.8, 9]) {
      const target = settle(cost).stride;
      for (const from of [1, 2, 4, 8]) {
        const settled = settle(cost, from);
        expect(settled.converged).toBe(true);
        expect(settled.stride).toBe(target);
      }
    }
  });

  it('lands on the cheapest stride that fits the budget', () => {
    for (const cost of [0.05, 0.7, 1.3, 2.4, 4.5, 9]) {
      const stride = settle(cost).stride;
      // Inside budget...
      expect(cost / stride).toBeLessThanOrEqual(BUDGET);
      // ...and not needlessly coarse: one step finer would not fit.
      if (stride > 1) expect(cost / (stride / 2)).toBeGreaterThan(BUDGET);
    }
  });

  it('never oscillates once settled', () => {
    for (const cost of [0.3, 1.2, 2.4, 3.6, 6]) {
      const stride = settle(cost).stride;
      expect(nextFrameStride(stride, cost)).toBe(stride);
      expect(nextFrameStride(nextFrameStride(stride, cost), cost)).toBe(stride);
    }
  });

  it('caps out rather than skipping unboundedly', () => {
    for (const cost of [20, 200, 1e6]) {
      expect(settle(cost).stride).toBe(8);
    }
  });

  it('comes back to every frame once sampling gets cheap again', () => {
    // A tab moved to a slower display, or a source that dropped resolution.
    // The old law could climb but never descend on the same signal.
    const settled = settle(0.02, 8);
    expect(settled.converged).toBe(true);
    expect(settled.stride).toBe(1);
    expect(settled.steps).toEqual([8, 4, 2, 1]);
  });

  it('survives a nonsense stride or cost', () => {
    for (const stride of [0, -4, 3, 1000, Number.NaN, Number.POSITIVE_INFINITY]) {
      const next = nextFrameStride(stride, 0.5);
      expect(Number.isInteger(next)).toBe(true);
      expect(next).toBeGreaterThanOrEqual(1);
      expect(next).toBeLessThanOrEqual(8);
    }
    expect(nextFrameStride(1, Number.NaN)).toBe(1);
  });
});
