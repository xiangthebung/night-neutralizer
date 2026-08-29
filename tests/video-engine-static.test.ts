// @vitest-environment jsdom
/**
 * The path taken when frames cannot be read at all.
 *
 * This is the branch that runs on every protected stream — Netflix, Prime
 * Video, Disney+ — and on any cross-origin video served without CORS headers,
 * so it is not an edge case, it is what a large fraction of the extension's
 * real usage looks like. It is also the branch with the most ways to go wrong
 * quietly: a read-back that throws on every frame is invisible except as a hot
 * CPU, and an engine that gives up but forgets to install the fixed curve looks
 * exactly like an engine that is working.
 *
 * So the three things asserted here are: it does not throw, it does not keep
 * asking, and it still applies a curve — and the reported mode says `static`,
 * never `adaptive`, because the popup and the store listing both promise that
 * distinction is honest.
 *
 * `nextFrameStride` — the other half of this engine — is covered separately in
 * `video-engine.test.ts`, because it is pure and needs no DOM at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoEngine } from '../src/content/video-engine';
import { mapVideoStrength } from '../src/core/strength';
import { buildToneCurve, curveToTableValues, staticAdaptState } from '../src/core/tone-curve';

const params = mapVideoStrength(45);

/** How many times the engine tried to read pixels back. */
let draws: number;
let reads: number;
/** What `getImageData` should do next. */
let mode: 'ok' | 'black' | 'throw';

/**
 * jsdom has no 2D canvas, so the engine's sampling surface is stubbed. The stub
 * is deliberately at the `getContext` boundary rather than inside the engine:
 * everything the engine does with the context — the `willReadFrequently` hint,
 * the draw, the read, the exception — stays under test.
 */
function installCanvasStub(): void {
  const pixels = (luma: number): Uint8ClampedArray => {
    const data = new Uint8ClampedArray(48 * 27 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = luma;
      data[i + 1] = luma;
      data[i + 2] = luma;
      data[i + 3] = 255;
    }
    return data;
  };

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        drawImage: () => {
          draws++;
        },
        getImageData: () => {
          reads++;
          if (mode === 'throw') {
            const error = new Error('The canvas has been tainted by cross-origin data.');
            error.name = 'SecurityError';
            throw error;
          }
          return { data: pixels(mode === 'black' ? 0 : 128) };
        },
      }) as unknown as CanvasRenderingContext2D,
  );
}

interface FakeVideoOptions {
  drm?: boolean;
  /** Present a `requestVideoFrameCallback`, as Chrome does. */
  frameCallback?: boolean;
}

interface FakeVideo {
  element: HTMLVideoElement;
  /** Run one presented frame, when `frameCallback` was asked for. */
  presentFrame(): void;
  frames: number;
}

function fakeVideo(options: FakeVideoOptions = {}): FakeVideo {
  const element = document.createElement('video');
  // jsdom lays nothing out, so the engine's "is this big enough to bother
  // with" check has to be answered by the intrinsic size.
  Object.defineProperty(element, 'videoWidth', { value: 1920, configurable: true });
  Object.defineProperty(element, 'videoHeight', { value: 1080, configurable: true });
  Object.defineProperty(element, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(element, 'paused', { value: false, configurable: true });
  if (options.drm) {
    Object.defineProperty(element, 'mediaKeys', { value: {}, configurable: true });
  }

  const state = { pending: null as (() => void) | null, frames: 0 };
  if (options.frameCallback) {
    Object.defineProperty(element, 'requestVideoFrameCallback', {
      configurable: true,
      value: (callback: (now: number) => void) => {
        state.pending = () => callback(0);
        return ++state.frames;
      },
    });
    Object.defineProperty(element, 'cancelVideoFrameCallback', {
      configurable: true,
      value: () => {
        state.pending = null;
      },
    });
  }

  document.body.appendChild(element);
  return {
    element,
    presentFrame() {
      const run = state.pending;
      state.pending = null;
      run?.();
    },
    get frames() {
      return state.frames;
    },
  };
}

function table(): string {
  return document.querySelector('feFuncR')?.getAttribute('tableValues') ?? '';
}

let engine: VideoEngine;

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  for (const node of document.querySelectorAll('svg, #nn-tone-style')) node.remove();
  vi.spyOn(CSS, 'supports').mockReturnValue(true);
  vi.useFakeTimers();
  draws = 0;
  reads = 0;
  mode = 'ok';
  installCanvasStub();
  engine = new VideoEngine(document, () => {});
});

