/**
 * Dark mode: one stylesheet, and the measurement that decides what goes in it.
 *
 * Like `image-engine.ts` this owns no elements and discovers nothing. The whole
 * effect is a rule on `:root` plus, when the page is being inverted, a
 * zero-specificity rule for the media that must not be. Pages added, removed or
 * replaced underneath it are the CSS engine's problem, not this module's, so
 * the only upkeep is repairing a stylesheet a page has deleted and re-checking
 * a verdict that may have gone stale.
 *
 * **The measurement.** "Did the site answer the request for a dark page?" is
 * answered by looking at what colour the canvas ends up, through
 * `getComputedStyle`. That reads *computed* values, which a `filter` does not
 * affect — filters are a paint-time operation — so measuring while our own
 * inversion is applied does not feed back on itself. What the applied
 * `color-scheme` affects is real and wanted: it is exactly the half of the
 * question a page with no background of its own answers.
 *
 * **Every frame runs its own copy**, and that is what makes nesting work. The
 * root filter would otherwise invert an embedded document along with everything
 * else, and a nested player or article would need the parent to know about it.
 * Instead `iframe` is in the counter-inverted set, so a child document arrives
 * at its parent untouched and decides for itself.
 */
import type { PageStatus } from '../core/types';
import {
  EMPTY_PAGE_PLAN,
  pageStyleCss,
  planPage,
  canvasLuminance,
  needsInversion,
  type PagePlan,
} from '../core/page';

/**
 * Repair and re-measure interval, matching the image engine's. A page's
 * background does change — an SPA route change, a theme switcher, a stylesheet
 * that loads late — and nothing about it is worth a MutationObserver.
 */
const UPKEEP_INTERVAL_MS = 2000;

const STYLE_ID = 'nn-page-style';

export interface PageEngineStatus extends PageStatus {
  notes: string[];
}

export class PageEngine {
  private readonly doc: Document;
  /** Whether a dark page has been asked for, before the gate is consulted. */
  private wanted = false;
  private enabled = false;
  private styleNode: HTMLStyleElement | null = null;
  private plan: PagePlan = { ...EMPTY_PAGE_PLAN };
  /** Latest verdict; null until a document exists to measure. */
  private invert: boolean | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Set only while waiting for `<body>` to exist; see `watchForBody`. */
  private bodyObserver: MutationObserver | null = null;
  private notes = new Set<string>();
  private destroyed = false;

  constructor(
    doc: Document,
    private readonly onChange: () => void,
  ) {
    this.doc = doc;
    // A document that is still parsing has no body to measure, and the answer
    // usually arrives with it. Both events are cheap and neither is guaranteed
    // to fire after the content script attaches, so the upkeep timer backs them.
    this.doc.addEventListener('DOMContentLoaded', this.onDocumentEvent, { once: true });
    this.doc.defaultView?.addEventListener('load', this.onDocumentEvent, { once: true });
  }

  setDarkMode(wanted: boolean, enabled: boolean): void {
    if (this.destroyed) return;
    this.wanted = wanted;
    const active = enabled && wanted;
    this.enabled = active;

    if (!active) {
      this.stopLoop();
      this.stopBodyWatch();
      // Leave nothing behind: no stylesheet, and therefore no root filter and no
      // compositing cost on a page that is not being treated.
      this.removeStyle();
      this.plan = { ...EMPTY_PAGE_PLAN };
      this.invert = null;
      this.notes.clear();
      this.onChange();
      return;
    }

    // The polite request goes in before anything is measured, so a page that
    // paints no background of its own is dark from the first frame rather than
    // flashing white while we work out whether it needed us.
    this.apply();
    this.measure();
    this.startLoop();
    // If that measurement found no body yet, do not just wait for
    // `DOMContentLoaded` — on a document with a lot to parse, that can lag well
    // behind the moment `<body>` itself lands and the page starts painting. See
    // `watchForBody`.
    this.watchForBody();
  }

  getStatus(): PageEngineStatus {
    return {
      active: this.enabled,
      dark: this.enabled ? this.plan.dark : 'off',
      notes: [...this.notes],
    };
  }

  /**
   * Filter functions the media engines must append to their own rules, so the
   * elements they have claimed come back out of the root inversion unchanged.
   */
  getCompensation(): string {
    return this.enabled ? this.plan.compensation : '';
  }

