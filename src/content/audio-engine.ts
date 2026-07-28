/**
 * Audio dynamic-range compression.
 *
 * Signal chain per media element:
 *
 *   MediaElementSource -> preGain -> DynamicsCompressor -> makeupGain
 *                      -> limiter (DynamicsCompressor, ratio 20) -> destination
 *
 * Why this shape:
 *  - `preGain` pushes quiet dialogue into the compressor knee, which is what
 *    makes whispered speech audible without touching the loud parts.
 *  - the main compressor does the range reduction with a soft knee and a
 *    release that lengthens with strength (short releases cause pumping).
 *  - `makeupGain` restores perceived loudness; it is computed analytically in
 *    `core/strength.ts` so peaks land near -3 dBFS.
 *  - the limiter is a second compressor with a high ratio, ~3 ms attack and a
 *    -1.5 dB threshold. It only catches transients that slip past the slower
 *    main stage, so it adds no audible character.
 *
 * Total added latency is the two compressors' internal look-ahead (~12 ms in
 * Chromium), constant and well below the A/V sync threshold.
 *
 * Safety rules that shaped the implementation:
 *  - The source node is only created once the AudioContext is actually
 *    running. Connecting a media element to a suspended context silences it,
 *    so we never take that risk.
 *  - Cross-origin media without CORS produces a silent graph. Such elements
 *    are classified as `risky` and verified with a short silence probe; if the
 *    probe fails we close the context, which hands playback back to the
 *    element untouched.
 *  - Element `volume`/`muted` are applied by the element before the graph, so
 *    site volume sliders, mute buttons and keyboard shortcuts keep working.
 */
import type { AudioParams, AudioState, SoftClipParams } from '../core/types';
import { dbToGain } from '../core/math';
import { IDENTITY_SOFT_CLIP, buildSoftClipCurve } from '../core/soft-clip';
import { classifyElement, type MediaOriginClass } from '../core/media-origin';
import { debug } from '../core/log';

/** Chromium historically caps concurrent AudioContexts; stay well under it. */
const MAX_CONTEXTS = 4;
const PROBE_INTERVAL_MS = 100;
const PROBE_TICKS = 25; // ~2.5 s
const MAX_PROBE_ATTEMPTS = 2;
const RAMP_SECONDS = 0.12;

let liveContexts = 0;

type ProcessorState = 'idle' | 'active' | 'bypassed' | 'blocked' | 'unsupported';

interface Graph {
  context: AudioContext;
  source: MediaElementAudioSourceNode;
  preGain: GainNode;
  compressor: DynamicsCompressorNode;
  makeupGain: GainNode;
  limiter: DynamicsCompressorNode;
  /** Scales into the soft clipper's input domain (1 / headroom). */
  safetyTrim: GainNode;
  safetyShaper: WaveShaperNode;
  analyser: AnalyserNode;
  probeBuffer: Float32Array<ArrayBuffer>;
}

function rampParam(param: AudioParam, value: number, now: number, seconds = RAMP_SECONDS): void {
  const target = Number.isFinite(value) ? value : param.defaultValue;
  try {
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + seconds);
  } catch {
    try {
      param.value = target;
    } catch {
      /* parameter out of range: leave it alone */
    }
  }
}

class ElementAudioProcessor {
  private graph: Graph | null = null;
  private state: ProcessorState = 'idle';
  private params: AudioParams | null = null;
  private engaged = false;
  private originClass: MediaOriginClass = 'empty';
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private probeTicks = 0;
  private probeAttempts = 0;
  private probeSilent = true;
  private probeStartTime = -1;
  private safetySignature = '';
  private note: string | null = null;
  private destroyed = false;
  private readonly listeners: Array<[string, EventListener]> = [];
  private readonly onGesture: EventListener;

