/**
 * The rendering half of the video effect.
 *
 * Chosen technique: an SVG `feComponentTransfer` filter referenced from CSS.
 *
 *   <filter color-interpolation-filters="sRGB">
 *     <feComponentTransfer>            per-channel tone curve (33-entry LUT)
 *     <feColorMatrix type="saturate">  colour compensation
 *
 * Why this and not a canvas/WebGL overlay:
 *  - it is a real per-pixel transfer function, applied by the compositor on the
 *    GPU, so the CPU cost of the *effect* is zero regardless of resolution;
 *  - it does not touch the page's DOM structure, so player controls, subtitle
 *    overlays, fullscreen and aspect-ratio handling all keep working;
 *  - it also applies to protected (EME/DRM) video, which a canvas pipeline
 *    cannot legally or technically read.
 *
 * The adaptive part lives in `video-engine.ts`: it measures frame luminance and
 * rewrites the LUT, so the curve tracks the content. Updating `tableValues` is
 * a single attribute write.
 */
import { warn } from '../core/log';

export const TONE_ATTRIBUTE = 'data-nn-tone';
const FILTER_ID = 'nn-tone-curve';
const STYLE_ID = 'nn-tone-style';
const SVG_NS = 'http://www.w3.org/2000/svg';

export type ToneTechnique = 'svg-tone-curve' | 'css-basic' | 'none';

export class ToneFilter {
  private readonly doc: Document;
  private svgHost: SVGSVGElement | null = null;
  private funcs: Element[] = [];
  private saturateNode: Element | null = null;
  private styleNode: HTMLStyleElement | null = null;
  private technique: ToneTechnique = 'none';
  private lastTable = '';
  private lastSaturation = -1;
  private lastRule = '';
  private lastHref = '';
  private fallbackCss = 'none';
  private destroyed = false;

  constructor(doc: Document = document) {
    this.doc = doc;
  }

  getTechnique(): ToneTechnique {
    return this.technique;
  }

  private supportsSvgFilters(): boolean {
    try {
      const view = this.doc.defaultView as (Window & { CSS?: typeof CSS }) | null;
      if (!view?.CSS?.supports) return true; // assume yes, the fallback is only for exotic engines
      return view.CSS.supports('filter', 'url("#a")');
    } catch {
      return true;
    }
  }

  /** Create (or repair) the filter definition and stylesheet. */
  ensure(): boolean {
    if (this.destroyed) return false;
    const parent = this.doc.documentElement ?? this.doc.body;
    if (!parent) return false;

    if (this.technique === 'none') {
      this.technique = this.supportsSvgFilters() ? 'svg-tone-curve' : 'css-basic';
    }

    if (this.technique === 'svg-tone-curve' && (!this.svgHost || !this.svgHost.isConnected)) {
      if (!this.buildSvg(parent)) return false;
    }

    if (!this.styleNode || !this.styleNode.isConnected) {
      this.styleNode = this.doc.createElement('style');
      this.styleNode.id = STYLE_ID;
      (this.doc.head ?? parent).appendChild(this.styleNode);
      this.lastRule = '';
      this.writeRule();
    }

    return true;
  }

  private buildSvg(parent: Element): boolean {
    try {
      const svg = this.doc.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.setAttribute(
        'style',
        'position:absolute!important;width:0!important;height:0!important;overflow:hidden!important;pointer-events:none!important;opacity:0!important;left:-9999px!important;top:0!important;',
      );

      const defs = this.doc.createElementNS(SVG_NS, 'defs');
      const filter = this.doc.createElementNS(SVG_NS, 'filter');
      filter.setAttribute('id', FILTER_ID);
      // sRGB is essential: the default linearRGB space would shift colours.
      filter.setAttribute('color-interpolation-filters', 'sRGB');
      filter.setAttribute('x', '0%');
      filter.setAttribute('y', '0%');
      filter.setAttribute('width', '100%');
      filter.setAttribute('height', '100%');

      const transfer = this.doc.createElementNS(SVG_NS, 'feComponentTransfer');
      this.funcs = ['feFuncR', 'feFuncG', 'feFuncB'].map((name) => {
        const func = this.doc.createElementNS(SVG_NS, name);
        func.setAttribute('type', 'table');
        func.setAttribute('tableValues', '0 1');
        transfer.appendChild(func);
        return func;
      });

      const saturate = this.doc.createElementNS(SVG_NS, 'feColorMatrix');
      saturate.setAttribute('type', 'saturate');
      saturate.setAttribute('values', '1');
      this.saturateNode = saturate;

      filter.appendChild(transfer);
      filter.appendChild(saturate);
      defs.appendChild(filter);
      svg.appendChild(defs);
      parent.appendChild(svg);

      this.svgHost = svg;
      this.lastTable = '';
      this.lastSaturation = -1;
      return true;
    } catch (error) {
      warn('SVG filter unavailable, falling back to basic CSS filters', error);
      this.technique = 'css-basic';
      this.svgHost = null;
      this.funcs = [];
      this.saturateNode = null;
      return true;
    }
  }