  destroy(): void {
    this.destroyed = true;
    this.enabled = false;
    this.doc.removeEventListener('DOMContentLoaded', this.onDocumentEvent);
    this.doc.defaultView?.removeEventListener('load', this.onDocumentEvent);
    this.stopLoop();
    this.stopBodyWatch();
    this.removeStyle();
  }

  private readonly onDocumentEvent = (): void => {
    if (!this.enabled) return;
    this.measure();
  };

  /**
   * Catch `<body>` the instant it is inserted, rather than at
   * `DOMContentLoaded` (which waits for the *whole* document to finish
   * parsing) or the next upkeep tick (up to `UPKEEP_INTERVAL_MS` away). A
   * render-blocking stylesheet in `<head>` — the common case — has already run
   * by then, so this measurement is usually final; on the rare page whose
   * background arrives even later, `DOMContentLoaded` and the upkeep loop are
   * still there to correct it, same as before this existed.
   */
  private watchForBody(): void {
    if (this.destroyed || this.doc.body || this.bodyObserver) return;
    const root = this.doc.documentElement;
    const view = this.doc.defaultView;
    const Ctor = view?.MutationObserver ?? globalThis.MutationObserver;
    if (!root || !Ctor) return;
    this.bodyObserver = new Ctor(() => {
      if (!this.doc.body) return;
      this.stopBodyWatch();
      this.measure();
      // A body inserted before its own stylesheet finishes loading measures as
      // unstyled; one more pass next frame is the earliest point a style that
      // landed in between is guaranteed to be reflected.
      view?.requestAnimationFrame?.(() => this.measure());
    });
    this.bodyObserver.observe(root, { childList: true });
  }

  private stopBodyWatch(): void {
    this.bodyObserver?.disconnect();
    this.bodyObserver = null;
  }

  private startLoop(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), UPKEEP_INTERVAL_MS);
  }

  private stopLoop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (this.destroyed || !this.enabled) return;
    this.apply();
    this.measure();
  }

  /**
   * Re-read the canvas colour and, if the verdict changed, rebuild.
   *
   * The scheme passed to `canvasLuminance` is the one currently applied rather
   * than the one being asked for, which is what keeps this stable: a page being
   * inverted is running under `color-scheme: light`, and under that scheme an
   * undeclared canvas really is white, so the verdict stays where it is instead
   * of flipping back and forth every two seconds.
   */
  private measure(): void {
    if (this.destroyed || !this.enabled) return;
    const view = this.doc.defaultView;
    const root = this.doc.documentElement;
    if (!view || !root) return;

    // No body yet means nothing has been declared yet, and guessing from an
    // empty document would produce a verdict we would only have to retract.
    const body = this.doc.body;
    if (!body) return;

    let luminance: number;
    try {
      luminance = canvasLuminance(
        view.getComputedStyle(root).backgroundColor,
        view.getComputedStyle(body).backgroundColor,
        this.plan.scheme === 'light' ? 'light' : 'dark',
      );
    } catch {
      // getComputedStyle can throw in a document being torn down.
      return;
    }

    const next = needsInversion(luminance);
    if (this.invert === next) return;
    this.invert = next;
    this.apply();
  }

  /** Rebuild the plan from the current request and verdict, and install it. */
  private apply(): void {
    if (this.destroyed || !this.enabled) return;

    const next = planPage(this.wanted, this.invert);
    const css = pageStyleCss(next);
    const changed =
      next.scheme !== this.plan.scheme ||
      next.rootFilter !== this.plan.rootFilter ||
      next.compensation !== this.plan.compensation ||
      next.dark !== this.plan.dark;
    this.plan = next;

    if (!css) {
      this.removeStyle();
      if (changed) this.onChange();
      return;
    }

    const node = this.ensureStyle();
    if (!node) return;
    if (node.textContent !== css) node.textContent = css;
    if (changed) this.onChange();
  }

  /**
   * The stylesheet, created or repaired. `<head>` is preferred but does not
   * exist yet at `document_start`, and a page can remove an injected node at any
   * time, so both cases fall through to the root element.
   */
  private ensureStyle(): HTMLStyleElement | null {
    if (this.styleNode?.isConnected) return this.styleNode;
    const parent = this.doc.head ?? this.doc.documentElement;
    if (!parent) return null;
    try {
      const node = this.doc.createElement('style');
      node.id = STYLE_ID;
      parent.appendChild(node);
      this.styleNode = node;
      return node;
    } catch {
      return null;
    }
  }

  private removeStyle(): void {
    this.styleNode?.remove();
    this.styleNode = null;
  }
}
