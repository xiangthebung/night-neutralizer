/**
 * Dark mode's maths and the CSS it produces.
 *
 * Two properties matter more than any individual number here. The first is that
 * the counter-filter is exact: a photograph inside an inverted page has to come
 * back out exactly as it went in, or every picture on the web goes slightly
 * wrong in a way that is very hard to see and impossible to unsee. The second
 * is that the measurement is *stable* — a page being inverted is measured under
 * a different colour scheme from one that is not, and a verdict that flips
 * every two seconds would strobe the whole document.
 */
import { describe, expect, it } from 'vitest';
import {
  DARK_CEILING,
  DARK_FLOOR,
  INVERT_FILTER,
  PAGE_DARK_MAX_LUMA,
  PAGE_MEDIA_SELECTOR,
  canvasLuminance,
  contrastRatio,
  describePageEffect,
  needsInversion,
  pageStyleCss,
  parseCssColor,
  planPage,
  relativeLuminance,
  softenFilter,
  softenedLevel,
  type Rgba,
} from '../src/core/page';

/** An encoded 0..1 grey as a colour, for luminance assertions. */
function level255(level: number): Rgba {
  const channel = level * 255;
  return { r: channel, g: channel, b: channel, a: 1 };
}

describe('parseCssColor', () => {
  it('parses what getComputedStyle actually serialises', () => {
    expect(parseCssColor('rgb(255, 255, 255)')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor('rgba(0, 0, 0, 0)')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseCssColor('rgba(13, 17, 23, 0.5)')).toEqual({ r: 13, g: 17, b: 23, a: 0.5 });
  });

  it('accepts the space-and-slash form and percentages', () => {
    expect(parseCssColor('rgb(255 255 255 / 0.25)')).toEqual({ r: 255, g: 255, b: 255, a: 0.25 });
    expect(parseCssColor('rgb(100%, 0%, 50%)')).toEqual({ r: 255, g: 0, b: 127.5, a: 1 });
  });

  it('treats the transparent keyword as fully transparent black', () => {
    expect(parseCssColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it('returns null rather than guessing at anything else', () => {
    // A wide-gamut colour, a keyword that slipped through, an empty string: the
    // caller falls back to the UA canvas, which is a known quantity.
    expect(parseCssColor('color(display-p3 1 0 0)')).toBeNull();
    expect(parseCssColor('rebeccapurple')).toBeNull();
    expect(parseCssColor('')).toBeNull();
    expect(parseCssColor('rgb(1, 2)')).toBeNull();
  });

  it('clamps out-of-range channels', () => {
    expect(parseCssColor('rgb(300, -20, 0)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });
});

describe('relativeLuminance', () => {
  it('is measured in linear light', () => {
    // Mid grey is 0.216, not 0.5: how bright something looks is not the average
    // of its encoded channel values. Same reasoning as the video engine's.
    expect(relativeLuminance({ r: 128, g: 128, b: 128, a: 1 })).toBeCloseTo(0.216, 2);
    expect(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1, 5);
    expect(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 })).toBeCloseTo(0, 5);
  });
});

describe('canvasLuminance', () => {
  it('uses the root background when it paints one', () => {
    const luma = canvasLuminance('rgb(255, 255, 255)', 'rgb(0, 0, 0)', 'dark');
    expect(luma).toBeCloseTo(1, 3);
  });

  it('falls through to the body when the root paints nothing', () => {
    // Background propagation: an undeclared root lets the body's colour reach
    // the canvas, which is how nearly every site actually paints its page.
    const luma = canvasLuminance('rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)', 'dark');
    expect(luma).toBeCloseTo(1, 3);
  });

  it('is dark when nothing is declared and a dark scheme is applied', () => {
    // This is the polite request paying off: a page with no background of its
    // own is dark on request and needs no inversion at all.
    const luma = canvasLuminance('rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'dark');
    expect(needsInversion(luma)).toBe(false);
  });

  it('is light when nothing is declared and a light scheme is applied', () => {
    // The stability property. A page already being inverted runs under
    // `color-scheme: light`, and under that scheme an empty canvas really is
    // white — so re-measuring keeps the verdict instead of flipping it back.
    const luma = canvasLuminance('rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'light');
    expect(needsInversion(luma)).toBe(true);
  });

  it('composites a translucent background over the canvas beneath it', () => {
    const overDark = canvasLuminance('rgba(255, 255, 255, 0.5)', 'transparent', 'dark');
    const overLight = canvasLuminance('rgba(255, 255, 255, 0.5)', 'transparent', 'light');
    expect(overDark).toBeLessThan(overLight);
  });

  it('agrees with real pages about which ones are already dark', () => {
    const dark = (root: string): boolean =>
      !needsInversion(canvasLuminance(root, 'transparent', 'dark'));
    expect(dark('rgb(13, 17, 23)')).toBe(true); // GitHub dark
    expect(dark('rgb(18, 18, 18)')).toBe(true); // Chrome's own dark canvas
    expect(dark('rgb(246, 248, 250)')).toBe(false); // GitHub light
    expect(dark('rgb(255, 255, 255)')).toBe(false);
  });

  it('still inverts a genuinely mid-grey page', () => {
    const luma = canvasLuminance('rgb(128, 128, 128)', 'transparent', 'dark');
    expect(luma).toBeGreaterThan(PAGE_DARK_MAX_LUMA);
    expect(needsInversion(luma)).toBe(true);
  });
});

describe('planPage', () => {
  it('plans nothing at all when dark mode is off', () => {
    const plan = planPage(false, null);
    expect(plan).toEqual({ scheme: '', rootFilter: '', compensation: '', dark: 'off' });
    expect(pageStyleCss(plan)).toBe('');
  });

  it('plans nothing even once a light page has been measured', () => {
    // The measurement outlives a switch being turned off, and must not resurrect
    // the treatment on its own.
    expect(pageStyleCss(planPage(false, true))).toBe('');
  });

  it('asks politely first, before anything has been measured', () => {
    const plan = planPage(true, null);
    expect(plan.scheme).toBe('dark');
    expect(plan.rootFilter).toBe('');
    expect(plan.dark).toBe('pending');
  });

  it('stops at the polite request when the page answered it', () => {
    const plan = planPage(true, false);
    expect(plan.scheme).toBe('dark');
    expect(plan.rootFilter).toBe('');
    expect(plan.compensation).toBe('');
    expect(plan.dark).toBe('scheme');
  });

  it('inverts, and asks for a light scheme, when the page stayed light', () => {
    const plan = planPage(true, true);
    // `light`, not `dark`: the UA widgets are about to be inverted, so they have
    // to be drawn light in order to come out dark. Asking for dark here is the
    // one thing that makes a form control glow on a black page.
    expect(plan.scheme).toBe('light');
    expect(plan.rootFilter).toBe(`${INVERT_FILTER} ${softenFilter()}`);
    expect(plan.compensation).toBe(INVERT_FILTER);
    expect(plan.dark).toBe('invert');
  });

  it('undoes the inversion on media exactly, so photographs survive it', () => {
    // `invert(1) hue-rotate(180deg)` is an involution, so the counter-filter is
    // the same string rather than an approximation of one.
    const plan = planPage(true, true);
    expect(plan.compensation).toBe(INVERT_FILTER);
    expect(plan.rootFilter.startsWith(plan.compensation)).toBe(true);
  });

  it('does not compensate media for the squeeze, only for the inversion', () => {
    // Compensating would mean asking an element filter to emit values outside
    // 0..1, which clamps — and clamping costs real picture. Riding the same
    // squeeze is a linear scale that loses no detail. See `softenFilter`.
    const plan = planPage(true, true);
    expect(plan.compensation).toContain(INVERT_FILTER);
    expect(plan.compensation).not.toContain('contrast');
    expect(plan.compensation).not.toContain('brightness');
  });
});

describe('softening the inversion', () => {
  it('puts the background at a slight grey rather than pure black', () => {
    const background = softenedLevel(0);
    expect(background).toBeCloseTo(DARK_FLOOR, 5);
    expect(Math.round(background * 255)).toBe(18); // #121212
  });

  it('puts the text below pure white', () => {
    const text = softenedLevel(1);
    expect(text).toBeCloseTo(DARK_CEILING, 5);
    expect(Math.round(text * 255)).toBe(219); // #dbdbdb
  });

  it('is what the CSS actually computes, not a parallel model', () => {
    // `contrast(c) brightness(b)` is `b·(c·(x − ½) + ½)`. If this drifts from
    // `softenedLevel` the documented colours stop being the rendered ones.
    const [, c, b] = /contrast\(([\d.]+)\) brightness\(([\d.]+)\)/.exec(softenFilter()) ?? [];
    const apply = (x: number): number => Number(b) * (Number(c) * (x - 0.5) + 0.5);
    for (const level of [0, 0.25, 0.5, 0.75, 1]) {
      expect(apply(level)).toBeCloseTo(softenedLevel(level), 3);
    }
  });

  it('keeps black-on-white past WCAG AAA after inverting', () => {
    // A straight inversion gives 21:1, which is more glare than anyone wants at
    // 1 a.m. The squeeze trades some of it back; AAA wants 7:1 for body text.
    const background = relativeLuminance(level255(softenedLevel(0)));
    const text = relativeLuminance(level255(softenedLevel(1)));
    const ratio = contrastRatio(background, text);
    expect(ratio).toBeGreaterThan(13);
    expect(ratio).toBeLessThan(14);
  });

  it('barely moves mid-contrast text, because the squeeze is relational', () => {
    // The reason this is safe: text and background are squeezed together, so
    // the *ratio* between them is very nearly preserved. #666 on #fff is
    // 5.74:1 before; it must not fall off a cliff after.
    const before = contrastRatio(
      relativeLuminance({ r: 0x66, g: 0x66, b: 0x66, a: 1 }),
      relativeLuminance({ r: 255, g: 255, b: 255, a: 1 }),
    );
    const after = contrastRatio(
      relativeLuminance(level255(softenedLevel(1 - 0x66 / 255))),
      relativeLuminance(level255(softenedLevel(0))),
    );
    expect(before).toBeCloseTo(5.74, 1);
    expect(after).toBeGreaterThan(before * 0.9);
  });

  it('never inverts the ordering, so nothing can become invisible', () => {
    // Contrast can be reduced; it must never be reduced to nothing, and two
    // levels that differed must still differ in the same direction.
    let previous = -1;
    for (let step = 0; step <= 100; step++) {
      const value = softenedLevel(step / 100);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });
});

describe('pageStyleCss', () => {
  it('writes one root rule and no media rule when not inverting', () => {
    const css = pageStyleCss(planPage(true, false));
    expect(css).toBe(':root{color-scheme:dark !important;}');
    expect(css).not.toContain(PAGE_MEDIA_SELECTOR);
  });

  it('adds a zero-specificity media rule when inverting', () => {
    const css = pageStyleCss(planPage(true, true));
    expect(css).toContain(
      `:root{color-scheme:light !important;filter:${INVERT_FILTER} ${softenFilter()} !important;}`,
    );
    expect(css).toContain(`${PAGE_MEDIA_SELECTOR}{filter:${INVERT_FILTER} !important;}`);
  });

  it('keeps the media rule at zero specificity', () => {
    // `filter` is one property, so the image and video engines' own rules have
    // to win outright — they carry the counter-filter themselves. `:where()` is
    // what guarantees they do.
    expect(PAGE_MEDIA_SELECTOR.startsWith(':where(')).toBe(true);
  });

  it('leaves iframes to invert themselves', () => {
    // Every frame runs its own copy of the engine, so a nested document that
    // needs inverting does it itself. Inverting it from the parent as well would
    // cancel back to white.
    expect(PAGE_MEDIA_SELECTOR).toContain('iframe');
  });

  it('does not counter-invert canvas or svg', () => {
    // Far more often a chart or an icon, which should go dark with the page,
    // than a photograph.
    expect(PAGE_MEDIA_SELECTOR).not.toContain('canvas');
    expect(PAGE_MEDIA_SELECTOR).not.toContain('svg');
  });

  it('marks everything important, so a page cannot style its way out', () => {
    const css = pageStyleCss(planPage(true, true));
    // color-scheme, root filter, the media rule, the fullscreen media reset and
    // the fullscreen root stand-in.
    expect(css.match(/!important/g)?.length).toBe(5);
  });
});

describe('the top layer', () => {
  /*
   * A fullscreen element is in the top layer, which is not painted through its
   * ancestors' filters but *is* painted through its own. Verified in Chrome.
   * Without these two rules a fullscreen video keeps the counter-inversion with
   * no root inversion left to cancel it, and renders as a negative — which is
   * the single worst thing this feature could do to a video extension.
   */
  const inverting = pageStyleCss(planPage(true, true));

  it('drops the compensation from media that is fullscreen', () => {
    expect(inverting).toContain(`${PAGE_MEDIA_SELECTOR}:fullscreen{filter:none !important;}`);
  });

  it('hands the root filter to a fullscreen element that is not media', () => {
    // Otherwise fullscreening a slideshow flashes the page back to white.
    expect(inverting).toContain(
      ':fullscreen:not(:where(html,body,img,video,iframe,embed,object))',
    );
  });

  it('keeps html and body out of the stand-in rule', () => {
    // Chrome matches them as part of the fullscreen stack. Re-filtering :root is
    // harmless, but a filter on `body` would make it a containing block for
    // fixed descendants — the exemption only covers the root element.
    const standIn = /:fullscreen:not\(:where\(([^)]*)\)\)/.exec(inverting)?.[1] ?? '';
    expect(standIn).toContain('html');
    expect(standIn).toContain('body');
  });

  it('writes no fullscreen rules when there is nothing to undo', () => {
    const css = pageStyleCss(planPage(true, false));
    expect(css).not.toContain(':fullscreen');
  });
});

describe('describePageEffect', () => {
  it('distinguishes the two dark-mode paths, because they do not look alike', () => {
    expect(describePageEffect('scheme')).toContain("site's own");
    expect(describePageEffect('invert')).toContain('inverting');
    expect(describePageEffect('scheme')).not.toContain('inverting');
  });

  it('says so while the answer is still being measured', () => {
    expect(describePageEffect('pending')).toContain('Checking');
  });

  it('does not claim to be doing anything while the gate is closed', () => {
    // `off` with the switch on means the extension is paused, the site is
    // skipped, or it is not night yet.
    expect(describePageEffect('off')).toContain('nothing running');
  });

  it('fits one line of the popup column', () => {
    // The note sits in a ~290 px column at 10.5 px: roughly 55 characters. A
    // second line costs 14 px of a height budget that has none to give, so this
    // is a hard limit rather than a preference.
    for (const mode of ['off', 'scheme', 'invert', 'pending'] as const) {
      expect(describePageEffect(mode).length).toBeLessThanOrEqual(55);
    }
  });
});
