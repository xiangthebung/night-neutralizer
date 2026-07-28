/**
 * Adaptive video tone mapping.
 *
 * Loop (default 8 Hz):
 *   1. pick the "primary" video: the largest visible, playing one;
 *   2. draw it into a 48x27 offscreen canvas and read the pixels back;
 *   3. summarise luminance (mean / p10 / p90 / p99.5);
 *   4. advance the adaptation state (asymmetric smoothing + flash guard);
 *   5. rebuild the 33-entry tone curve and push it into the SVG filter.
 *
 * The measurement is deliberately tiny: a 48x27 read-back costs well under a
 * millisecond and runs 8 times per second, and the *effect* itself is applied
 * by the compositor, not by JavaScript.
 *
 * When frames cannot be read - Widevine/EME content, or a cross-origin video
 * without CORS headers, both of which taint the canvas - the engine switches to
 * a fixed curve and reports mode `static`. It never claims to be adaptive in
 * that case, and it never tries to work around the protection.
 */
import type { VideoMode, VideoParams } from '../core/types';
import {
  buildToneCurve,
  computeSceneStats,
  createAdaptState,
  cssApproxFilter,
  curveToTableValues,
  staticAdaptState,
  updateAdaptState,
  type AdaptState,
  type SceneStats,
} from '../core/tone-curve';
import { debug } from '../core/log';
import { ToneFilter, type ToneTechnique } from './tone-filter';

const SAMPLE_W = 48;
const SAMPLE_H = 27;
/** Timer rate when the timer also has to do the measuring (no rVFC support). */
const FALLBACK_INTERVAL_MS = 125;
/** Timer rate when frame callbacks do the measuring: upkeep only. */
const UPKEEP_INTERVAL_MS = 250;
const SLOW_INTERVAL_MS = 500;
const BLACK_FRAME_LIMIT = 150; // ~5 s of pure black while playing at 30 fps
/** Above this measured cost per sample, skip frames. */
const COST_BUDGET_MS = 1.2;
/** Minimum gap between LUT writes; a rising flash overrides it. */
const MIN_PUSH_INTERVAL_MS = 30;

type Analysability = 'unknown' | 'readable' | 'unreadable';

/** `requestVideoFrameCallback` is not in every TS DOM lib version. */
type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

interface VideoRecord {
  analysable: Analysability;
  blackFrames: number;
  reason?: string;
}

interface SampleResult {
  stats: SceneStats | null;
  /** True when this element can never be analysed again. */
  unreadable: boolean;
}

export interface VideoEngineStatus {
  mode: VideoMode;
  elements: number;
  technique: ToneTechnique;
  notes: string[];
}

export class VideoEngine {
  private readonly doc: Document;
  private readonly filter: ToneFilter;
  private readonly videos = new Map<HTMLVideoElement, VideoRecord>();
  private params: VideoParams | null = null;
  private enabled = false;
  private state: AdaptState = createAdaptState();
  private mode: VideoMode = 'off';
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs = UPKEEP_INTERVAL_MS;
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private ctx2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  private sampleCostMs = 0;
  private notes = new Set<string>();
  private destroyed = false;

  /** Frame-callback state: measurement runs on the video's own cadence. */
  private frameVideo: FrameCallbackVideo | null = null;
  private frameHandle = 0;
  private frameCounter = 0;
  private frameStride = 1;
  private lastMeasureAt = 0;
  private lastPushAt = 0;

  constructor(
    doc: Document,
    private readonly onStatusChange: () => void,
  ) {
    this.doc = doc;
    this.filter = new ToneFilter(doc);
    this.doc.addEventListener('fullscreenchange', this.onFullscreenChange, true);
  }

  add(element: HTMLMediaElement): void {
    if (element.tagName !== 'VIDEO') return;
    const video = element as HTMLVideoElement;
    if (this.videos.has(video)) return;
    this.videos.set(video, { analysable: 'unknown', blackFrames: 0 });
    if (this.enabled && this.params && !this.params.bypass) {
      this.filter.ensure();
      this.filter.markVideo(video);
    }
    this.onStatusChange();
  }

  remove(element: HTMLMediaElement): void {
    if (element.tagName !== 'VIDEO') return;
    const video = element as HTMLVideoElement;
    if (!this.videos.delete(video)) return;
    if (this.frameVideo === video) this.detachFrameCallback();
    this.filter.unmarkVideo(video);
    this.onStatusChange();
  }

  setParams(params: VideoParams, enabled: boolean): void {
    this.params = params;
    const active = enabled && !params.bypass;
    const wasActive = this.enabled;
    this.enabled = active;

    if (!active) {
      this.stopLoop();
      this.detachFrameCallback();
      for (const video of this.videos.keys()) this.filter.unmarkVideo(video);
      // Leave nothing behind while switched off: no stylesheet, no filter node.
      this.filter.teardown();
      this.mode = 'off';
      this.notes.clear();
      this.onStatusChange();
      return;
    }

    if (!wasActive) this.state = createAdaptState();

    this.filter.ensure();
    for (const video of this.videos.keys()) this.filter.markVideo(video);
    this.pushCurve(true);
    this.startLoop(UPKEEP_INTERVAL_MS);
    this.tick();
    this.onStatusChange();
  }

