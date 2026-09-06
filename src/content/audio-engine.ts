/**
 * Audio dynamic-range compression.
 *
 * Signal chain per media element:
 *
 *   MediaElementSource -> preGain -> lowShelf -> presence
 *                      -> DynamicsCompressor -> makeupGain
 *                      -> limiter (DynamicsCompressor, ratio 20)
 *                      -> safetyTrim -> softClip (WaveShaper) -> destination
 *
 * Why this shape:
 *  - `preGain` pushes quiet dialogue into the compressor knee, which is what
 *    makes whispered speech audible without touching the loud parts.
 *  - `lowShelf` and `presence` are the optional night EQ. They sit *before* the
 *    compressor so the compressor sees and controls the boosted presence band
 *    rather than being surprised by it. Both are flat when the toggle is off, so
 *    the nodes never have to be added to or removed from a live graph.
 *  - the main compressor does the range reduction with a soft knee and a
 *    release that lengthens with strength (short releases cause pumping).
 *  - `makeupGain` restores perceived loudness; it is computed analytically in
 *    `core/strength.ts` so steady-state peaks land at or below -4 dBFS.
 *  - the limiter is a second compressor with a high ratio, a 2 ms attack and a
 *    threshold that tightens to -2 dB at full strength. It only catches
 *    transients that slip past the slower main stage, so it adds no audible
 *    character.
 *  - `safetyTrim` + `softClip` are the last line of defence for transients that
 *    outrun even the limiter's attack, so the sink never sees a sample above
 *    the ceiling.
 *
 * Total added latency is the two compressors' internal look-ahead (~12 ms in
 * Chromium), constant and well below the A/V sync threshold.
 *
 * Safety rules that shaped the implementation:
 *  - The source node is only created once the AudioContext is actually
 *    running. Connecting a media element to a suspended context silences it,
 *    so we never take that risk.
 *  - Cross-origin media without CORS produces a silent graph, by specification:
 *    a `MediaElementAudioSourceNode` on a CORS-cross-origin resource outputs
 *    silence, and a plain cross-origin `src` with no `crossorigin` attribute is
 *    fetched no-cors and so is always CORS-cross-origin. Such elements are
 *    classified `risky` (`core/media-origin.ts`) and are *not* routed through
 *    a graph at all. They used to be routed and then verified with a 2.5 s
 *    silence probe that rolled the graph back, which cost two and a half
 *    seconds of silence at the start of every such player and could be fooled
 *    by a genuinely silent intro. The classification is what the probe was
 *    confirming, and the spec makes it deterministic, so the probe is gone:
 *    the element plays natively from its first sample and the popup says
 *    the sound cannot be processed.
 *  - Element `volume`/`muted` are applied by the element before the graph, so
 *    site volume sliders, mute buttons and keyboard shortcuts keep working.
 */
import type { AudioParams, AudioState, EqParams, SoftClipParams } from '../core/types';
import { dbToGain } from '../core/math';
import { IDENTITY_SOFT_CLIP, buildSoftClipCurve } from '../core/soft-clip';
import { neutralEqParams } from '../core/strength';
import { audioGainNowDb } from '../core/meter';
import { classifyElement, type MediaOriginClass } from '../core/media-origin';
import { isMusicMedia } from '../core/music';
import { debug } from '../core/log';

/** Chromium historically caps concurrent AudioContexts; stay well under it. */
const MAX_CONTEXTS = 4;
const RAMP_SECONDS = 0.12;

/** The popup's wording for a player whose sound cannot be routed through Web Audio. */
export const CROSS_ORIGIN_AUDIO_NOTE =
  "This player's sound can't be processed: it is served cross-origin without CORS headers, so Web Audio would only hear silence.";

let liveContexts = 0;

type ProcessorState = 'idle' | 'active' | 'bypassed' | 'blocked' | 'unsupported';

