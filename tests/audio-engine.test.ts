// @vitest-environment jsdom
/**
 * The audio engine against a fake Web Audio, for the three things a browser
 * will not show on demand.
 *
 * The first is the cross-origin path. A plain cross-origin `src` with no
 * `crossorigin` attribute is fetched no-cors, which makes the media data
 * CORS-cross-origin, which makes a `MediaElementAudioSourceNode` on it output
 * silence — by specification, every time. The engine used to route such an
 * element anyway and then listen for 2.5 s of exact zeros before rolling the
 * graph back, which cost every such player two and a half seconds of silence
 * at the start and could be fooled by a genuinely quiet intro. It now refuses
 * up front. What this suite pins is that the refusal is immediate, spends no
 * audio context, says why, and is withdrawn the moment the source becomes
 * something that can be processed.
 *
 * The other two are the popup's live block: Compare runs the graph transparent
 * for exactly as long as it is held, and the meter reads the gain off the
 * compressor rather than off the settings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine, CROSS_ORIGIN_AUDIO_NOTE } from '../src/content/audio-engine';
import { audioGainNowDb } from '../src/core/meter';
import { mapAudioStrength } from '../src/core/strength';
import { dbToGain } from '../src/core/math';

/* ------------------------------ fake Web Audio ----------------------------- */

class FakeParam {
  value: number;
  readonly defaultValue: number;
  constructor(value: number) {
    this.value = value;
    this.defaultValue = value;
  }
  cancelScheduledValues(): void {}
  setValueAtTime(): void {}
  /** Ramps land instantly: the value is what the engine asked for. */
  linearRampToValueAtTime(value: number): void {
    this.value = value;
  }
}

class FakeNode {
  connect(): FakeNode {
    return this;
  }
  disconnect(): void {}
}

class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}

class FakeBiquad extends FakeNode {
  type = '';
  frequency = new FakeParam(350);
  Q = new FakeParam(1);
  gain = new FakeParam(0);
}

class FakeCompressor extends FakeNode {
  threshold = new FakeParam(-24);
  knee = new FakeParam(30);
  ratio = new FakeParam(12);
  attack = new FakeParam(0.003);
  release = new FakeParam(0.25);
  /** What the meter reads: the reduction the node is applying right now. */
  reduction = 0;
}

class FakeShaper extends FakeNode {
  curve: Float32Array | null = null;
  oversample = 'none';
}

class FakeContext {
  state: 'running' | 'suspended' | 'closed' = 'running';
  currentTime = 0;
  destination = new FakeNode();
  gains: FakeGain[] = [];
  compressors: FakeCompressor[] = [];
  private listeners = new Map<string, Set<() => void>>();

