/**
 * Web Audio safety classification.
 *
 * `AudioContext.createMediaElementSource()` permanently re-routes an element's
 * audio through the graph. If the media resource is cross-origin *and* was not
 * fetched with CORS, the graph receives silence — the element would go mute.
 *
 * We therefore classify the source first:
 *   safe   - MSE/blob/data/file-less same-origin URLs, or an explicit
 *            crossorigin attribute (the fetch used CORS).
 *   risky  - plain cross-origin URL. Still processed, but verified with a
 *            short silence probe that can roll the graph back.
 *   empty  - nothing loaded yet; re-classify after `loadedmetadata`.
 */
export type MediaOriginClass = 'safe' | 'risky' | 'empty';

export interface ClassifyInput {
  /** `element.currentSrc || element.src` */
  src: string;
  /** `element.crossOrigin` (null when the attribute is absent) */
  crossOrigin: string | null;
  /** Document origin, e.g. `https://example.com` */
  pageOrigin: string;
  /** True when the element has a MediaStream/MediaSource object attached. */
  hasSrcObject?: boolean;
}

export function classifyMediaOrigin(input: ClassifyInput): MediaOriginClass {
  if (input.hasSrcObject) return 'safe';

  const src = (input.src ?? '').trim();
  if (!src) return 'empty';

  const lower = src.toLowerCase();
  // MSE and blob URLs are created by the page itself; data:/mediastream: carry
  // no separate origin. All are same-origin for Web Audio purposes.
  if (
    lower.startsWith('blob:') ||
    lower.startsWith('data:') ||
    lower.startsWith('mediasource:') ||
    lower.startsWith('mediastream:') ||
    lower.startsWith('about:')
  ) {
    return 'safe';
  }

  // An explicit crossorigin attribute means the resource was fetched with CORS,
  // so the audio is not tainted (assuming the server allowed it — if it did
  // not, the media would have failed to load at all).
  if (input.crossOrigin === 'anonymous' || input.crossOrigin === 'use-credentials') {
    return 'safe';
  }

  const base =
    input.pageOrigin && input.pageOrigin !== 'null' ? input.pageOrigin : undefined;

  let resolved: URL;
  try {
    resolved = new URL(src, base);
  } catch {
    try {
      // Absolute URL with an unusable base (opaque origin, sandboxed frame).
      resolved = new URL(src);
    } catch {
      return 'risky';
    }
  }

  if (resolved.protocol === 'file:' || resolved.protocol === 'filesystem:') return 'safe';
  if (!base) return 'risky';
  return resolved.origin === base ? 'safe' : 'risky';
}

/** Convenience wrapper for a live element. */
export function classifyElement(element: HTMLMediaElement, pageOrigin: string): MediaOriginClass {
  return classifyMediaOrigin({
    src: element.currentSrc || element.getAttribute('src') || '',
    crossOrigin: element.crossOrigin ?? null,
    pageOrigin,
    hasSrcObject: Boolean((element as HTMLMediaElement & { srcObject?: unknown }).srcObject),
  });
}