  constructor(
    private readonly element: HTMLMediaElement,
    private readonly pageOrigin: string,
    private readonly onChange: () => void,
  ) {
    const handle = (type: string, listener: EventListener) => {
      this.element.addEventListener(type, listener);
      this.listeners.push([type, listener]);
    };

    handle('playing', () => this.maybeEngage());
    handle('play', () => this.maybeEngage());
    handle('volumechange', () => this.maybeEngage());
    handle('loadedmetadata', () => this.onSourceChanged());
    handle('emptied', () => this.onSourceChanged());

    this.onGesture = () => {
      if (this.destroyed) return;
      this.maybeEngage();
    };
  }

  getState(): ProcessorState {
    return this.state;
  }

  getNote(): string | null {
    return this.note;
  }

  isProcessing(): boolean {
    return this.state === 'active';
  }

  /** Called whenever settings change. `params === null` means "leave audio alone". */
  update(params: AudioParams | null): void {
    if (this.destroyed) return;
    this.params = params;

    const wantsProcessing = Boolean(params && !params.bypass);
    this.engaged = wantsProcessing;

    if (!this.graph) {
      if (wantsProcessing) this.maybeEngage();
      else if (this.state !== 'blocked' && this.state !== 'unsupported') this.setState('idle');
      return;
    }

    // A graph already exists. It cannot be safely removed (detaching a media
    // element from a live source node silences it), so bypass is implemented
    // as a transparent parameter set: ratio 1, unity gains, 0 dB thresholds.
    this.applyParams(wantsProcessing ? (params as AudioParams) : null);
    this.setState(wantsProcessing ? 'active' : 'bypassed');
  }

  private setState(next: ProcessorState): void {
    if (this.state === next) return;
    this.state = next;
    this.onChange();
  }

  private setNote(note: string | null): void {
    if (this.note === note) return;
    this.note = note;
    this.onChange();
  }

  private maybeEngage(): void {
    if (this.destroyed || this.graph || !this.engaged) return;
    if (this.state === 'blocked' || this.state === 'unsupported') return;
    // Only engage for media that is actually playing. Pages full of idle
    // players would otherwise burn audio contexts, and a context created
    // without a user gesture usually cannot start anyway.
    if (this.element.paused) return;

    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      this.setNote('Web Audio API unavailable in this browser.');
      this.setState('unsupported');
      return;
    }

    if (liveContexts >= MAX_CONTEXTS) {
      this.setNote(`Audio limited to ${MAX_CONTEXTS} simultaneous players on this page.`);
      this.setState('blocked');
      return;
    }

    // A MediaStream with no audio track (canvas capture, screen share without
    // audio) has nothing to process; don't spend a context slot on it.
    if (this.hasNoAudioTrack()) return;

    this.originClass = classifyElement(this.element, this.pageOrigin);
    if (this.originClass === 'empty') return; // wait for loadedmetadata

    let context: AudioContext;
    try {
      context = new Ctor({ latencyHint: 'interactive' });
    } catch (error) {
      debug('AudioContext construction failed', error);
      this.setNote('Browser refused to create an audio context here.');
      this.setState('blocked');
      return;
    }
    liveContexts++;

    const buildWhenRunning = () => {
      if (this.destroyed) return;
      if (context.state === 'running') {
        context.removeEventListener('statechange', buildWhenRunning);
        this.buildGraph(context);
        return;
      }
      if (context.state === 'closed') {
        context.removeEventListener('statechange', buildWhenRunning);
      }
    };
    context.addEventListener('statechange', buildWhenRunning);

    void context.resume().catch(() => undefined);

    // If autoplay policy keeps the context suspended, wait for a user gesture.
    // The source node is deliberately *not* created until the context runs, so
    // the element keeps playing normally in the meantime.
    if (context.state !== 'running') {
      this.armGestureRetry();
      window.setTimeout(() => {
        if (this.destroyed || this.graph) return;
        if (context.state === 'running') {
          this.buildGraph(context);
        } else {
          context.removeEventListener('statechange', buildWhenRunning);
          void context.close().catch(() => undefined);
          liveContexts = Math.max(0, liveContexts - 1);
          debug('audio context stayed suspended; will retry on user gesture');
        }
      }, 1200);
      return;
    }

