/**
 * Dark mode: everything except touching the DOM.
 *
 * The rest of the picture path treats *content* — a film, a photograph — and
 * takes some care not to change what the author intended. This module treats
 * the page around that content, where the opposite is true: at one in the
 * morning the brightest thing on the screen is usually not the video, it is the
 * white article body behind it. It deliberately changes how a site looks, which
 * is why it is off by default and not implied by the master switch.
 *
 * One effect, in two steps: ask politely first, and measure whether the site
 * answered.
 *
 * ### On asking politely
 *
 * The polite request is `color-scheme: dark` on the root, and it is worth
 * making because it is free and it fixes the parts inversion handles worst:
 * form controls, scrollbars, and the canvas behind a page that paints no
 * background of its own.
 *
 * What it does **not** do is flip `prefers-color-scheme`. That media query
 * reports the *user's* preference, not this property, and an extension with no
 * `debugger` permission cannot change it — so the large majority of sites,
 * which implement their dark theme behind `@media (prefers-color-scheme: dark)`,
 * will not respond to it at all. This was measured in Chrome rather than
 * assumed. Hence the fallback, and hence the fact that the fallback is the path
 * most pages will take.
 *
 * ### On the fallback
 *
 * `invert(1) hue-rotate(180deg)` on the root, undone on media. That pair is an
 * involution: writing `I(x) = 1 − x` and `M` for the hue-rotation matrix,
 * `f(x) = M(1 − x) = 1 − Mx` because `M` fixes white, so `f(f(x)) = x` exactly.
 * A photograph inside an inverted page therefore comes back out exactly as it
 * went in: the counter-filter is not an approximation.
 *
 * Everything here is pure so it can be unit tested; `content/page-engine.ts`
 * owns the stylesheet and the measurement.
 */
import type { PageDarkMode } from './types';
import { clamp, clamp01, round } from './math';
import { toLinearLight } from './tone-curve';

/** Filter functions that invert the page, and undo that inversion on media. */
export const INVERT_FILTER = 'invert(1) hue-rotate(180deg)';

/**
 * Where the inverted page's black point and white point are put.
 *
 * A straight inversion sends a white page to #000000 and its black text to
 * #ffffff, which is the maximum contrast available and more than anyone wants
 * at one in the morning — a pure white glyph on pure black glares and smears.
 * So the inverted output is squeezed into a narrower band: #121212 behind
 * #dbdbdb, which is roughly where Material's dark surface and Dark Reader's
 * default text sit.
 *
 * This costs less legibility than it looks like it should, because the squeeze
 * is *relational*: text and background move together, so contrast ratios are
 * very nearly preserved rather than being traded away. Black on white goes from
 * 21:1 to 13.5:1 — still past WCAG AAA, which wants 7:1 — and mid-contrast text
 * barely moves at all (#666 on white measures 5.74:1 before and 5.48:1 after).
 * `tests/page.test.ts` pins both.
 */
export const DARK_FLOOR = 0.07;
export const DARK_CEILING = 0.86;

/**
 * The squeeze, as CSS filter functions.
 *
 * `contrast()` then `brightness()` compose to the affine map
 * `out = in·(ceiling − floor) + floor`. Solving
 * `b·(c·(x − ½) + ½) = kx + f` for `k = ceiling − floor` gives `b = k + 2f` and
 * `c = k / b`, which is all this is.
 *
 * **Nothing painted inside the filtered root can escape this band, media
 * included, and that is a property of filters rather than a decision.** An
 * element filter would have to emit values outside 0..1 to land outside
 * `[floor, ceiling]` after the root has run, and it cannot — they are clamped.
 * So media is deliberately *not* compensated for this stage: compensating would
 * mean asking for that impossible expansion, which clamps, and clamping costs
 * real picture (everything above 85% of a photograph's range would flatten into
 * one value). Riding the same squeeze instead is a linear scale that loses no
 * detail at all. The cost is a black point lifted to #121212 — the same colour
 * as the page behind it, so a letterboxed video's bars match the page rather
 * than sitting in a darker rectangle.
 */
export function softenFilter(floor = DARK_FLOOR, ceiling = DARK_CEILING): string {
  const span = clamp(ceiling - floor, 0.01, 1);
  const brightness = span + 2 * floor;
  const contrast = span / brightness;
  return `contrast(${round(contrast, 3)}) brightness(${round(brightness, 3)})`;
}

/** Where an encoded level lands after the inversion and the squeeze. */
export function softenedLevel(
  level: number,
  floor = DARK_FLOOR,
  ceiling = DARK_CEILING,
): number {
  return floor + clamp01(level) * (ceiling - floor);
}