  getStatus(): VideoEngineStatus {
    return {
      mode: this.enabled ? this.mode : 'off',
      elements: this.videos.size,
      technique: this.enabled ? this.filter.getTechnique() : 'none',
      notes: [...this.notes],
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.doc.removeEventListener('fullscreenchange', this.onFullscreenChange, true);
    this.stopLoop();
    this.detachFrameCallback();
    for (const video of this.videos.keys()) this.filter.unmarkVideo(video);
    this.videos.clear();
    this.filter.destroy();
  }

  private readonly onFullscreenChange = (): void => {
    if (!this.enabled) return;
    this.filter.syncFullscreen();
  };

  private startLoop(intervalMs: number): void {
    if (this.timer && this.intervalMs === intervalMs) return;
    this.stopLoop();
    this.intervalMs = intervalMs;
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  private stopLoop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private setMode(mode: VideoMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.onStatusChange();
  }

  private note(text: string): void {
    if (this.notes.has(text)) return;
    this.notes.add(text);
    this.onStatusChange();
  }

  /**
   * Timer work: keep our nodes healthy, decide who the primary video is, and
   * measure only if frame callbacks are unavailable.
   */
  private tick(): void {
    if (this.destroyed || !this.enabled || !this.params) return;

    // Cheap upkeep: sites can replace attributes or wipe our nodes.
    this.filter.ensure();
    for (const video of this.videos.keys()) this.filter.markVideo(video);
    this.filter.syncFullscreen();

    if (this.doc.hidden) {
      // Nothing is being painted; skip the read-back entirely. If we never got
      // to measure anything, fall back to the fixed curve so a video that
      // becomes visible is already treated (and report that honestly).
      if (this.mode === 'off') this.applyStatic();
      return;
    }

    const primary = this.pickPrimary();
    if (!primary) {
      this.detachFrameCallback();
      this.pushCurve();
      return;
    }

    const record = this.videos.get(primary);
    if (!record) return;

    if (record.analysable === 'unreadable') {
      this.detachFrameCallback();
      this.applyStatic(record.reason);
      // Static mode needs no measurements: back off to save CPU.
      this.startLoop(SLOW_INTERVAL_MS);
      return;
    }

    // Preferred path: measure once per presented frame. Detection latency for
    // a cut or a flash is then one frame (~16 ms) instead of up to 125 ms,
    // which is the difference between catching a short flash and missing it.
    this.attachFrameCallback(primary);
    if (this.frameVideo === primary) {
      this.startLoop(UPKEEP_INTERVAL_MS);
      return;
    }

    if (this.measure(primary, record)) this.startLoop(FALLBACK_INTERVAL_MS);
  }

  private attachFrameCallback(video: HTMLVideoElement): void {
    const candidate = video as FrameCallbackVideo;
    if (this.frameVideo === candidate) return;
    this.detachFrameCallback();
    if (typeof candidate.requestVideoFrameCallback !== 'function') return;

    this.frameVideo = candidate;
    this.frameCounter = 0;
    this.lastMeasureAt = now();

    const step = (): void => {
      this.frameHandle = 0;
      if (this.destroyed || !this.enabled || this.frameVideo !== candidate) return;
      const record = this.videos.get(candidate);
      if (!record || record.analysable === 'unreadable') {
        this.detachFrameCallback();
        return;
      }
      // Frame skipping keeps the read-back cost bounded on expensive
      // GPU/driver combinations and very high resolutions.
      if (++this.frameCounter % this.frameStride === 0) this.measure(candidate, record);
      this.frameHandle = candidate.requestVideoFrameCallback?.(step) ?? 0;
    };

    this.frameHandle = candidate.requestVideoFrameCallback(step);
    debug('measuring on the video frame callback');
  }

  private detachFrameCallback(): void {
    const video = this.frameVideo;
    this.frameVideo = null;
    this.frameStride = 1;
    if (video && this.frameHandle) {
      try {
        video.cancelVideoFrameCallback?.(this.frameHandle);
      } catch {
        /* already cancelled */
      }
    }
    this.frameHandle = 0;
  }

  /**
   * One measurement: sample, advance the adaptation, publish the curve.
   * Returns false when the frame could not be analysed.
   */
  private measure(video: HTMLVideoElement, record: VideoRecord): boolean {
    if (!this.params) return false;

    const started = now();
    const dt = this.lastMeasureAt > 0 ? (started - this.lastMeasureAt) / 1000 : 1 / 60;
    this.lastMeasureAt = started;

    const result = this.sample(video, record);
    this.sampleCostMs = this.sampleCostMs * 0.8 + (now() - started) * 0.2;

    if (!result.stats) {
      this.applyStatic(record.reason);
      if (result.unreadable) {
        this.detachFrameCallback();
        this.startLoop(SLOW_INTERVAL_MS);
      }
      return false;
    }

    record.analysable = 'readable';
    const previousFlash = this.state.flash;
    this.state = updateAdaptState(this.state, result.stats, this.params, dt);
    this.setMode('adaptive');
    // A rising flash must reach the screen on the very next frame, so it
    // bypasses the push throttle.
    this.pushCurve(this.state.flash > previousFlash + 0.01);
    this.tuneStride();
    return true;
  }

  private tuneStride(): void {
    if (!this.frameVideo) return;
    if (this.sampleCostMs > COST_BUDGET_MS && this.frameStride < 8) {
      this.frameStride *= 2;
      debug('sampling is expensive, skipping frames', this.sampleCostMs, this.frameStride);
      if (this.frameStride >= 4) this.note('Reduced analysis rate to keep CPU usage low.');
    } else if (this.sampleCostMs < COST_BUDGET_MS / 2 && this.frameStride > 1) {
      this.frameStride /= 2;
    }
  }

  private applyStatic(reason?: string): void {
    if (!this.params) return;
    this.state = staticAdaptState(this.params);
    this.setMode('static');
    if (reason) this.note(reason);
    this.pushCurve(true);
  }

  private pushCurve(force = false): void {
    if (!this.params) return;
    const at = now();
    if (!force && at - this.lastPushAt < MIN_PUSH_INTERVAL_MS) return;
    this.lastPushAt = at;

    const curve = buildToneCurve(this.params, this.state);
    this.filter.setCurve(curveToTableValues(curve), this.params.saturation);
    if (this.filter.getTechnique() === 'css-basic') {
      this.filter.setFallbackCss(cssApproxFilter(this.params, this.state));
      this.note('SVG filters unavailable: using an approximate CSS curve.');
    }
  }

  /** Largest visible, playing video wins; one curve is shared per document. */
  private pickPrimary(): HTMLVideoElement | null {
    let best: HTMLVideoElement | null = null;
    let bestArea = 0;
    for (const video of this.videos.keys()) {
      if (!video.isConnected) continue;
      if (video.readyState < 2) continue;
      const width = video.clientWidth || video.videoWidth;
      const height = video.clientHeight || video.videoHeight;
      const area = width * height;
      if (area < 2500) continue; // ignore tracking pixels and tiny previews
      const playing = !video.paused && !video.ended;
      const score = playing ? area * 4 : area;
      if (score > bestArea) {
        bestArea = score;
        best = video;
      }
    }
    return best;
  }

  private ensureCanvas(): boolean {
    if (this.ctx2d) return true;
    try {
      if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(SAMPLE_W, SAMPLE_H);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          this.canvas = canvas;
          this.ctx2d = ctx as OffscreenCanvasRenderingContext2D;
          return true;
        }
      }
      const canvas = this.doc.createElement('canvas');
      canvas.width = SAMPLE_W;
      canvas.height = SAMPLE_H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;
      this.canvas = canvas;
      this.ctx2d = ctx;
      return true;
    } catch (error) {
      debug('no 2d context for analysis', error);
      return false;
    }
  }