afterEach(() => {
  engine.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('protected video', () => {
  it('detects DRM up front rather than by catching an exception', () => {
    const video = fakeVideo({ drm: true });
    engine.add(video.element);
    engine.setParams(params, true);

    const status = engine.getStatus();
    expect(status.mode).toBe('static');
    expect(status.notes.join(' ')).toMatch(/DRM/);
    // `mediaKeys` is checked before the canvas is touched, so a protected frame
    // is never drawn anywhere in the first place.
    expect(draws).toBe(0);
    expect(reads).toBe(0);
  });

  it('applies a real fixed curve rather than falling back to the identity', () => {
    const video = fakeVideo({ drm: true });
    engine.add(video.element);
    engine.setParams(params, true);

    const expected = curveToTableValues(buildToneCurve(params, staticAdaptState(params)));
    expect(table()).toBe(expected);

    const values = table().split(' ').map(Number);
    expect(values).toHaveLength(33);
    // Not the identity: shadows are lifted and white is pulled down.
    expect(values[8] as number).toBeGreaterThan(8 / 32 + 0.01);
    expect(values[32] as number).toBeLessThan(0.99);
  });

  it('stops asking, instead of retrying the read-back on every tick', () => {
    const video = fakeVideo({ drm: true });
    engine.add(video.element);
    engine.setParams(params, true);
    vi.advanceTimersByTime(30_000);

    expect(draws).toBe(0);
    expect(engine.getStatus().mode).toBe('static');
  });

  it('never reports itself as adaptive', () => {
    const video = fakeVideo({ drm: true, frameCallback: true });
    engine.add(video.element);
    engine.setParams(params, true);
    for (let i = 0; i < 50; i++) {
      video.presentFrame();
      vi.advanceTimersByTime(250);
    }
    expect(engine.getStatus().mode).toBe('static');
  });
});

describe('a tainted canvas', () => {
  it('gives up after the first SecurityError and switches to the fixed curve', () => {
    mode = 'throw';
    const video = fakeVideo();
    engine.add(video.element);
    engine.setParams(params, true);

    expect(reads).toBe(1);
    expect(engine.getStatus().mode).toBe('static');
    expect(engine.getStatus().notes.join(' ')).toMatch(/cross-origin/i);
  });

  it('does not spin: one failed read is the last one', () => {
    mode = 'throw';
    const video = fakeVideo();
    engine.add(video.element);
    engine.setParams(params, true);
    const after = reads;

    // Five minutes of upkeep ticks. The engine slows its timer down once it is
    // in static mode, and must not attempt the read-back again at all.
    vi.advanceTimersByTime(300_000);
    expect(reads).toBe(after);
  });

  it('detaches the frame callback instead of re-registering it every frame', () => {
    mode = 'throw';
    const video = fakeVideo({ frameCallback: true });
    engine.add(video.element);
    engine.setParams(params, true);

    // First tick attaches; the callback runs, the read fails, and the engine
    // must not schedule another. Without the detach this is a read-back
    // throwing an exception 60 times a second for as long as the tab is open.
    const registrations = video.frames;
    video.presentFrame();
    for (let i = 0; i < 10; i++) {
      video.presentFrame();
      vi.advanceTimersByTime(500);
    }
    expect(video.frames).toBe(registrations);
    expect(engine.getStatus().mode).toBe('static');
  });
});

describe('frames that read back black', () => {
  it('tolerates a fade to black rather than treating it as protection', () => {
    mode = 'black';
    const video = fakeVideo({ frameCallback: true });
    engine.add(video.element);
    engine.setParams(params, true);
    // ~1.5 s of black at 60 fps: a fade, not a protected pipeline.
    for (let i = 0; i < 90; i++) video.presentFrame();
    expect(engine.getStatus().mode).toBe('adaptive');
  });

  it('gives up once the run is long enough to mean the pipeline is protected', () => {
    mode = 'black';
    const video = fakeVideo({ frameCallback: true });
    engine.add(video.element);
    engine.setParams(params, true);
    for (let i = 0; i < 200; i++) video.presentFrame();

    const status = engine.getStatus();
    expect(status.mode).toBe('static');
    expect(status.notes.join(' ')).toMatch(/black/i);
    expect(table()).toBe(curveToTableValues(buildToneCurve(params, staticAdaptState(params))));
  });
});

describe('switching off', () => {
  it('leaves no filter behind even after the static fallback engaged', () => {
    const video = fakeVideo({ drm: true });
    engine.add(video.element);
    engine.setParams(params, true);
    expect(document.getElementById('nn-tone-style')).not.toBeNull();

    engine.setParams(params, false);
    expect(document.getElementById('nn-tone-style')).toBeNull();
    expect(engine.getStatus().mode).toBe('off');
    expect(engine.getStatus().notes).toEqual([]);
  });
});
