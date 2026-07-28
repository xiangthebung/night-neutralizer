/**
 * Content script entry point. One instance per frame (the manifest injects
 * into all frames so that embedded players are covered).
 *
 * Wiring:
 *   settings (chrome.storage) --> engines
 *   MediaRegistry             --> AudioEngine + VideoEngine
 *   engines                   --> StatusReporter --> service worker --> popup
 *
 * Settings arrive through `chrome.storage.onChanged`, so changes apply live
 * without a page reload and without the popup needing tab permissions.
 */
import { createChromeSettingsStore } from '../core/settings';
import { mapStrength } from '../core/strength';
import { MSG } from '../core/messages';
import { DEFAULT_SETTINGS, type FrameStatus, type Settings } from '../core/types';
import { debug } from '../core/log';
import { MediaRegistry } from './media-registry';
import { AudioEngine } from './audio-engine';
import { VideoEngine } from './video-engine';
import { StatusReporter } from './status-reporter';

const GUARD_KEY = '__nightNeutralizerLoaded';

function alreadyLoaded(): boolean {
  const scope = window as unknown as Record<string, unknown>;
  if (scope[GUARD_KEY]) return true;
  try {
    Object.defineProperty(window, GUARD_KEY, { value: true, configurable: true });
  } catch {
    scope[GUARD_KEY] = true;
  }
  return false;
}

function pageOrigin(): string {
  try {
    return location.origin;
  } catch {
    return '';
  }
}

function main(): void {
  const store = createChromeSettingsStore();
  let settings: Settings = { ...DEFAULT_SETTINGS };

  const audio = new AudioEngine(pageOrigin(), () => reporter.schedule());
  const video = new VideoEngine(document, () => reporter.schedule());

  const registry = new MediaRegistry({
    onAttach: (element) => {
      debug('attach', element.tagName, element.currentSrc || element.src);
      audio.add(element);
      video.add(element);
      reporter.schedule();
    },
    onDetach: (element) => {
      debug('detach', element.tagName);
      audio.remove(element);
      video.remove(element);
      reporter.schedule();
    },
  });

  const reporter = new StatusReporter((): Omit<FrameStatus, 'frameId'> => {
    const audioStatus = audio.getStatus();
    const videoStatus = video.getStatus();
    return {
      at: Date.now(),
      top: window === window.top,
      settings,
      mediaElements: registry.size,
      audio: {
        state: audioStatus.state,
        processed: audioStatus.processed,
        skipped: audioStatus.skipped,
      },
      video: {
        mode: videoStatus.mode,
        elements: videoStatus.elements,
        technique: videoStatus.technique,
      },
      notes: [...audioStatus.notes, ...videoStatus.notes],
    };
  });

  const applySettings = (next: Settings): void => {
    settings = next;
    const params = mapStrength(next.strength);
    const master = next.enabled;
    audio.setParams(params.audio, master && next.audio);
    video.setParams(params.video, master && next.video);
    reporter.schedule();
  };

  // Extra discovery path: media events do not bubble, but they do run through
  // the capture phase, so this catches players created inside open shadow roots
  // or attached in ways the observer batches late.
  const onMediaEvent = (event: Event): void => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const target = (path[0] as Node | undefined) ?? (event.target as Node | null);
    if (!target) return;
    const tag = (target as Element).tagName;
    if (tag !== 'VIDEO' && tag !== 'AUDIO') return;
    registry.attach(target as HTMLMediaElement);
  };
  for (const type of ['play', 'loadedmetadata'] as const) {
    document.addEventListener(type, onMediaEvent, { capture: true, passive: true });
  }

  // SPA navigation: players are often reused, but a rescan is cheap insurance.
  window.addEventListener('popstate', () => registry.scan(document), { passive: true });
  window.addEventListener('pageshow', () => registry.scan(document), { passive: true });

  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== MSG.STATUS_REQUEST) return undefined;
      const audioStatus = audio.getStatus();
      const videoStatus = video.getStatus();
      sendResponse({
        at: Date.now(),
        top: window === window.top,
        settings,
        mediaElements: registry.size,
        audio: {
          state: audioStatus.state,
          processed: audioStatus.processed,
          skipped: audioStatus.skipped,
        },
        video: {
          mode: videoStatus.mode,
          elements: videoStatus.elements,
          technique: videoStatus.technique,
        },
        notes: [...audioStatus.notes, ...videoStatus.notes],
      } satisfies Omit<FrameStatus, 'frameId'>);
      return undefined;
    });
  }

  window.addEventListener(
    'pagehide',
    () => {
      registry.stop();
      audio.destroy();
      video.destroy();
      reporter.stop();
    },
    { once: true },
  );

  const boot = (): void => {
    registry.start(document);
    void store.load().then(applySettings);
    store.subscribe(applySettings);
  };

  if (document.documentElement) {
    boot();
  } else {
    document.addEventListener('readystatechange', boot, { once: true });
  }
}

if (!alreadyLoaded()) {
  try {
    main();
  } catch (error) {
    debug('initialisation failed', error);
  }
}