  private sample(video: HTMLVideoElement, record: VideoRecord): SampleResult {
    const giveUp = (reason: string): SampleResult => {
      record.analysable = 'unreadable';
      record.reason = reason;
      return { stats: null, unreadable: true };
    };

    // Encrypted media: the frame buffer is not readable by design. Detect it up
    // front instead of relying on an exception.
    if ((video as HTMLVideoElement & { mediaKeys?: unknown }).mediaKeys) {
      return giveUp(
        'Protected (DRM) video: frames cannot be analysed, so a fixed night curve is applied.',
      );
    }
    if (!this.ensureCanvas() || !this.ctx2d) {
      return giveUp('Canvas analysis unavailable: a fixed night curve is applied.');
    }

    try {
      this.ctx2d.drawImage(video as unknown as CanvasImageSource, 0, 0, SAMPLE_W, SAMPLE_H);
      const data = this.ctx2d.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
      const stats = computeSceneStats(data);

      // Some protected pipelines hand out black frames instead of throwing.
      // A real fade to black looks identical, so only a long run of them counts.
      if (stats.peak <= 0.02 && !video.paused) {
        record.blackFrames++;
        if (record.blackFrames >= BLACK_FRAME_LIMIT) {
          return giveUp(
            'Frames read back as black (protected or hardware-composited video): a fixed night curve is applied.',
          );
        }
      } else {
        record.blackFrames = 0;
      }
      return { stats, unreadable: false };
    } catch (error) {
      // SecurityError: cross-origin frame data. Expected on some CDNs.
      debug('frame analysis blocked', error);
      return giveUp(
        'Frames are cross-origin protected: scene analysis is off, a fixed night curve is applied.',
      );
    }
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