    context.removeEventListener('statechange', buildWhenRunning);
    this.buildGraph(context);
  }

  private hasNoAudioTrack(): boolean {
    const stream = (this.element as HTMLMediaElement & { srcObject?: unknown }).srcObject as
      | { getAudioTracks?: () => unknown[] }
      | null
      | undefined;
    if (!stream || typeof stream.getAudioTracks !== 'function') return false;
    try {
      return stream.getAudioTracks().length === 0;
    } catch {
      return false;
    }
  }

  private armGestureRetry(): void {
    const opts: AddEventListenerOptions = { once: true, capture: true, passive: true };
    for (const type of ['pointerdown', 'keydown', 'touchstart'] as const) {
      window.addEventListener(type, this.onGesture, opts);
    }
  }

  private buildGraph(context: AudioContext): void {
    if (this.destroyed || this.graph) return;
    try {
      const source = context.createMediaElementSource(this.element);
      const preGain = context.createGain();
      const compressor = context.createDynamicsCompressor();
      const makeupGain = context.createGain();
      const limiter = context.createDynamicsCompressor();
      const safetyTrim = context.createGain();
      const safetyShaper = context.createWaveShaper();
      // 'none' keeps the identity region bit-exact and adds no latency; the
      // curve is smooth enough that the aliasing on rare peaks is negligible.
      safetyShaper.oversample = 'none';
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;

      source.connect(preGain);
      preGain.connect(compressor);
      compressor.connect(makeupGain);
      makeupGain.connect(limiter);
      limiter.connect(safetyTrim);
      safetyTrim.connect(safetyShaper);
      safetyShaper.connect(context.destination);
      // Tap for the silence probe. An analyser has no output connection, so it
      // never affects the audible signal.
      safetyShaper.connect(analyser);

      this.graph = {
        context,
        source,
        preGain,
        compressor,
        makeupGain,
        limiter,
        safetyTrim,
        safetyShaper,
        analyser,
        probeBuffer: new Float32Array(analyser.fftSize),
      };

      context.addEventListener('statechange', this.onContextStateChange);

      this.applyParams(this.engaged ? this.params : null, 0.01);
      this.setState(this.engaged ? 'active' : 'bypassed');
      this.setNote(null);
      debug('audio graph attached', { origin: this.originClass, element: this.element.tagName });

      if (this.originClass === 'risky') this.startProbe();
    } catch (error) {
      debug('failed to build audio graph', error);
      void context.close().catch(() => undefined);
      liveContexts = Math.max(0, liveContexts - 1);
      this.setNote('This player could not be routed through Web Audio.');
      this.setState('blocked');
    }
  }

  private readonly onContextStateChange = (): void => {
    const graph = this.graph;
    if (!graph || this.destroyed) return;
    if (graph.context.state === 'suspended') {
      // A suspended context with a live source node means silence. Try to
      // resume; if that fails, tear down so the element plays natively again.
      void graph.context
        .resume()
        .catch(() => undefined)
        .then(() => {
          if (this.destroyed || !this.graph) return;
          if (this.graph.context.state !== 'running' && !this.element.paused) {
            debug('context could not resume; releasing element');
            this.teardown('Audio context was suspended by the browser.', 'blocked');
          }
        });
    }
  };

  private applyParams(params: AudioParams | null, seconds = RAMP_SECONDS): void {
    const graph = this.graph;
    if (!graph) return;
    const now = graph.context.currentTime;

    if (!params || params.bypass) {
      rampParam(graph.preGain.gain, 1, now, seconds);
      rampParam(graph.makeupGain.gain, 1, now, seconds);
      for (const node of [graph.compressor, graph.limiter]) {
        rampParam(node.threshold, 0, now, seconds);
        rampParam(node.knee, 0, now, seconds);
        rampParam(node.ratio, 1, now, seconds);
        rampParam(node.attack, 0.01, now, seconds);
        rampParam(node.release, 0.25, now, seconds);
      }
      this.applySafety(IDENTITY_SOFT_CLIP, now, seconds);
      return;
    }

    rampParam(graph.preGain.gain, dbToGain(params.preGainDb), now, seconds);
    rampParam(graph.makeupGain.gain, dbToGain(params.makeupGainDb), now, seconds);

    rampParam(graph.compressor.threshold, params.compressor.thresholdDb, now, seconds);
    rampParam(graph.compressor.knee, params.compressor.kneeDb, now, seconds);
    rampParam(graph.compressor.ratio, params.compressor.ratio, now, seconds);
    rampParam(graph.compressor.attack, params.compressor.attack, now, seconds);
    rampParam(graph.compressor.release, params.compressor.release, now, seconds);

    rampParam(graph.limiter.threshold, params.limiter.thresholdDb, now, seconds);
    rampParam(graph.limiter.knee, params.limiter.kneeDb, now, seconds);
    rampParam(graph.limiter.ratio, params.limiter.ratio, now, seconds);
    rampParam(graph.limiter.attack, params.limiter.attack, now, seconds);
    rampParam(graph.limiter.release, params.limiter.release, now, seconds);

    this.applySafety(params.safety, now, seconds);
  }

  /**
   * The clipper curve is a static table, so it is only rebuilt when the shape
   * actually changes (i.e. on a settings change, not per callback).
   */
  private applySafety(safety: SoftClipParams, now: number, seconds: number): void {
    const graph = this.graph;
    if (!graph) return;
    rampParam(graph.safetyTrim.gain, 1 / Math.max(1, safety.headroom), now, seconds);
    const signature = `${safety.headroom}/${safety.knee}/${safety.ceiling}`;
    if (signature === this.safetySignature) return;
    this.safetySignature = signature;
    try {
      graph.safetyShaper.curve = buildSoftClipCurve(safety);
    } catch (error) {
      debug('could not install safety curve', error);
    }
  }

  /** The element loaded a different resource: re-check whether it is safe. */
  private onSourceChanged(): void {
    if (this.destroyed) return;
    const next = classifyElement(this.element, this.pageOrigin);
    const previous = this.originClass;
    this.originClass = next;
    if (!this.graph) {
      if (this.engaged) this.maybeEngage();
      return;
    }
    if (next === 'risky' && previous !== 'risky') {
      this.probeAttempts = 0;
      this.startProbe();
    }
  }

  /**
   * Verify that audio actually flows through the graph. Cross-origin media
   * without CORS yields digital silence; if we see nothing but exact zeros for
   * 2.5 s of real playback we roll the graph back.
   */
  private startProbe(): void {
    if (this.probeTimer || !this.graph) return;
    if (this.probeAttempts >= MAX_PROBE_ATTEMPTS) return;
    this.probeAttempts++;
    this.probeTicks = 0;
    this.probeSilent = true;
    this.probeStartTime = -1;

    this.probeTimer = setInterval(() => this.probeTick(), PROBE_INTERVAL_MS);
  }

  private stopProbe(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private probeTick(): void {
    const graph = this.graph;
    if (!graph || this.destroyed) {
      this.stopProbe();
      return;
    }
    const element = this.element;
    const audible =
      !element.paused && !element.muted && element.volume > 0 && element.readyState >= 2;
    if (!audible || graph.context.state !== 'running') return;

    if (this.probeStartTime < 0) this.probeStartTime = element.currentTime;

    graph.analyser.getFloatTimeDomainData(graph.probeBuffer);
    for (let i = 0; i < graph.probeBuffer.length; i++) {
      if ((graph.probeBuffer[i] as number) !== 0) {
        this.probeSilent = false;
        break;
      }
    }

    this.probeTicks++;
    if (!this.probeSilent) {
      this.stopProbe();
      return;
    }
    if (this.probeTicks < PROBE_TICKS) return;

    this.stopProbe();
    const advanced = element.currentTime > this.probeStartTime + 0.5;
    if (!advanced) return; // playback stalled: inconclusive, try again later

    debug('silent graph detected, rolling back to native playback');
    this.teardown(
      'Audio left unprocessed: this player serves cross-origin media without CORS headers.',
      'blocked',
    );
  }

  /** Close the context, which returns audio output to the element itself. */
  private teardown(note: string | null, state: ProcessorState): void {
    this.stopProbe();
    const graph = this.graph;
    this.graph = null;
    if (graph) {
      graph.context.removeEventListener('statechange', this.onContextStateChange);
      try {
        graph.source.disconnect();
        graph.preGain.disconnect();
        graph.compressor.disconnect();
        graph.makeupGain.disconnect();
        graph.limiter.disconnect();
        graph.safetyTrim.disconnect();
        graph.safetyShaper.disconnect();
        graph.analyser.disconnect();
      } catch {
        /* already disconnected */
      }
      void graph.context.close().catch(() => undefined);
      liveContexts = Math.max(0, liveContexts - 1);
    }
    this.setNote(note);
    this.setState(state);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const [type, listener] of this.listeners) {
      this.element.removeEventListener(type, listener);
    }
    this.listeners.length = 0;
    for (const type of ['pointerdown', 'keydown', 'touchstart'] as const) {
      window.removeEventListener(type, this.onGesture, true);
    }
    this.teardown(null, 'idle');
  }
}

