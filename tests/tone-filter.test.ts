// @vitest-environment jsdom
/**
 * The tone filter is the one piece of the video path that manipulates the host
 * page's DOM, and two of its behaviours are easy to break without noticing:
 * the `<base href>` workaround, and re-parenting the filter host on fullscreen.
 * Both are cheap to cover here and expensive to debug in the wild, so they were
 * the reason for adding this suite.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TONE_ATTRIBUTE, ToneFilter } from '../src/content/tone-filter';

const FILTER_ID = 'nn-tone-curve';
const STYLE_ID = 'nn-tone-style';

function rule(): string {
  return document.getElementById(STYLE_ID)?.textContent ?? '';
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  // The filter host is appended to documentElement, so clearing head and body
  // is not enough to isolate one test from the next.
  for (const node of document.querySelectorAll(`svg, #${STYLE_ID}`)) node.remove();
  // jsdom implements CSS.supports, but not for `filter: url(...)`; the code
  // treats an unknown answer as "assume SVG works", which is what a real
  // browser does. Pin it so the technique under test is the SVG one.
  vi.spyOn(CSS, 'supports').mockReturnValue(true);
});

describe('ensure', () => {
  it('installs a 33-entry sRGB LUT filter and a stylesheet', () => {
    const filter = new ToneFilter(document);
    expect(filter.ensure()).toBe(true);
    expect(filter.getTechnique()).toBe('svg-tone-curve');

    const svg = document.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');

    const def = document.getElementById(FILTER_ID);
    expect(def?.getAttribute('color-interpolation-filters')).toBe('sRGB');
    expect(def?.querySelectorAll('feFuncR, feFuncG, feFuncB').length).toBe(3);
    expect(def?.querySelector('feColorMatrix')?.getAttribute('type')).toBe('saturate');
    expect(rule()).toContain(`video[${TONE_ATTRIBUTE}="1"]`);
  });

  it('is idempotent', () => {
    const filter = new ToneFilter(document);
    filter.ensure();
    filter.ensure();
    filter.ensure();
    expect(document.querySelectorAll('svg').length).toBe(1);
    expect(document.querySelectorAll(`#${STYLE_ID}`).length).toBe(1);
  });

  it('repairs itself when the page removes the injected nodes', () => {
    // Some sites sanitise their DOM; losing the filter must not be permanent.
    const filter = new ToneFilter(document);
    filter.ensure();
    document.querySelector('svg')?.remove();
    document.getElementById(STYLE_ID)?.remove();

    filter.ensure();
    expect(document.getElementById(FILTER_ID)).not.toBeNull();
    expect(rule()).toContain('filter:');
  });

  it('falls back to basic CSS filters when url() filters are unsupported', () => {
    vi.spyOn(CSS, 'supports').mockReturnValue(false);
    const filter = new ToneFilter(document);
    filter.setFallbackCss('brightness(1.1)');
    filter.ensure();
    expect(filter.getTechnique()).toBe('css-basic');
    expect(document.getElementById(FILTER_ID)).toBeNull();
    expect(rule()).toContain('brightness(1.1)');
  });
});

describe('filter reference', () => {
  it('uses a bare fragment when the page has no <base>', () => {
    const filter = new ToneFilter(document);
    filter.ensure();
    expect(rule()).toContain(`url("#${FILTER_ID}")`);
  });

  it('spells out the document URL when the page has a <base href>', () => {
    // `url(#id)` resolves against the base URI, so a <base> tag would send the
    // reference to a different document and silently kill the effect.
    const base = document.createElement('base');
    base.setAttribute('href', 'https://cdn.example.com/assets/');
    document.head.appendChild(base);

    const filter = new ToneFilter(document);
    filter.ensure();
    const css = rule();
    expect(css).toContain(`#${FILTER_ID}`);
    expect(css).not.toContain(`url("#${FILTER_ID}")`);
    expect(css).toContain(location.href.split('#')[0] as string);
  });
});

describe('setCurve', () => {
  it('writes the table to all three channels', () => {
    const filter = new ToneFilter(document);
    filter.setCurve('0 0.5 1', 1.1);
    for (const name of ['feFuncR', 'feFuncG', 'feFuncB']) {
      expect(document.querySelector(name)?.getAttribute('tableValues')).toBe('0 0.5 1');
    }
    expect(document.querySelector('feColorMatrix')?.getAttribute('values')).toBe('1.1');
  });

  it('does not rewrite attributes when nothing changed', () => {
    const filter = new ToneFilter(document);
    filter.setCurve('0 1', 1);
    const func = document.querySelector('feFuncR') as Element;
    const spy = vi.spyOn(func, 'setAttribute');
    filter.setCurve('0 1', 1);
    expect(spy).not.toHaveBeenCalled();
    filter.setCurve('0 0.4 1', 1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('rounds saturation so tiny adaptation jitter is not a DOM write', () => {
    const filter = new ToneFilter(document);
    filter.setCurve('0 1', 1.2);
    const node = document.querySelector('feColorMatrix') as Element;
    const spy = vi.spyOn(node, 'setAttribute');
    filter.setCurve('0 1', 1.20004);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('setExtraFilters', () => {
  it('appends after the tone curve, not before it', () => {
    // Order is the whole point: the curve is the element's own correction and
    // the page's inversion is applied to the result of it.
    const filter = new ToneFilter(document);
    filter.ensure();
    filter.setExtraFilters('invert(1) hue-rotate(180deg)');
    expect(rule()).toContain(
      `video[${TONE_ATTRIBUTE}="1"]{filter:url("#${FILTER_ID}") invert(1) hue-rotate(180deg) !important;}`,
    );
  });

  it('drops the borrowed half, but not the curve, while fullscreen', () => {
    // The top layer is not painted through its ancestors' filters but is
    // painted through its own, so in fullscreen there is no root inversion left
    // for the compensation to cancel — carrying it would render the video as a
    // negative. The tone curve is this engine's own and stays.
    const filter = new ToneFilter(document);
    filter.ensure();
    filter.setExtraFilters('invert(1) hue-rotate(180deg)');
    expect(rule()).toContain(
      `video[${TONE_ATTRIBUTE}="1"]:fullscreen{filter:url("#${FILTER_ID}") !important;}`,
    );
  });

  it('writes no fullscreen rule when it is carrying nothing borrowed', () => {
    const filter = new ToneFilter(document);
    filter.ensure();
    filter.setCurve('0 0.5 1', 1);
    expect(rule()).not.toContain(':fullscreen');
  });

  it('survives a curve push, which rewrites the rule', () => {
    const filter = new ToneFilter(document);
    filter.setExtraFilters('invert(1)');
    filter.setCurve('0 0.5 1', 1.1);
    expect(rule()).toContain('invert(1)');
  });

  it('is dropped again when the page stops needing it', () => {
    const filter = new ToneFilter(document);
    filter.ensure();
    filter.setExtraFilters('invert(1)');
    filter.setExtraFilters('');
    expect(rule()).toBe(`video[${TONE_ATTRIBUTE}="1"]{filter:url("#${FILTER_ID}") !important;}`);
  });

  it('replaces the fallback rather than appending to "none"', () => {
    // In `css-basic` mode with no approximation set yet, the base value is the
    // literal `none`, and `filter: none invert(1)` is not a valid declaration.
    vi.spyOn(CSS, 'supports').mockReturnValue(false);
    const filter = new ToneFilter(document, { selector: 'img' });
    filter.ensure();
    filter.setExtraFilters('invert(1)');
    expect(rule()).toContain('img{filter:invert(1) !important;}');
    // Nothing to fall back to in fullscreen either, so the reset is a bare
    // `none` rather than `filter:none none`.
    expect(rule()).toContain('img:fullscreen{filter:none !important;}');
  });

  it('does not touch the DOM when the value is unchanged', () => {
    const filter = new ToneFilter(document);
    filter.ensure();
    filter.setExtraFilters('invert(1)');
    const node = document.getElementById(STYLE_ID) as HTMLStyleElement;
    const before = node.textContent;
    filter.setExtraFilters(' invert(1) ');
    expect(node.textContent).toBe(before);
  });
});

describe('marking', () => {
  it('marks and unmarks video elements', () => {
    const filter = new ToneFilter(document);
    const video = document.createElement('video');
    document.body.appendChild(video);

    filter.markVideo(video);
    expect(video.getAttribute(TONE_ATTRIBUTE)).toBe('1');
    filter.markVideo(video); // idempotent
    expect(video.getAttribute(TONE_ATTRIBUTE)).toBe('1');

    filter.unmarkVideo(video);
    expect(video.hasAttribute(TONE_ATTRIBUTE)).toBe(false);
    expect(() => filter.unmarkVideo(video)).not.toThrow();
  });
});

describe('syncFullscreen', () => {
  it('moves the filter host into the fullscreen subtree and back out', () => {
    // In fullscreen only the fullscreen element's subtree renders, so a filter
    // defined outside it resolves to nothing.
    const filter = new ToneFilter(document);
    filter.ensure();
    const svg = document.querySelector('svg') as SVGSVGElement;
    expect(svg.parentElement).toBe(document.documentElement);

    const player = document.createElement('div');
    document.body.appendChild(player);
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => player,
    });

    filter.syncFullscreen();
    expect(player.contains(svg)).toBe(true);

    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => null,
    });
    filter.syncFullscreen();
    expect(svg.parentElement).toBe(document.documentElement);
  });

  it('does nothing when there is no filter host yet', () => {
    const filter = new ToneFilter(document);
    expect(() => filter.syncFullscreen()).not.toThrow();
  });
});

describe('teardown and destroy', () => {
  it('leaves no trace in the page but can be rebuilt', () => {
    const filter = new ToneFilter(document);
    filter.ensure();
    filter.teardown();
    expect(document.querySelector('svg')).toBeNull();
    expect(document.getElementById(STYLE_ID)).toBeNull();

    // Turning video processing back on must not need a reload.
    expect(filter.ensure()).toBe(true);
    expect(document.getElementById(FILTER_ID)).not.toBeNull();
  });

  it('refuses to rebuild after destroy', () => {
    const filter = new ToneFilter(document);
    filter.ensure();
    filter.destroy();
    expect(document.querySelector('svg')).toBeNull();
    expect(filter.ensure()).toBe(false);
    expect(filter.getTechnique()).toBe('none');
  });
});
