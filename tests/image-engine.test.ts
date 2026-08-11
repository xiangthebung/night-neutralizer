// @vitest-environment jsdom
/**
 * The image engine is small, and all of it is host-page manipulation: it
 * installs a rule, keeps it alive, and must leave nothing behind when switched
 * off. Those are exactly the behaviours that are cheap to cover here and
 * expensive to notice in the wild — an extension that leaves an `img{filter}`
 * rule in a page after being turned off has broken every picture on it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageEngine } from '../src/content/image-engine';
import { mapVideoStrength } from '../src/core/strength';

const STYLE_ID = 'nn-image-tone-style';
const FILTER_ID = 'nn-image-tone-curve';

const params = mapVideoStrength(45);

function rule(): string {
  return document.getElementById(STYLE_ID)?.textContent ?? '';
}

let engine: ImageEngine;
let changes: number;

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  // The filter host hangs off documentElement, so clearing head and body is not
  // enough to isolate one test from the next.
  for (const node of document.querySelectorAll(`svg, #${STYLE_ID}`)) node.remove();
  vi.spyOn(CSS, 'supports').mockReturnValue(true);
  vi.useFakeTimers();
  changes = 0;
  engine = new ImageEngine(document, () => {
    changes++;
  });
});

afterEach(() => {
  engine.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('setParams', () => {
  it('filters every img through one document-wide curve', () => {
    engine.setParams(params, true);
    expect(rule()).toBe(`img{filter:url("#${FILTER_ID}") !important;}`);
    // The table is the real curve, not a placeholder: a 33-entry LUT that ends
    // below full scale, since this curve only ever darkens.
    const table = (document.querySelector('feFuncR')?.getAttribute('tableValues') ?? '').split(' ');
    expect(table.length).toBe(33);
    expect(Number(table[0])).toBe(0);
    expect(Number(table[32])).toBeLessThan(1);
    expect(changes).toBeGreaterThan(0);
  });

  it('uses its own filter id, so video and stills cannot share a curve', () => {
    engine.setParams(params, true);
    expect(document.getElementById(FILTER_ID)).not.toBeNull();
    expect(document.getElementById('nn-tone-curve')).toBeNull();
    expect(rule()).not.toContain('video');
  });

  it('leaves no trace when switched off, and comes back without a reload', () => {
    engine.setParams(params, true);
    engine.setParams(params, false);
    expect(document.getElementById(STYLE_ID)).toBeNull();
    expect(document.getElementById(FILTER_ID)).toBeNull();
    expect(engine.getStatus().active).toBe(false);

    engine.setParams(params, true);
    expect(rule()).toContain('img{filter:');
    expect(engine.getStatus().active).toBe(true);
  });

  it('treats strength 0 as off rather than as an identity curve', () => {
    // A bypass curve would still put an `img{filter:url(...)}` rule on every
    // picture on the page, which is a composited layer each for no effect.
    engine.setParams(mapVideoStrength(0), true);
    expect(document.getElementById(STYLE_ID)).toBeNull();
    expect(engine.getStatus().active).toBe(false);
  });
});

describe('upkeep', () => {
  it('repairs itself when the page removes the injected nodes', () => {
    engine.setParams(params, true);
    const before = document.querySelector('feFuncR')?.getAttribute('tableValues');
    document.getElementById(STYLE_ID)?.remove();
    document.querySelector('svg')?.remove();

    vi.advanceTimersByTime(2000);
    expect(rule()).toContain('img{filter:');
    expect(document.querySelector('feFuncR')?.getAttribute('tableValues')).toBe(before);
  });

  it('stops the timer once it is switched off', () => {
    engine.setParams(params, true);
    engine.setParams(params, false);
    vi.advanceTimersByTime(10_000);
    expect(document.getElementById(STYLE_ID)).toBeNull();
  });

  it('follows the fullscreen element, which is the only rendered subtree', () => {
    engine.setParams(params, true);
    const svg = document.querySelector('svg') as SVGSVGElement;
    const viewer = document.createElement('div');
    document.body.appendChild(viewer);
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => viewer,
    });

    document.dispatchEvent(new Event('fullscreenchange'));
    expect(viewer.contains(svg)).toBe(true);
  });
});

describe('status', () => {
  it('counts the pictures in the document without holding on to any of them', () => {
    document.body.innerHTML = '<img src="a.png" /><img src="b.png" /><picture><img /></picture>';
    engine.setParams(params, true);
    expect(engine.getStatus().elements).toBe(3);
    // Live count: an image added later is covered by the selector, so it has to
    // be counted too.
    document.body.appendChild(document.createElement('img'));
    expect(engine.getStatus().elements).toBe(4);
  });

  it('counts pictures whether or not the filter is on', () => {
    // The count is what the popup shows next to the video line, and "0 images"
    // and "images off" are different things to say.
    document.body.innerHTML = '<img src="a.png" />';
    expect(engine.getStatus()).toEqual({ active: false, elements: 1, notes: [] });
  });
});

describe('destroy', () => {
  it('removes the rule and refuses to come back', () => {
    engine.setParams(params, true);
    engine.destroy();
    expect(document.getElementById(STYLE_ID)).toBeNull();
    engine.setParams(params, true);
    expect(document.getElementById(STYLE_ID)).toBeNull();
    expect(engine.getStatus().active).toBe(false);
  });
});