export interface AudioEngineStatus {
  state: AudioState;
  processed: number;
  skipped: number;
  notes: string[];
}

export class AudioEngine {
  private readonly processors = new Map<HTMLMediaElement, ElementAudioProcessor>();
  private params: AudioParams | null = null;
  private enabled = false;

  constructor(
    private readonly pageOrigin: string,
    private readonly onStatusChange: () => void,
  ) {}

  add(element: HTMLMediaElement): void {
    if (this.processors.has(element)) return;
    const processor = new ElementAudioProcessor(element, this.pageOrigin, this.onStatusChange);
    this.processors.set(element, processor);
    processor.update(this.enabled ? this.params : null);
  }

  remove(element: HTMLMediaElement): void {
    const processor = this.processors.get(element);
    if (!processor) return;
    this.processors.delete(element);
    processor.destroy();
    this.onStatusChange();
  }

  setParams(params: AudioParams, enabled: boolean): void {
    this.params = params;
    this.enabled = enabled;
    for (const processor of this.processors.values()) {
      processor.update(enabled ? params : null);
    }
  }

  getStatus(): AudioEngineStatus {
    let processed = 0;
    let skipped = 0;
    let blocked = false;
    let unsupported = false;
    let bypassed = false;
    const notes = new Set<string>();

    for (const processor of this.processors.values()) {
      const state = processor.getState();
      if (state === 'active') processed++;
      if (state === 'blocked') {
        skipped++;
        blocked = true;
      }
      if (state === 'unsupported') {
        skipped++;
        unsupported = true;
      }
      if (state === 'bypassed') bypassed = true;
      const note = processor.getNote();
      if (note) notes.add(note);
    }

    let state: AudioState;
    if (!this.enabled || !this.params || this.params.bypass) state = 'off';
    else if (processed > 0) state = 'active';
    else if (blocked) state = 'blocked';
    else if (unsupported) state = 'unsupported';
    else if (bypassed) state = 'bypassed';
    else state = 'idle';

    return { state, processed, skipped, notes: [...notes] };
  }

  destroy(): void {
    for (const processor of this.processors.values()) processor.destroy();
    this.processors.clear();
  }
}