/** WCAG contrast ratio between two relative luminances. */
export function contrastRatio(a: number, b: number): number {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Elements that must not be inverted along with the page.
 *
 * Zero specificity on purpose. The image and video engines write their own
 * `filter` rules for `img` and `video[data-nn-tone="1"]`, and a `filter` is one
 * property — the two rules cannot merge, so one of them has to win outright.
 * `:where()` guarantees it is theirs, and they carry the counter-filter
 * themselves (see `ToneFilter.setExtraFilters`). This rule then covers exactly
 * the media those engines are not currently handling.
 *
 * `iframe` is in the list because every frame runs its own copy of this: a
 * nested document inverts itself if it needs to, so inverting it again from the
 * parent would cancel it back to white. `canvas` and `svg` are deliberately
 * *not* in it — they are far more often a chart or an icon, which should go
 * dark with the page, than a photograph.
 */
export const PAGE_MEDIA_SELECTOR = ':where(img,video,iframe,embed,object)';

/**
 * Canvas luminance at or below which a page counts as already dark, so the
 * inversion is not needed. Chrome's own dark canvas (#121212) sits at 0.006 and
 * GitHub's dark background at 0.007; a mid grey is 0.216 and would still be
 * inverted, which is the right answer for a page that is genuinely mid grey.
 */
export const PAGE_DARK_MAX_LUMA = 0.18;

/** The colour Chrome paints behind a page that declares no background itself. */
const UA_CANVAS = {
  light: { r: 255, g: 255, b: 255, a: 1 },
  dark: { r: 18, g: 18, b: 18, a: 1 },
} as const;

export type PageColorScheme = 'light' | 'dark';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

/* ------------------------------- colour ---------------------------------- */

/**
 * Parse the subset of CSS colour syntax `getComputedStyle` actually produces.
 *
 * CSSOM serialises a resolved colour as `rgb(r, g, b)` or `rgba(r, g, b, a)`,
 * so that is what this handles, plus the space-and-slash form for safety.
 * Anything else (a `color()` in a wide gamut, a keyword that slipped through)
 * returns null, which callers treat as "unknown" rather than guessing.
 */
export function parseCssColor(value: string): Rgba | null {
  const text = (value ?? '').trim().toLowerCase();
  if (!text) return null;
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  const match = /^rgba?\(([^)]*)\)$/.exec(text);
  if (!match) return null;
  const parts = (match[1] ?? '').split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;

  const channel = (raw: string, scale: number): number | null => {
    const percent = raw.endsWith('%');
    const numeric = Number.parseFloat(percent ? raw.slice(0, -1) : raw);
    if (!Number.isFinite(numeric)) return null;
    return clamp(percent ? (numeric / 100) * scale : numeric, 0, scale);
  };

  const r = channel(parts[0] as string, 255);
  const g = channel(parts[1] as string, 255);
  const b = channel(parts[2] as string, 255);
  if (r === null || g === null || b === null) return null;
  const a = parts.length > 3 ? channel(parts[3] as string, 1) : 1;
  return { r, g, b, a: a ?? 1 };
}

/** Source-over composite of a possibly translucent colour onto an opaque one. */
function over(top: Rgba, base: Rgba): Rgba {
  const a = clamp(top.a, 0, 1);
  return {
    r: top.r * a + base.r * (1 - a),
    g: top.g * a + base.g * (1 - a),
    b: top.b * a + base.b * (1 - a),
    a: 1,
  };
}

/**
 * Relative luminance, 0..1, measured in *linear* light for the same reason the
 * video engine measures scenes that way: how bright something looks to the eye
 * is not the average of its encoded channel values.
 */
export function relativeLuminance(colour: Rgba): number {
  const r = toLinearLight(colour.r / 255);
  const g = toLinearLight(colour.g / 255);
  const b = toLinearLight(colour.b / 255);
  return clamp(0.2126 * r + 0.7152 * g + 0.0722 * b, 0, 1);
}

/**
 * Luminance of the page canvas, from the two computed background colours that
 * can produce it.
 *
 * The root element's background paints the canvas; when it has none, the body's
 * is propagated to the canvas instead, which is why they are checked in that
 * order and why the first one that paints anything wins. When neither paints,
 * the canvas is Chrome's own, and *that* is where the polite request pays off:
 * under `color-scheme: dark` it is already near black, so a page that declares
 * no background of its own needs no inversion at all.
 *
 * Passing the scheme in rather than assuming one is what keeps re-measurement
 * stable. Once a page is being inverted the applied scheme is `light` (so that
 * form controls render light and inversion turns them dark), and under that
 * scheme an empty canvas is white — which is the truth, and which keeps the
 * verdict where it was instead of oscillating.
 */
export function canvasLuminance(
  rootBackground: string,
  bodyBackground: string,
  scheme: PageColorScheme,
): number {
  const base = UA_CANVAS[scheme];
  for (const declared of [rootBackground, bodyBackground]) {
    const colour = parseCssColor(declared);
    if (!colour || colour.a <= 0) continue;
    return relativeLuminance(over(colour, base));
  }
  return relativeLuminance(base);
}

/** Whether a page at this canvas luminance still needs taking apart. */
export function needsInversion(luminance: number): boolean {
  return luminance > PAGE_DARK_MAX_LUMA;
}

/* -------------------------------- the plan -------------------------------- */

/**
 * Everything `content/page-engine.ts` has to install, decided here so it can be
 * asserted against without a DOM.
 */
