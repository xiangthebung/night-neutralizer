/**
 * Media element discovery and lifecycle.
 *
 * Responsibilities:
 *  - find `<video>`/`<audio>` present at injection time, including inside open
 *    shadow roots (custom-element players);
 *  - notice elements added later via MutationObserver (SPA navigation, lazy
 *    players, ad breaks that swap the element);
 *  - never attach twice to the same element;
 *  - detach when an element really leaves the document, with a grace period so
 *    that a re-parented element (very common in single-page players) is not
 *    torn down and rebuilt.
 *
 * The DOM work is isolated from the audio/video engines through the
 * attach/detach callbacks, which keeps this unit testable under jsdom.
 */

import { warn } from '../core/log';

export const MEDIA_SELECTOR = 'video, audio';

export interface MediaRegistryOptions {
  onAttach: (element: HTMLMediaElement) => void;
  onDetach: (element: HTMLMediaElement) => void;
  /** How long a removed element may stay away before teardown. */
  removalGraceMs?: number;
  /** Safety valve for pathological pages. */
  maxShadowRoots?: number;
  /** Above this many mutation candidates we do one full rescan instead. */
  rescanThreshold?: number;
}

function isMediaElement(node: Node): node is HTMLMediaElement {
  const tag = (node as Element).tagName;
  return tag === 'VIDEO' || tag === 'AUDIO';
}

export class MediaRegistry {
  private readonly options: Required<MediaRegistryOptions>;
  private readonly tracked = new Set<HTMLMediaElement>();
  private readonly observedRoots = new Set<Node>();
  private readonly pendingRemoval = new Map<HTMLMediaElement, ReturnType<typeof setTimeout>>();
  private observer: MutationObserver | null = null;
  private root: Document | null = null;
  private candidates: Node[] = [];
  private flushScheduled = false;
  private needsFullRescan = false;
  private started = false;

  constructor(options: MediaRegistryOptions) {
    this.options = {
      removalGraceMs: 4000,
      maxShadowRoots: 24,
      rescanThreshold: 150,
      ...options,
    };
  }

  get size(): number {
    return this.tracked.size;
  }

  get elements(): HTMLMediaElement[] {
    return [...this.tracked];
  }

  has(element: HTMLMediaElement): boolean {
    return this.tracked.has(element);
  }

  start(root: Document = document): void {
    if (this.started) return;
    this.started = true;
    this.root = root;

    // The observer is created before the first scan so that shadow roots found
    // during the scan can be observed straight away.
    const ObserverCtor =
      (root.defaultView as (Window & typeof globalThis) | null)?.MutationObserver ??
      globalThis.MutationObserver;
    if (ObserverCtor) {
      this.observer = new ObserverCtor((mutations) => this.onMutations(mutations));
      this.observeRoot(root);
    }

    this.scan(root);
  }

  stop(): void {
    this.started = false;
    this.observer?.disconnect();
    this.observer = null;
    this.observedRoots.clear();
    for (const timer of this.pendingRemoval.values()) clearTimeout(timer);
    this.pendingRemoval.clear();
    for (const element of [...this.tracked]) this.forget(element);
    this.candidates = [];
  }

  /** Full sweep. Cheap enough to run on demand (SPA navigation, settings change). */
  scan(node: ParentNode | null = this.root): void {
    if (!node) return;
    const found: HTMLMediaElement[] = [];
    this.collect(node, found, { budget: 8000, shadowRoots: 0 });
    for (const element of found) this.attach(element);
  }

  private observeRoot(node: Node): void {
    if (!this.observer || this.observedRoots.has(node)) return;
    this.observedRoots.add(node);
    this.observer.observe(node, { childList: true, subtree: true });
  }