  constructor() {
    contexts.push(this);
  }
  createGain(): FakeGain {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }
  createBiquadFilter(): FakeBiquad {
    return new FakeBiquad();
  }
  createDynamicsCompressor(): FakeCompressor {
    const node = new FakeCompressor();
    this.compressors.push(node);
    return node;
  }
  createWaveShaper(): FakeShaper {
    return new FakeShaper();
  }
  createMediaElementSource(): FakeNode {
    return new FakeNode();
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {
    this.state = 'closed';
  }
  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
}

/** Every context the engine constructed in this test. */
let contexts: FakeContext[];

const PAGE = 'https://example.com';
const params = mapAudioStrength(45);

interface Player {
  element: HTMLMediaElement;
  setSource(src: string): void;
}

function player(src: string, options: { crossOrigin?: string } = {}): Player {
  const element = document.createElement('video');
  // jsdom never plays anything; the engine only engages on a playing element.
  Object.defineProperty(element, 'paused', { value: false, configurable: true });
  Object.defineProperty(element, 'ended', { value: false, configurable: true });
  Object.defineProperty(element, 'readyState', { value: 4, configurable: true });
  element.setAttribute('src', src);
  if (options.crossOrigin) element.setAttribute('crossorigin', options.crossOrigin);
  document.body.appendChild(element);
  return {
    element,
    setSource(next) {
      element.setAttribute('src', next);
      element.dispatchEvent(new Event('loadedmetadata'));
    },
  };
}

let changes: number;
let engine: AudioEngine;

beforeEach(() => {
  document.body.innerHTML = '';
  contexts = [];
  changes = 0;
  Object.defineProperty(window, 'AudioContext', { value: FakeContext, configurable: true });
  vi.useFakeTimers();
  engine = new AudioEngine(PAGE, () => {
    changes++;
  });
});

afterEach(() => {
  engine.destroy();
  vi.useRealTimers();
});

const graphOf = (index = 0): FakeContext => {
  const context = contexts[index];
  if (!context) throw new Error('no audio graph was built');
  return context;
};

describe('a cross-origin player without CORS', () => {
  it('is refused at once, without a probe and without spending a context', () => {
    const cross = player('https://cdn.other.example/film.mp4');
    engine.add(cross.element);
    engine.setParams(params, true);

    const status = engine.getStatus();
    expect(status.state).toBe('blocked');
    expect(status.skipped).toBe(1);
    expect(status.processed).toBe(0);
    expect(status.notes).toEqual([CROSS_ORIGIN_AUDIO_NOTE]);
    // No context, no graph, no timer: the element plays natively from its
    // first sample rather than after two and a half seconds of nothing.
    expect(contexts).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is processed as soon as it moves to a source that can be', () => {
    // A player that starts on a cross-origin file and switches to MSE, or to
    // its own host, is a different question, and the verdict has to move with it.
    const cross = player('https://cdn.other.example/film.mp4');
    engine.add(cross.element);
    engine.setParams(params, true);
    expect(engine.getStatus().state).toBe('blocked');

    cross.setSource('blob:https://example.com/0f1e2d');
    expect(engine.getStatus().state).toBe('active');
    expect(engine.getStatus().notes).toEqual([]);
    expect(contexts).toHaveLength(1);
  });

  it('is processed when the site asked for CORS on it', () => {
    const cors = player('https://cdn.other.example/film.mp4', { crossOrigin: 'anonymous' });
    engine.add(cors.element);
    engine.setParams(params, true);
    expect(engine.getStatus().state).toBe('active');
    expect(contexts).toHaveLength(1);
  });

  it('does not let one refused player hide a processed one', () => {
    engine.add(player('https://cdn.other.example/ad.mp4').element);
    engine.add(player('/same-origin.mp4').element);
    engine.setParams(params, true);
    const status = engine.getStatus();
    expect(status.state).toBe('active');
    expect(status.processed).toBe(1);
    expect(status.skipped).toBe(1);
    expect(status.notes).toEqual([CROSS_ORIGIN_AUDIO_NOTE]);
  });
});

describe('Compare', () => {
  it('runs the graph transparent while held and puts the settings back on release', () => {
    engine.add(player('/film.mp4').element);
    engine.setParams(params, true);
    const graph = graphOf();
    const preGain = graph.gains[0] as FakeGain;
    const compressor = graph.compressors[0] as FakeCompressor;
    expect(preGain.gain.value).toBeCloseTo(dbToGain(params.preGainDb), 10);
    expect(compressor.ratio.value).toBe(params.compressor.ratio);

    engine.setHold(true);
    expect(preGain.gain.value).toBe(1);
    expect(compressor.ratio.value).toBe(1);
    expect(compressor.threshold.value).toBe(0);
    // Still the player being handled: the popup says "comparing" itself.
    expect(engine.getStatus().state).toBe('active');

    engine.setHold(false);
    expect(preGain.gain.value).toBeCloseTo(dbToGain(params.preGainDb), 10);
    expect(compressor.ratio.value).toBe(params.compressor.ratio);
  });

  it('outranks a settings change that lands while it is held', () => {
    engine.add(player('/film.mp4').element);
    engine.setParams(params, true);
    engine.setHold(true);
    const stronger = mapAudioStrength(80);
    engine.setParams(stronger, true);
    const preGain = graphOf().gains[0] as FakeGain;
    expect(preGain.gain.value).toBe(1);
    engine.setHold(false);
    expect(preGain.gain.value).toBeCloseTo(dbToGain(stronger.preGainDb), 10);
  });

  it('is a property of the held button, not of the player', () => {
    // A player attached while Compare is down must come up transparent too.
    engine.setParams(params, true);
    engine.setHold(true);
    engine.add(player('/film.mp4').element);
    expect(engine.getStatus().state).toBe('active');
    engine.setHold(false);
    expect((graphOf().gains[0] as FakeGain).gain.value).toBeCloseTo(dbToGain(params.preGainDb), 10);
  });
});

describe('the meter', () => {
  it('reads the gain off the compressor, not off the settings', () => {
    const film = player('/film.mp4');
    engine.add(film.element);
    engine.setParams(params, true);
    const [compressor, limiter] = graphOf().compressors as [FakeCompressor, FakeCompressor];

    // A whisper: no reduction, the whole lift lands.
    expect(engine.getMeter()).toEqual({ active: true, gainDb: audioGainNowDb(params, 0, 0) });
    expect(engine.getMeter().gainDb as number).toBeGreaterThan(9);

    // A burst: the compressor and the limiter both take gain off.
    compressor.reduction = -14;
    limiter.reduction = -2;
    expect(engine.getMeter().gainDb).toBeCloseTo(audioGainNowDb(params, -14, -2), 10);
    expect(engine.getMeter().gainDb as number).toBeLessThan(0);
  });

  it('has nothing to say about a paused player, and is inactive with nothing processed', () => {
    const film = player('/film.mp4');
    engine.add(film.element);
    engine.setParams(params, true);
    Object.defineProperty(film.element, 'paused', { value: true, configurable: true });
    expect(engine.getMeter()).toEqual({ active: true, gainDb: null });

    engine.setParams(params, false);
    expect(engine.getMeter()).toEqual({ active: false, gainDb: null });
  });

  it('follows the loudest lift among several processed players', () => {
    engine.add(player('/a.mp4').element);
    engine.add(player('/b.mp4').element);
    engine.setParams(params, true);
    (graphOf(0).compressors[0] as FakeCompressor).reduction = -12;
    (graphOf(1).compressors[0] as FakeCompressor).reduction = -3;
    expect(engine.getMeter().gainDb).toBeCloseTo(audioGainNowDb(params, -3, 0), 10);
  });

  it('reports the sound as active but unmeasured while a refused player is the only one', () => {
    engine.add(player('https://cdn.other.example/film.mp4').element);
    engine.setParams(params, true);
    expect(engine.getMeter()).toEqual({ active: false, gainDb: null });
  });
});
