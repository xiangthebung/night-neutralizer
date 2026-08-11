/**
 * Content script entry point. One instance per frame (the manifest injects
 * into all frames so that embedded players are covered).
 *
 * Wiring:
 *   settings (chrome.storage.sync)     --\
 *   ambient light (chrome.storage.session) >-- gate --> engines
 *   the local clock                    --/
 *   MediaRegistry                      --> AudioEngine + VideoEngine
 *   engines                            --> StatusReporter --> service worker --> popup
 *
 * Settings arrive through `chrome.storage.onChanged`, so changes apply live
 * without a page reload and without the popup needing tab permissions. The
 * ambient reading arrives the same way, from whichever top-level frame has a
 * working light sensor; the clock is checked on a timer that sleeps until the
 * next window boundary.
 */
import { createChromeSettingsStore, sanitizeSettings } from '../core/settings';
import { mapSettings } from '../core/strength';
import { isSiteDisabled, primarySite, siteKeys } from '../core/site';
import {
  classifyLux,
  createChromeAmbientStore,
  readingDarkness,
  shouldPublish,
  type AmbientReading,
  type Darkness,
} from '../core/ambient';
import { evaluateGate, gateRecheckDelayMs, type GateResult } from '../core/gate';
import { minutesOfDay } from '../core/schedule';
import { isMusicHost } from '../core/music';
import { MSG } from '../core/messages';
import { type FrameStatus, type Settings } from '../core/types';
import { debug } from '../core/log';
import { MediaRegistry } from './media-registry';
import { AudioEngine } from './audio-engine';
import { VideoEngine } from './video-engine';
import { ImageEngine } from './image-engine';
import { LightSensor } from './light-sensor';
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

/**
 * Site keys for this frame, resolved once. `location` cannot change without a
 * fresh document (and therefore a fresh content script), so there is nothing to
 * invalidate here; SPA route changes do not alter the host.
 */
function frameSiteKeys(): string[] {
  try {
    return siteKeys(location);
  } catch {
    return [];
  }
}