  private collect(
    node: ParentNode,
    out: HTMLMediaElement[],
    budget: { budget: number; shadowRoots: number },
  ): void {
    if (budget.budget <= 0) return;

    if ((node as Element).tagName && isMediaElement(node as Node)) {
      out.push(node as unknown as HTMLMediaElement);
    }

    let direct: NodeListOf<Element>;
    try {
      direct = node.querySelectorAll(MEDIA_SELECTOR);
    } catch {
      return;
    }
    for (const element of direct) out.push(element as HTMLMediaElement);

    // Open shadow roots: only worth walking when the page actually uses custom
    // elements. `querySelectorAll('*')` is bounded by the budget.
    let all: NodeListOf<Element>;
    try {
      all = node.querySelectorAll('*');
    } catch {
      return;
    }
    budget.budget -= all.length;
    for (const element of all) {
      const shadow = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (!shadow) continue;
      if (budget.shadowRoots >= this.options.maxShadowRoots) break;
      budget.shadowRoots++;
      this.observeRoot(shadow);
      this.collect(shadow, out, budget);
    }
  }

  private onMutations(mutations: MutationRecord[]): void {
    for (const mutation of mutations) {
      if (mutation.type !== 'childList') continue;

      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (this.candidates.length >= this.options.rescanThreshold) {
          this.needsFullRescan = true;
        } else {
          this.candidates.push(node);
        }
      }

      for (const node of mutation.removedNodes) {
        if (node.nodeType !== 1) continue;
        this.handleRemovedSubtree(node as Element);
      }
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // Microtask batching: many small mutations collapse into one pass without
    // adding a frame of latency.
    Promise.resolve().then(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  private flush(): void {
    const candidates = this.candidates;
    this.candidates = [];

    if (this.needsFullRescan) {
      this.needsFullRescan = false;
      this.scan();
      return;
    }

    if (candidates.length === 0) return;
    const found: HTMLMediaElement[] = [];
    const budget = { budget: 4000, shadowRoots: 0 };
    for (const node of candidates) {
      this.collect(node as unknown as ParentNode, found, budget);
    }
    for (const element of found) this.attach(element);
  }

  private handleRemovedSubtree(node: Element): void {
    const candidates: HTMLMediaElement[] = [];
    if (isMediaElement(node)) candidates.push(node as unknown as HTMLMediaElement);
    try {
      for (const element of node.querySelectorAll(MEDIA_SELECTOR)) {
        candidates.push(element as HTMLMediaElement);
      }
    } catch {
      /* detached node without querySelectorAll support */
    }
    for (const element of candidates) {
      if (!this.tracked.has(element)) continue;
      if (this.pendingRemoval.has(element)) continue;
      const timer = setTimeout(() => {
        this.pendingRemoval.delete(element);
        // Re-parented elements are still connected; leave them alone.
        if (element.isConnected) return;
        this.forget(element);
      }, this.options.removalGraceMs);
      this.pendingRemoval.set(element, timer);
    }
  }

  /** Idempotent: repeated calls for the same element are ignored. */
  attach(element: HTMLMediaElement): boolean {
    if (this.tracked.has(element)) {
      const pending = this.pendingRemoval.get(element);
      if (pending) {
        clearTimeout(pending);
        this.pendingRemoval.delete(element);
      }
      return false;
    }
    this.tracked.add(element);
    try {
      this.options.onAttach(element);
    } catch (error) {
      // A failing engine must not stop discovery of other elements.
      reportError(error);
    }
    return true;
  }

  private forget(element: HTMLMediaElement): void {
    if (!this.tracked.delete(element)) return;
    try {
      this.options.onDetach(element);
    } catch (error) {
      reportError(error);
    }
  }

  /** Force teardown for a single element (used when an engine gives up). */
  release(element: HTMLMediaElement): void {
    const pending = this.pendingRemoval.get(element);
    if (pending) {
      clearTimeout(pending);
      this.pendingRemoval.delete(element);
    }
    this.forget(element);
  }
}

function reportError(error: unknown): void {
  // Never surfaced in production builds: a page's console stays clean.
  warn('media registry callback failed', error);
}
