/**
 * Still-image tone mapping.
 *
 * The same SVG tone curve the video path uses, applied to `<img>` through a
 * second, independent `ToneFilter` instance. Everything interesting about this
 * module is what it deliberately does *not* do, so:
 *
 * **There is no measurement, and no per-image state.** Drawing a cross-origin
 * image into a canvas taints it, and most pictures on a page are served from a
 * CDN without CORS headers, so their pixels cannot be read at all. Analysing
 * the minority that can be read would tone two photographs sitting side by side
 * differently depending on which host happened to serve them — a worse artefact
 * than treating both the same. `imageAdaptState` therefore builds one fixed
 * curve for the whole document, and it is the half of the tone map that is safe
 * without knowing what it is looking at: exposure down a little, highlights
 * rolled off, shadow lift held at zero so nothing is ever made brighter.
 *
 * **There is no element discovery either.** The rule is a bare `img` selector
 * rather than a marked attribute, which means images added later — infinite
 * scroll, lazy loading, an SPA route change — are covered by the CSS engine at
 * no cost, and this module needs neither a MutationObserver nor a per-element
 * bookkeeping map. The `<video>` path cannot do that because it has to pick a
 * primary element to measure; here there is nothing to measure.
 *
 * What is left is a small amount of upkeep: pages can and do remove injected
 * nodes, and in fullscreen only the fullscreen element's subtree is rendered,
 * so the filter host has to follow it.
 */
import type { VideoParams } from '../core/types';
import {
  buildToneCurve,
  cssApproxFilter,
  curveToTableValues,
  imageAdaptState,
  resolveCurve,
  type AdaptState,
} from '../core/tone-curve';
import { ToneFilter } from './tone-filter';

/**
 * Repair interval. An order of magnitude slower than the video engine's, and it
 * can afford to be: there is nothing to measure here and nothing that has to
 * arrive on a particular frame, so this timer only ever notices that a page has
 * removed our stylesheet.
 */
const UPKEEP_INTERVAL_MS = 2000;

export interface ImageEngineStatus {
  active: boolean;
  /** `<img>` elements in this document, whether or not the filter is on. */
  elements: number;
  notes: string[];
}

export class ImageEngine {
  private readonly doc: Document;
  private readonly filter: ToneFilter;
  private params: VideoParams | null = null;
  private state: AdaptState | null = null;
  private enabled = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private notes = new Set<string>();
  private destroyed = false;

  constructor(
    doc: Document,
    private readonly onStatusChange: () => void,
  ) {
    this.doc = doc;
    this.filter = new ToneFilter(doc, {
      filterId: 'nn-image-tone-curve',
      styleId: 'nn-image-tone-style',
      selector: 'img',
    });
    this.doc.addEventListener('fullscreenchange', this.onFullscreenChange, true);
  }

  setParams(params: VideoParams, enabled: boolean): void {
    if (this.destroyed) return;
    this.params = params;
    const active = enabled && !params.bypass;
    this.enabled = active;

    if (!active) {
      this.stopLoop();
      // Leave nothing behind while switched off: no stylesheet, no filter node.
      this.filter.teardown();
      this.state = null;
      this.notes.clear();
      this.onStatusChange();
      return;
    }

    this.state = imageAdaptState(params);
    this.filter.ensure();
    this.pushCurve();
    this.startLoop();
    this.onStatusChange();
  }

  /**
   * Filter functions to carry after the image curve. The page treatment's root
   * inversion has to be undone on `<img>`, and since `filter` is one property
   * this rule is the only one that can do it. See `core/page.ts`.
   */
  setPageCompensation(css: string): void {
    this.filter.setExtraFilters(css);
  }

  getStatus(): ImageEngineStatus {
    return {
      active: this.enabled,
      // A live HTMLCollection: reading its length is cheap, and it is the only
      // number the popup wants — the filter itself is applied by selector, so
      // this module never holds a reference to an image.
      elements: this.doc.images?.length ?? 0,
      notes: [...this.notes],
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.enabled = false;
    this.doc.removeEventListener('fullscreenchange', this.onFullscreenChange, true);
    this.stopLoop();
    this.filter.destroy();
  }

  private readonly onFullscreenChange = (): void => {
    if (!this.enabled) return;
    this.filter.syncFullscreen();
  };

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
    this.filter.ensure();
    this.filter.syncFullscreen();
    // Cheap, and the only thing that puts the table back after a page has
    // wiped the filter definition: `setCurve` rewrites nothing when the node
    // survived and the table is unchanged.
    this.pushCurve();
  }

  private pushCurve(): void {
    if (!this.params || !this.state) return;
    const curve = buildToneCurve(this.params, this.state);
    // Zero by construction while the lift is held at zero, and read from the
    // resolved curve anyway rather than assumed: the saturation compensation
    // pays for flattening, and this curve does not flatten anything.
    const saturation = resolveCurve(this.params, this.state).saturation;
    this.filter.setCurve(curveToTableValues(curve), saturation);
    if (this.filter.getTechnique() === 'css-basic') {
      this.filter.setFallbackCss(cssApproxFilter(this.params, this.state));
      this.note('SVG filters unavailable: images use an approximate CSS curve.');
    }
  }

  private note(text: string): void {
    if (this.notes.has(text)) return;
    this.notes.add(text);
    this.onStatusChange();
  }
}