function main(): void {
  const store = createChromeSettingsStore();
  const ambientStore = createChromeAmbientStore();
  let settings: Settings = sanitizeSettings({});
  const keys = frameSiteKeys();
  const site = (() => {
    try {
      return primarySite(location);
    } catch {
      return '';
    }
  })();
  /** Fixed for the life of the document, like the site keys it comes from. */
  const musicSite = isMusicHost(keys);
  const isTopFrame = window === window.top;

  /** Latest shared light reading, and the verdict derived from it. */
  let ambient: AmbientReading | null = null;
  let darkness: Darkness = 'unknown';
  /** Last reading this frame published, for the publishing throttle. */
  let published: AmbientReading | null = null;
  let gate: GateResult = { active: false, reason: 'off', source: 'none' };
  let recheckTimer: ReturnType<typeof setTimeout> | null = null;

  const audio = new AudioEngine(pageOrigin(), () => reporter.schedule());
  const video = new VideoEngine(document, () => reporter.schedule());
  // Stills are not media elements, so the registry never sees them: the image
  // engine works by selector and needs no discovery. See `image-engine.ts`.
  const images = new ImageEngine(document, () => reporter.schedule());

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

  /**
   * One snapshot builder, used both for the pushed reports and for the popup's
   * direct query. Two copies of this object drifted apart the moment a field was
   * added, so there is deliberately only one.
   */
  const snapshot = (): Omit<FrameStatus, 'frameId'> => {
    const audioStatus = audio.getStatus();
    const videoStatus = video.getStatus();
    const imageStatus = images.getStatus();
    const siteDisabled = isSiteDisabled(settings.disabledSites, keys);
    return {
      at: Date.now(),
      top: isTopFrame,
      settings,
      site,
      siteDisabled,
      gate: {
        active: gate.active,
        reason: gate.reason,
        source: gate.source,
        // Whole lux: the popup shows it as context, and a value that moves every
        // report would defeat the reporter's deduplication.
        lux: ambient ? Math.round(ambient.lux) : null,
      },
      music: { site: musicSite, skipped: audioStatus.music },
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
      images: { active: imageStatus.active, elements: imageStatus.elements },
      notes: [
        ...(siteDisabled && site ? [`Turned off for ${site}.`] : []),
        ...audioStatus.notes,
        ...videoStatus.notes,
        ...imageStatus.notes,
      ],
    };
  };

  const reporter = new StatusReporter(snapshot);

  /**
   * Wake up when the night window next opens or closes.
   *
   * A timer rather than polling, and re-armed after every evaluation so a
   * settings change to the window takes effect without waiting out the old one.
   * `gateRecheckDelayMs` caps how far ahead it will sleep, which is what keeps a
   * DST change or a corrected system clock from going unnoticed for an hour.
   */
  const scheduleRecheck = (now: Date): void => {
    if (recheckTimer) {
      clearTimeout(recheckTimer);
      recheckTimer = null;
    }
    const delay = gateRecheckDelayMs(settings, now);
    if (delay <= 0) return;
    recheckTimer = setTimeout(() => {
      recheckTimer = null;
      applyGate();
    }, delay);
  };

  /**
   * The only place the engines are switched on or off.
   *
   * Called on a settings change, on a new light reading, when the night window
   * boundary passes, and when the tab becomes visible again — because all four
   * can change the same answer.
   */
  const applyGate = (): void => {
    const now = new Date();
    const params = mapSettings(settings);
    gate = evaluateGate({
      settings,
      siteKeys: keys,
      darkness,
      nowMinutes: minutesOfDay(now),
    });
    audio.setParams(params.audio, gate.active && settings.audio, {
      skip: settings.skipMusic,
      site: musicSite,
    });
    video.setParams(params.video, gate.active && settings.video);
    // The picture slider drives both, but the two switches are independent: see
    // `Settings.images`.
    images.setParams(params.video, gate.active && settings.images);
    syncSensor();
    scheduleRecheck(now);
    reporter.schedule();
  };

  const applySettings = (next: Settings): void => {
    settings = next;
    applyGate();
  };

  /* ----------------------------- ambient light ---------------------------- */

  const applyAmbient = (reading: AmbientReading | null): void => {
    ambient = reading;
    darkness = readingDarkness(reading, Date.now(), darkness);
    applyGate();
  };

  /**
   * A reading from this frame's own sensor. Published so that every other frame
   * and tab uses the same verdict: without sharing, a cross-origin player (which
   * may not read the sensor at all) would fall back to the clock and disagree
   * with the page hosting it.
   */
  const sensor = new LightSensor((lux) => {
    const next: AmbientReading = { lux, at: Date.now() };
    const nextDarkness = classifyLux(lux, darkness);
    if (!shouldPublish(published, next, darkness, nextDarkness)) return;
    published = next;
    // Applied locally as well as published: session storage may be unwritable
    // from a content script if the service worker has not widened its access
    // level yet, and this frame's own reading is still worth having.
    void ambientStore?.save(next);
    applyAmbient(next);
  });

  /** Only run the sensor while an answer from it could change anything. */
  const syncSensor = (): void => {
    if (!isTopFrame) return;
    if (settings.enabled && settings.nightOnly) sensor.start();
    else sensor.stop();
  };

  /* -------------------------------- events -------------------------------- */

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
    // `loadedmetadata` is the moment a <video> stops being 0x0, which is what
    // decides whether it counts as music, so the audio decision is re-run here.
    audio.refresh();
  };
  for (const type of ['play', 'loadedmetadata'] as const) {
    document.addEventListener(type, onMediaEvent, { capture: true, passive: true });
  }

  // SPA navigation: players are often reused, but a rescan is cheap insurance.
  window.addEventListener('popstate', () => registry.scan(document), { passive: true });
  window.addEventListener('pageshow', () => registry.scan(document), { passive: true });

  // A hidden tab's timers are throttled and the sensor stops reporting, so the
  // clock can be well out of date by the time the tab comes back.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) applyGate();
  });

  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== MSG.STATUS_REQUEST) return undefined;
      sendResponse(snapshot() satisfies Omit<FrameStatus, 'frameId'>);
      return undefined;
    });
  }

  window.addEventListener(
    'pagehide',
    () => {
      registry.stop();
      sensor.stop();
      if (recheckTimer) clearTimeout(recheckTimer);
      audio.destroy();
      video.destroy();
      images.destroy();
      reporter.stop();
    },
    { once: true },
  );

  const boot = (): void => {
    registry.start(document);
    void store.load().then(applySettings);
    store.subscribe(applySettings);
    // A reading may already be in session storage from another tab.
    void ambientStore?.load().then((reading) => {
      if (reading && (!ambient || reading.at >= ambient.at)) applyAmbient(reading);
    });
    ambientStore?.subscribe(applyAmbient);
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