interface Graph {
  context: AudioContext;
  source: MediaElementAudioSourceNode;
  preGain: GainNode;
  /** Night EQ: low shelf then presence bell. Flat unless the toggle is on. */
  lowShelf: BiquadFilterNode;
  presence: BiquadFilterNode;
  compressor: DynamicsCompressorNode;
  makeupGain: GainNode;
  limiter: DynamicsCompressorNode;
  /** Scales into the soft clipper's input domain (1 / headroom). */
  safetyTrim: GainNode;
  safetyShaper: WaveShaperNode;
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
  /** True while the popup's Compare is held: the graph runs transparent. */
  private held = false;
  private originClass: MediaOriginClass = 'empty';
  /**
   * Set when `blocked` was decided from the source's origin alone. That
   * verdict is retractable — a player that swaps in a same-origin or MSE
   * source becomes processable — where the other reasons for `blocked` are not.
   */
  private blockedByOrigin = false;
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
    this.applyParams(this.liveParams());
    this.setState(wantsProcessing ? 'active' : 'bypassed');
  }

  /** The parameters the graph should be running right now, or null for transparent. */
  private liveParams(): AudioParams | null {
    if (this.held || !this.engaged) return null;
    return this.params;
  }

  /**
   * Compare: run the graph transparent while the popup's button is held. The
   * reported state stays `active`, because the player is still being handled
   * and the popup says "Comparing" on its own account; only the sound changes.
   */
  setHold(held: boolean): void {
    if (this.destroyed || this.held === held) return;
    this.held = held;
    if (this.graph) this.applyParams(this.liveParams());
  }

  /**
   * Net gain on the signal at this instant, in dB, or null when nothing is
   * being processed or nothing is playing. Read straight off the compressor
   * nodes' `reduction`, which is the one live measurement Web Audio exposes.
   */
  gainNowDb(): number | null {
    const graph = this.graph;
    const params = this.liveParams();
    if (!graph || !params || this.state !== 'active') return null;
    if (this.element.paused || this.element.ended || graph.context.state !== 'running') {
      return null;
    }
    return audioGainNowDb(params, graph.compressor.reduction, graph.limiter.reduction);
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
    if (this.originClass === 'risky') {
      // Routing this element would silence it, deterministically (see the
      // header). Say so now rather than after two and a half seconds of
      // nothing; the element keeps playing natively, untouched.
      this.blockedByOrigin = true;
      this.setNote(CROSS_ORIGIN_AUDIO_NOTE);
      this.setState('blocked');
      return;
    }

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
      const lowShelf = context.createBiquadFilter();
      lowShelf.type = 'lowshelf';
      const presence = context.createBiquadFilter();
      presence.type = 'peaking';
      const compressor = context.createDynamicsCompressor();
      const makeupGain = context.createGain();
      const limiter = context.createDynamicsCompressor();
      const safetyTrim = context.createGain();
      const safetyShaper = context.createWaveShaper();
      // 'none' keeps the identity region bit-exact and adds no latency; the
      // curve is smooth enough that the aliasing on rare peaks is negligible.
      safetyShaper.oversample = 'none';

      source.connect(preGain);
      preGain.connect(lowShelf);
      lowShelf.connect(presence);
      presence.connect(compressor);
      compressor.connect(makeupGain);
      makeupGain.connect(limiter);
      limiter.connect(safetyTrim);
      safetyTrim.connect(safetyShaper);
      safetyShaper.connect(context.destination);

      this.graph = {
        context,
        source,
        preGain,
        lowShelf,
        presence,
        compressor,
        makeupGain,
        limiter,
        safetyTrim,
        safetyShaper,
      };

      context.addEventListener('statechange', this.onContextStateChange);

      this.applyParams(this.liveParams(), 0.01);
      this.setState(this.engaged ? 'active' : 'bypassed');
      this.setNote(null);
      debug('audio graph attached', { origin: this.originClass, element: this.element.tagName });
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
      this.applyEq(neutralEqParams(), now, seconds);
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
    this.applyEq(params.eq, now, seconds);

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
   * Night EQ. Gains are ramped rather than set, because a step change in filter
   * gain during playback is audible as a click. Frequency and Q are ramped too
   * for the same reason, even though in practice they never move.
   */
  private applyEq(eq: EqParams, now: number, seconds: number): void {
    const graph = this.graph;
    if (!graph) return;
    rampParam(graph.lowShelf.frequency, eq.lowShelfHz, now, seconds);
    rampParam(graph.lowShelf.gain, eq.lowShelfDb, now, seconds);
    rampParam(graph.presence.frequency, eq.presenceHz, now, seconds);
    rampParam(graph.presence.Q, eq.presenceQ, now, seconds);
    rampParam(graph.presence.gain, eq.presenceDb, now, seconds);
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

  /**
   * The element loaded a different resource: re-check whether it is safe.
   *
   * A verdict of `blocked` reached from the origin alone is withdrawn here,
   * because it was about the *previous* source: a player that started on a
   * cross-origin file and moved to MSE, or to its own host, is processable
   * from now on. Once a graph exists the source cannot become unsafe — the
   * graph was built from a safe one, and a media element's source node is
   * permanent — so an existing graph is left alone.
   */
  private onSourceChanged(): void {
    if (this.destroyed) return;
    const next = classifyElement(this.element, this.pageOrigin);
    this.originClass = next;
    if (this.graph) return;
    if (this.blockedByOrigin && next !== 'risky') {
      this.blockedByOrigin = false;
      this.setNote(null);
      this.setState('idle');
    }
    if (this.engaged) this.maybeEngage();
  }

  /** Close the context, which returns audio output to the element itself. */
  private teardown(note: string | null, state: ProcessorState): void {
    const graph = this.graph;
    this.graph = null;
    if (graph) {
      graph.context.removeEventListener('statechange', this.onContextStateChange);
      try {
        graph.source.disconnect();
        graph.preGain.disconnect();
        graph.lowShelf.disconnect();
        graph.presence.disconnect();
        graph.compressor.disconnect();
        graph.makeupGain.disconnect();
        graph.limiter.disconnect();
        graph.safetyTrim.disconnect();
        graph.safetyShaper.disconnect();
      } catch {
        /* already disconnected */
      }
      void graph.context.close().catch(() => undefined);
      liveContexts = Math.max(0, liveContexts - 1);
    }
    this.blockedByOrigin = false;
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
  /** Elements deliberately left uncompressed because they are playing music. */
  music: number;
  notes: string[];
}

/** What the chain is doing to the signal right now; see `LiveMeterMessage`. */
export interface AudioMeter {
  active: boolean;
  gainDb: number | null;
}

/** Whether to leave music alone, and whether this frame's host is a music service. */
export interface MusicPolicy {
  skip: boolean;
  site: boolean;
}

const NO_MUSIC_POLICY: MusicPolicy = { skip: false, site: false };

export class AudioEngine {
  private readonly processors = new Map<HTMLMediaElement, ElementAudioProcessor>();
  private params: AudioParams | null = null;
  private enabled = false;
  private music: MusicPolicy = NO_MUSIC_POLICY;

  constructor(
    private readonly pageOrigin: string,
    private readonly onStatusChange: () => void,
  ) {}

  add(element: HTMLMediaElement): void {
    if (this.processors.has(element)) return;
    const processor = new ElementAudioProcessor(element, this.pageOrigin, this.onStatusChange);
    this.processors.set(element, processor);
    processor.update(this.paramsFor(element));
  }

  remove(element: HTMLMediaElement): void {
    const processor = this.processors.get(element);
    if (!processor) return;
    this.processors.delete(element);
    processor.destroy();
    this.onStatusChange();
  }

  /**
   * The music policy is a parameter of this call rather than a separate setter,
   * because the two are one decision: an engine holding fresh params and a stale
   * policy would compress exactly the thing the policy exists to protect.
   */
  setParams(params: AudioParams, enabled: boolean, music: MusicPolicy = NO_MUSIC_POLICY): void {
    this.params = params;
    this.enabled = enabled;
    this.music = music;
    this.applyAll();
  }

  /**
   * Re-run the per-element decision without a settings change.
   *
   * Needed because whether an element is music can only be answered once its
   * metadata has loaded: a `<video>` is 0x0 until then, and an ad break can swap
   * a picture in where there was none. The caller drives this from the media
   * events it already listens for.
   */
  refresh(): void {
    this.applyAll();
  }

  /** Compare: every processed player runs transparent while `held`. */
  setHold(held: boolean): void {
    for (const processor of this.processors.values()) processor.setHold(held);
  }

  /**
   * The largest gain any playing, processed element is receiving right now.
   * The largest rather than the average, because a page normally has one
   * player that matters and the meter should follow it, not be diluted by an
   * idle one.
   */
  getMeter(): AudioMeter {
    let gainDb: number | null = null;
    let active = false;
    for (const processor of this.processors.values()) {
      if (!processor.isProcessing()) continue;
      active = true;
      const now = processor.gainNowDb();
      if (now !== null && (gainDb === null || now > gainDb)) gainDb = now;
    }
    return { active, gainDb };
  }

  private applyAll(): void {
    for (const [element, processor] of this.processors) {
      processor.update(this.paramsFor(element));
    }
  }

  /** Params this element should run with, or null for "leave it alone". */
  private paramsFor(element: HTMLMediaElement): AudioParams | null {
    if (!this.enabled || !this.params) return null;
    return this.isMusic(element) ? null : this.params;
  }

  private isMusic(element: HTMLMediaElement): boolean {
    if (!this.music.skip) return false;
    const video = element as HTMLVideoElement;
    return isMusicMedia(
      {
        tagName: element.tagName,
        readyState: element.readyState,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
      },
      this.music.site,
    );
  }

  getStatus(): AudioEngineStatus {
    let processed = 0;
    let skipped = 0;
    let music = 0;
    let blocked = false;
    let unsupported = false;
    let bypassed = false;
    const notes = new Set<string>();
    const engaged = this.enabled && Boolean(this.params) && !this.params?.bypass;

    for (const [element, processor] of this.processors) {
      if (engaged && this.isMusic(element)) music++;
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
    if (!engaged) state = 'off';
    else if (processed > 0) state = 'active';
    else if (blocked) state = 'blocked';
    // Ahead of 'bypassed': a music element that already has a graph reports
    // itself bypassed, which is true but says nothing about why.
    else if (music > 0) state = 'music';
    else if (unsupported) state = 'unsupported';
    else if (bypassed) state = 'bypassed';
    else state = 'idle';

    return { state, processed, skipped, music, notes: [...notes] };
  }

  destroy(): void {
    for (const processor of this.processors.values()) processor.destroy();
    this.processors.clear();
  }
}