export interface PagePlan {
  /** `color-scheme` to force on the root; empty means leave it alone. */
  scheme: '' | PageColorScheme;
  /** Value for the root element's `filter`; empty means do not set one. */
  rootFilter: string;
  /**
   * Filter functions media must carry to come back out the other side of the
   * root filter unchanged. Empty unless the page is being inverted.
   */
  compensation: string;
  /** What the popup should say happened. */
  dark: PageDarkMode;
}

export const EMPTY_PAGE_PLAN: Readonly<PagePlan> = Object.freeze({
  scheme: '',
  rootFilter: '',
  compensation: '',
  dark: 'off',
});

/**
 * Turn the setting plus a measurement into the plan.
 *
 * @param dark    Whether a dark page has been asked for. Off means nothing at
 *                all is installed: no stylesheet, no root filter, no
 *                compositing cost on a page that is not being treated.
 * @param invert  What the measurement said. `null` means the page has not been
 *                measured yet, which at `document_start` is the normal state
 *                for the first frames of a document's life: the polite request
 *                goes in immediately (so an empty canvas is dark from the very
 *                first paint) and the inversion waits for an answer.
 */
export function planPage(dark: boolean, invert: boolean | null): PagePlan {
  if (!dark) return { ...EMPTY_PAGE_PLAN };

  if (invert === null) {
    return { scheme: 'dark', rootFilter: '', compensation: '', dark: 'pending' };
  }

  if (!invert) {
    return { scheme: 'dark', rootFilter: '', compensation: '', dark: 'scheme' };
  }

  return {
    // `light`, not `dark`: the UA widgets are about to be inverted, so they have
    // to be drawn light in order to end up dark. Asking for a dark scheme here
    // is the one thing that would make a form control glow on a black page.
    scheme: 'light',
    // The squeeze goes last, because it has to be the final word on how bright
    // anything gets.
    rootFilter: `${INVERT_FILTER} ${softenFilter()}`,
    // The inversion is undone on media; the squeeze deliberately is not. See
    // `softenFilter`.
    compensation: INVERT_FILTER,
    dark: 'invert',
  };
}

/**
 * The stylesheet for a plan. Empty when there is nothing to install.
 *
 * The two `:fullscreen` rules are not an edge case, they are the difference
 * between this feature working and this feature ruining the thing the extension
 * exists for. **A fullscreen element is in the top layer, and the top layer is
 * not painted through its ancestors' filters** — but it *is* painted through
 * its own. So a fullscreen `<video>` would keep the counter-inversion with no
 * root inversion left to cancel it, and render as a photographic negative.
 * Verified in Chrome, which drops the root filter for a top-layer element while
 * still honouring a filter on the element itself.
 *
 * Hence: media in the top layer drops the compensation, and a non-media element
 * in the top layer takes over the root filter's job for its own subtree, so
 * fullscreening a slideshow does not flash the page back to white.
 */
export function pageStyleCss(plan: PagePlan): string {
  const root: string[] = [];
  if (plan.scheme) root.push(`color-scheme:${plan.scheme} !important`);
  if (plan.rootFilter) root.push(`filter:${plan.rootFilter} !important`);
  if (root.length === 0) return '';

  const rules = [`:root{${root.join(';')};}`];

  if (plan.compensation) {
    rules.push(`${PAGE_MEDIA_SELECTOR}{filter:${plan.compensation} !important;}`);
    // Beats the rule above on specificity (a pseudo-class against `:where()`'s
    // zero), and loses to the image and video engines' own `:fullscreen` rules,
    // which keep their tone curve and drop only the compensation.
    rules.push(`${PAGE_MEDIA_SELECTOR}:fullscreen{filter:none !important;}`);
  }

  if (plan.rootFilter) {
    // `html` and `body` are excluded because Chrome matches them as part of the
    // fullscreen stack: re-applying the filter to `:root` is harmless (same
    // value, and `filter` does not stack across rules) but putting one on
    // `body` would make it a containing block for fixed descendants, which the
    // root is specifically exempt from.
    rules.push(
      `:fullscreen:not(:where(html,body,img,video,iframe,embed,object))` +
        `{filter:${plan.rootFilter} !important;}`,
    );
  }

  return rules.join('');
}

/**
 * The line under the dark-mode switch in the popup.
 *
 * It exists because this is the one control in the picture group whose effect a
 * setting cannot tell you: "Dark mode" on its own does not distinguish a site
 * that had a dark theme of its own from one that is being taken apart and
 * rebuilt, and those two do not look alike or fail alike. Only rendered while
 * the switch is on, so a popup that never asked for it pays nothing.
 *
 * @param dark  What the active tab reported back. `'off'` while a dark page is
 *              being asked for means the gate is closed — the extension is
 *              switched off, the site is skipped, or it is not night yet.
 */
export function describePageEffect(dark: PageDarkMode): string {
  switch (dark) {
    case 'scheme':
      return "Using this site's own dark theme.";
    case 'invert':
      return 'No dark theme here, so inverting.';
    case 'pending':
      return 'Checking for a dark theme…';
    default:
      return 'Dark mode on, nothing running here.';
  }
}
