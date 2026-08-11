// @vitest-environment jsdom
/**
 * The page engine is the riskiest module in this extension, because it is the
 * only one whose failure mode is "every site looks wrong". Three things are
 * worth pinning here and expensive to notice in the wild:
 *
 *  - it must leave *nothing* behind when switched off, or a page keeps a root
 *    `filter` and an inverted document after the extension is turned off;
 *  - it must not invert a page that is already dark, which is the whole reason
 *    the polite request exists;
 *  - the verdict must not oscillate. Re-measurement happens under a different
 *    colour scheme from the first measurement, and a verdict that flips every
 *    two seconds would strobe the document.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageEngine } from '../src/content/page-engine';
import { INVERT_FILTER } from '../src/core/page';

const STYLE_ID = 'nn-page-style';
const UPKEEP_MS = 2000;

function css(): string {
  return document.getElementById(STYLE_ID)?.textContent ?? '';
}

/** Paint the page the way a site would, through the two backgrounds that reach the canvas. */
function paint(root: string, body = ''): void {
  document.documentElement.style.backgroundColor = root;
  document.body.style.backgroundColor = body;
}

let engine: PageEngine;
let changes: number;

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  paint('', '');
  vi.useFakeTimers();
  changes = 0;
  engine = new PageEngine(document, () => {
    changes++;
  });
});

afterEach(() => {
  engine.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('setDarkMode', () => {
  it('installs nothing while the switch is off', () => {
    engine.setDarkMode(false, true);
    expect(document.getElementById(STYLE_ID)).toBeNull();
    expect(engine.getStatus().active).toBe(false);
  });

  it('installs nothing while the gate is closed', () => {
    engine.setDarkMode(true, false);
    expect(document.getElementById(STYLE_ID)).toBeNull();
    expect(engine.getStatus().dark).toBe('off');
  });

  it('removes everything again when switched off', () => {
    paint('rgb(255, 255, 255)');
    engine.setDarkMode(true, true);
    expect(document.getElementById(STYLE_ID)).not.toBeNull();

    engine.setDarkMode(false, true);
    expect(document.getElementById(STYLE_ID)).toBeNull();
    expect(engine.getCompensation()).toBe('');
    expect(engine.getStatus().dark).toBe('off');
  });
});

describe('the dark verdict', () => {
  it('leaves a page that is already dark to its own presentation', () => {
    paint('rgb(13, 17, 23)');
    engine.setDarkMode(true, true);

    expect(engine.getStatus().dark).toBe('scheme');
    expect(css()).toBe(':root{color-scheme:dark !important;}');
    expect(css()).not.toContain('invert');
    expect(engine.getCompensation()).toBe('');
  });

  it('inverts a page that stayed light', () => {
    paint('rgb(255, 255, 255)');
    engine.setDarkMode(true, true);

    expect(engine.getStatus().dark).toBe('invert');
    expect(css()).toContain(`filter:${INVERT_FILTER} !important`);
    expect(css()).toContain('color-scheme:light !important');
    expect(engine.getCompensation()).toBe(INVERT_FILTER);
  });

  it('reads the body background when the root paints nothing', () => {
    paint('', 'rgb(255, 255, 255)');
    engine.setDarkMode(true, true);
    expect(engine.getStatus().dark).toBe('invert');
  });

  it('treats an undeclared canvas as answered, because the scheme darkens it', () => {
    paint('', '');
    engine.setDarkMode(true, true);
    expect(engine.getStatus().dark).toBe('scheme');
    expect(css()).not.toContain('invert');
  });

  it('does not oscillate once it has decided to invert', () => {
    // The re-measurement runs under `color-scheme: light`, which is a different
    // question from the one the first measurement answered. If that difference
    // were not accounted for, this page would flip verdict every upkeep tick.
    paint('rgb(255, 255, 255)');
    engine.setDarkMode(true, true);
    expect(engine.getStatus().dark).toBe('invert');

    const before = css();
    for (let tick = 0; tick < 10; tick++) vi.advanceTimersByTime(UPKEEP_MS);
    expect(engine.getStatus().dark).toBe('invert');
    expect(css()).toBe(before);
  });

  it('does not oscillate on an undeclared canvas either', () => {
    paint('', '');
    engine.setDarkMode(true, true);
    for (let tick = 0; tick < 10; tick++) vi.advanceTimersByTime(UPKEEP_MS);
    expect(engine.getStatus().dark).toBe('scheme');
  });

  it('follows a page that changes its background later', () => {
    // An SPA route change, a theme switcher, a stylesheet that loads late.
    paint('rgb(13, 17, 23)');
    engine.setDarkMode(true, true);
    expect(engine.getStatus().dark).toBe('scheme');

    paint('rgb(255, 255, 255)');
    vi.advanceTimersByTime(UPKEEP_MS);
    expect(engine.getStatus().dark).toBe('invert');
    expect(engine.getCompensation()).toBe(INVERT_FILTER);
  });

  it('reports the change so the media engines can be told', () => {
    paint('rgb(13, 17, 23)');
    engine.setDarkMode(true, true);
    const seen = changes;

    paint('rgb(255, 255, 255)');
    vi.advanceTimersByTime(UPKEEP_MS);
    // The image and video engines own `filter` on the elements that must not be
    // inverted, so a verdict they are not told about is a page full of negatives.
    expect(changes).toBeGreaterThan(seen);
  });
});

describe('what media carries', () => {
  it('gives media back its polarity, but not the squeeze', () => {
    paint('rgb(255, 255, 255)');
    engine.setDarkMode(true, true);
    const compensation = engine.getCompensation();
    expect(compensation).toBe(INVERT_FILTER);
    // Compensating for the squeeze would need an element filter to emit values
    // outside 0..1, which clamps and costs picture. See `softenFilter`.
    expect(compensation).not.toContain('contrast');
  });

  it('softens the inverted page off pure black and pure white', () => {
    paint('rgb(255, 255, 255)');
    engine.setDarkMode(true, true);
    expect(css()).toContain('contrast(');
    expect(css()).toContain('brightness(');
  });
});

describe('upkeep', () => {
  it('puts the stylesheet back if the page removes it', () => {
    paint('rgb(255, 255, 255)');
    engine.setDarkMode(true, true);
    const before = css();

    document.getElementById(STYLE_ID)?.remove();
    expect(document.getElementById(STYLE_ID)).toBeNull();

    vi.advanceTimersByTime(UPKEEP_MS);
    expect(css()).toBe(before);
  });

  it('stops its timer once switched off', () => {
    paint('rgb(255, 255, 255)');
    engine.setDarkMode(true, true);
    engine.setDarkMode(false, true);

    vi.advanceTimersByTime(UPKEEP_MS * 5);
    expect(document.getElementById(STYLE_ID)).toBeNull();
  });
});

describe('destroy', () => {
  it('leaves the page exactly as it found it', () => {
    paint('rgb(255, 255, 255)');
    engine.setDarkMode(true, true);
    expect(document.getElementById(STYLE_ID)).not.toBeNull();

    engine.destroy();
    expect(document.getElementById(STYLE_ID)).toBeNull();
    expect(engine.getCompensation()).toBe('');
  });

  it('ignores a request after being destroyed', () => {
    engine.destroy();
    engine.setDarkMode(true, true);
    expect(document.getElementById(STYLE_ID)).toBeNull();
  });
});