  /**
   * `url(#id)` resolves against the document base URI. A page with
   * `<base href>` would send the reference to another document and silently
   * kill the filter, so in that case we spell out the absolute document URL.
   */
  private filterReference(): string {
    if (!this.doc.querySelector('base[href]')) return `url("#${FILTER_ID}")`;
    const href = this.doc.defaultView?.location?.href ?? '';
    const base = href.split('#')[0] ?? '';
    if (!base) return `url("#${FILTER_ID}")`;
    return `url("${base.replace(/"/g, '%22')}#${FILTER_ID}")`;
  }

  private writeRule(): void {
    if (!this.styleNode) return;
    const value =
      this.technique === 'svg-tone-curve' ? this.filterReference() : this.fallbackCss;
    const rule = `video[${TONE_ATTRIBUTE}="1"]{filter:${value} !important;}`;
    if (rule === this.lastRule) return;
    this.lastRule = rule;
    this.styleNode.textContent = rule;
  }

  /** Push a new lookup table (values in 0..1, monotonic). */
  setCurve(tableValues: string, saturation: number): void {
    if (this.destroyed || !this.ensure()) return;

    if (this.technique === 'svg-tone-curve') {
      if (tableValues !== this.lastTable) {
        this.lastTable = tableValues;
        for (const func of this.funcs) func.setAttribute('tableValues', tableValues);
      }
      const sat = Math.round(saturation * 1000) / 1000;
      if (sat !== this.lastSaturation) {
        this.lastSaturation = sat;
        this.saturateNode?.setAttribute('values', String(sat));
      }
    }

    // Keep the reference fresh: SPA navigation can change the document URL,
    // which matters when the page uses a <base> tag.
    const href = this.doc.defaultView?.location?.href ?? '';
    if (href !== this.lastHref) {
      this.lastHref = href;
      this.writeRule();
    }
  }

  /** Used only when SVG filters are unavailable. */
  setFallbackCss(css: string): void {
    if (this.fallbackCss === css) return;
    this.fallbackCss = css;
    if (this.technique === 'css-basic') this.writeRule();
  }

  /**
   * In fullscreen only the fullscreen element's subtree is rendered. Moving the
   * (zero-sized) SVG host inside it guarantees the filter reference resolves.
   */
  syncFullscreen(): void {
    if (this.destroyed || this.technique !== 'svg-tone-curve') return;
    const svg = this.svgHost;
    if (!svg) return;
    const fullscreen = this.doc.fullscreenElement as Element | null;
    try {
      if (fullscreen && fullscreen !== svg.parentElement && !fullscreen.contains(svg)) {
        fullscreen.appendChild(svg);
      } else if (!fullscreen && svg.parentElement !== this.doc.documentElement) {
        this.doc.documentElement?.appendChild(svg);
      }
    } catch (error) {
      warn('could not reposition filter host for fullscreen', error);
    }
  }

  markVideo(video: HTMLVideoElement): void {
    if (video.getAttribute(TONE_ATTRIBUTE) !== '1') {
      video.setAttribute(TONE_ATTRIBUTE, '1');
    }
  }

  unmarkVideo(video: HTMLVideoElement): void {
    if (video.hasAttribute(TONE_ATTRIBUTE)) video.removeAttribute(TONE_ATTRIBUTE);
  }

  /**
   * Remove the injected nodes but keep the instance usable, so turning video
   * processing off leaves no trace in the page and turning it back on rebuilds
   * on demand. The detected technique is kept: it does not change per page.
   */
  teardown(): void {
    this.svgHost?.remove();
    this.styleNode?.remove();
    this.svgHost = null;
    this.styleNode = null;
    this.funcs = [];
    this.saturateNode = null;
    this.lastTable = '';
    this.lastSaturation = -1;
    this.lastRule = '';
    this.lastHref = '';
  }

  destroy(): void {
    this.destroyed = true;
    this.teardown();
    this.technique = 'none';
  }
}
