/**
 * The welcome page, opened once on install.
 *
 * Everything here is real and local. The scene is drawn on a canvas; the
 * "after" half is measured with `computeSceneStats`, adapted with
 * `updateAdaptState` and curved with `buildToneCurve` — the same three calls
 * the content script makes on a film — and applied through the same
 * `feComponentTransfer` filter. The sound demo builds the Web Audio chain
 * `content/audio-engine.ts` builds, from `mapAudioStrength` at the user's own
 * strength. So a change to a setting on this page — a preset chip — changes
 * both demonstrations live, and what a visitor sees is the extension, not a
 * picture of it.
 */
import { createChromeSettingsStore, sanitizeSettings } from '../core/settings';
import { mapAudioStrength, mapVideoStrength } from '../core/strength';
import {
  buildToneCurve,
  computeSceneStats,
  createAdaptState,
  curveToTableValues,
  resolveCurve,
  updateAdaptState,
  type AdaptState,
} from '../core/tone-curve';
import { buildSoftClipCurve } from '../core/soft-clip';
import { dbToGain } from '../core/math';
import { describeMeter, lightRatio } from '../core/meter';
import {
  CUSTOM_PRESET_LINE,
  PRESET_ORDER,
  activePreset,
  presetById,
  presetPatch,
  type PresetId,
} from '../core/presets';
import { isNightTrialActive, startNightTrial } from '../core/night-trial';
import { describeClock, isWithinWindow, minutesOfDay } from '../core/schedule';
import { describeAudioEffect } from '../core/readings';
import type { Settings } from '../core/types';

const store = createChromeSettingsStore();
const localArea = (typeof chrome !== 'undefined' ? chrome.storage?.local : undefined) ?? null;

let settings: Settings = sanitizeSettings({});

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/* --------------------------------- scene --------------------------------- */

const before = byId<HTMLCanvasElement>('before');
const after = byId<HTMLCanvasElement>('after');
const sceneLabel = byId<HTMLElement>('scene-label');
const sceneReading = byId<HTMLElement>('scene-reading');
const videoMeter = byId<HTMLElement>('video-meter');
const transfer = document.getElementById('nn-welcome-transfer') as unknown as SVGElement;
const saturateNode = document.getElementById('nn-welcome-saturate') as unknown as SVGElement;
const funcs = [...transfer.querySelectorAll('feFuncR, feFuncG, feFuncB')];

const W = before.width;
const H = before.height;
const beforeCtx = before.getContext('2d') as CanvasRenderingContext2D;
const afterCtx = after.getContext('2d') as CanvasRenderingContext2D;

/** The same 48x27 read-back the content script uses to measure a frame. */
const SAMPLE_W = 48;
const SAMPLE_H = 27;
const sampler = document.createElement('canvas');
sampler.width = SAMPLE_W;
sampler.height = SAMPLE_H;
const samplerCtx = sampler.getContext('2d', {
  willReadFrequently: true,
}) as CanvasRenderingContext2D;

/**
 * A night interior with a lamp and near-black furniture, a hard cut to a snow
 * field with a blown sky, a slow fade back, and a single-frame flash: the
 * cycle the manual test bench uses, because it exercises every part of the
 * tone mapper — lift, servo, roll-off, snap, guard.
 */
function nightInterior(ctx: CanvasRenderingContext2D, intensity: number): void {
  const gradient = ctx.createLinearGradient(0, 0, W, H);
  gradient.addColorStop(0, `rgb(${2 * intensity},${3 * intensity},${6 * intensity})`);
  gradient.addColorStop(1, `rgb(${16 * intensity},${14 * intensity},${20 * intensity})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, H);
  // Furniture, at 4-24 levels: invisible on a dim screen, visible once lifted.
  for (let i = 0; i < 6; i++) {
    const level = Math.round((4 + i * 4) * intensity);
    ctx.fillStyle = `rgb(${level},${level},${level + 2})`;
    ctx.fillRect(40 + i * (W / 7), H * 0.3, W / 12, H * 0.35);
  }
  // A doorway, and a figure in it.
  const door = Math.round(30 * intensity);
  ctx.fillStyle = `rgb(${door},${Math.max(0, door - 4)},${Math.max(0, door - 8)})`;
  ctx.fillRect(W * 0.62, H * 0.18, W * 0.14, H * 0.62);
  const figure = Math.round(9 * intensity);
  ctx.fillStyle = `rgb(${figure},${figure},${figure + 1})`;
  ctx.fillRect(W * 0.66, H * 0.34, W * 0.06, H * 0.46);
  // One lamp, so the roll-off has something to hold down.
  const lamp = ctx.createRadialGradient(W * 0.86, H * 0.28, 2, W * 0.86, H * 0.28, 60);
  lamp.addColorStop(0, `rgba(255,214,150,${0.85 * intensity})`);
  lamp.addColorStop(1, 'rgba(255,214,150,0)');
  ctx.fillStyle = lamp;
  ctx.fillRect(0, 0, W, H);
}

function snowField(ctx: CanvasRenderingContext2D): void {
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, 'rgb(252,253,255)');
  sky.addColorStop(0.55, 'rgb(228,238,250)');
  sky.addColorStop(1, 'rgb(206,220,236)');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgb(255,255,255)';
  ctx.beginPath();
  ctx.arc(W * 0.7, H * 0.22, 42, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgb(38,44,56)';
  ctx.beginPath();
  ctx.moveTo(0, H * 0.72);
  ctx.lineTo(W * 0.3, H * 0.5);
  ctx.lineTo(W * 0.62, H * 0.78);
  ctx.lineTo(0, H * 0.95);
  ctx.closePath();
  ctx.fill();
}

const CYCLE_S = 9.4;

function paintScene(ctx: CanvasRenderingContext2D, cycle: number): string {
  ctx.clearRect(0, 0, W, H);
  if (cycle < 3.4) {
    nightInterior(ctx, 1);
    return 'night interior';
  }
  if (cycle < 6) {
    snowField(ctx);
    return 'hard cut to daylight';
  }
  if (cycle < 9) {
    const k = (cycle - 6) / 3;
    snowField(ctx);
    ctx.fillStyle = `rgba(0,0,0,${k})`;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = k;
    nightInterior(ctx, k);
    ctx.globalAlpha = 1;
    return 'fade back to night';
  }
  if (cycle < 9.08) {
    ctx.fillStyle = 'rgb(255,255,255)';
    ctx.fillRect(0, 0, W, H);
    return 'flash';
  }
  nightInterior(ctx, 1);
  return 'night interior';
}

/* ------------------------------ the real loop ----------------------------- */

let videoParams = mapVideoStrength(settings.videoStrength, settings.protectedBrightness);
let state: AdaptState = createAdaptState();
let lastFrameAt = 0;
let lastTable = '';
let lastReadingAt = 0;
const started = performance.now();

function frame(now: number): void {
  const cycle = ((now - started) / 1000) % CYCLE_S;
  const label = paintScene(beforeCtx, cycle);
  afterCtx.drawImage(before, 0, 0);

  // Measure, re-aim, advance, rebuild: `video-engine.ts` in four lines.
  const dt = lastFrameAt > 0 ? (now - lastFrameAt) / 1000 : 1 / 60;
  lastFrameAt = now;
  samplerCtx.drawImage(before, 0, 0, SAMPLE_W, SAMPLE_H);
  const stats = computeSceneStats(samplerCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data);
  state = updateAdaptState(state, stats, videoParams, dt);
  const curve = buildToneCurve(videoParams, state);
  const table = curveToTableValues(curve);
  if (table !== lastTable) {
    lastTable = table;
    for (const func of funcs) func.setAttribute('tableValues', table);
    saturateNode.setAttribute(
      'values',
      String(Math.round(resolveCurve(videoParams, state).saturation * 1000) / 1000),
    );
  }

  sceneLabel.textContent = label;
  if (now - lastReadingAt > 250) {
    lastReadingAt = now;
    const ratio = lightRatio(curve, state.histogram);
    videoMeter.textContent = describeMeter({
      held: false,
      audio: { active: false, gainDb: null },
      video: { active: !videoParams.bypass, lightRatio: ratio },
    });
    sceneReading.textContent =
      ratio === null || Math.abs(ratio - 1) < 0.015
        ? 'picture left as it is'
        : ratio >= 1.5
          ? `${ratio.toFixed(1)}× the light on screen`
          : `${Math.round((ratio - 1) * 100)}% light on screen`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* --------------------------------- sound --------------------------------- */

const playOriginal = byId<HTMLButtonElement>('play-original');
const playTreated = byId<HTMLButtonElement>('play-treated');
const levelFill = byId<HTMLElement>('level-fill');
const levelText = byId<HTMLElement>('level-text');
const soundLine = byId<HTMLElement>('sound-line');

/** Everything is scaled down to this at the sink, whatever the machine's volume is. */
const DEMO_MASTER_GAIN = 0.35;

let audioContext: AudioContext | null = null;
let playing: { stop: () => void } | null = null;

/**
 * Four seconds of test material: a whispered line at -38 dBFS for two and a
 * half seconds, a burst at full scale for a third of a second, then the room
 * again. A film mixed for a cinema does exactly this to a living room.
 */
function testSignal(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const seconds = 4;
  const buffer = ctx.createBuffer(1, sr * seconds, sr);
  const data = buffer.getChannelData(0);
  const whisper = dbToGain(-38);
  for (let i = 0; i < data.length; i++) {
    const t = i / sr;
    // A voice-like tone: 220 Hz with a couple of harmonics and a slow tremor.
    const voice =
      (Math.sin(2 * Math.PI * 220 * t) +
        0.5 * Math.sin(2 * Math.PI * 440 * t) +
        0.25 * Math.sin(2 * Math.PI * 660 * t)) /
      1.75;
    const tremor = 0.7 + 0.3 * Math.sin(2 * Math.PI * 5 * t);
    if (t < 2.5) data[i] = voice * whisper * tremor;
    else if (t < 2.85) data[i] = (Math.random() * 2 - 1) * (1 - (t - 2.5) * 0.4);
    else data[i] = voice * whisper * tremor * 0.8;
  }
  return buffer;
}

function chainFor(ctx: AudioContext, treated: boolean): { input: AudioNode; output: AudioNode } {
  const params = treated
    ? mapAudioStrength(settings.audioStrength, settings.nightEq)
    : mapAudioStrength(0);
  const pre = ctx.createGain();
  pre.gain.value = dbToGain(params.preGainDb);
  const lowShelf = ctx.createBiquadFilter();
  lowShelf.type = 'lowshelf';
  lowShelf.frequency.value = params.eq.lowShelfHz;
  lowShelf.gain.value = params.eq.lowShelfDb;
  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = params.eq.presenceHz;
  presence.Q.value = params.eq.presenceQ;
  presence.gain.value = params.eq.presenceDb;
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = params.compressor.thresholdDb;
  compressor.knee.value = params.compressor.kneeDb;
  compressor.ratio.value = params.compressor.ratio;
  compressor.attack.value = params.compressor.attack;
  compressor.release.value = params.compressor.release;
  const makeup = ctx.createGain();
  makeup.gain.value = dbToGain(params.makeupGainDb);
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = params.limiter.thresholdDb;
  limiter.knee.value = params.limiter.kneeDb;
  limiter.ratio.value = params.limiter.ratio;
  limiter.attack.value = params.limiter.attack;
  limiter.release.value = params.limiter.release;
  const trim = ctx.createGain();
  trim.gain.value = 1 / Math.max(1, params.safety.headroom);
  const shaper = ctx.createWaveShaper();
  shaper.oversample = 'none';
  shaper.curve = buildSoftClipCurve(params.safety);
  pre.connect(lowShelf);
  lowShelf.connect(presence);
  presence.connect(compressor);
  compressor.connect(makeup);
  makeup.connect(limiter);
  limiter.connect(trim);
  trim.connect(shaper);
  return { input: pre, output: shaper };
}

function play(treated: boolean): void {
  playing?.stop();
  const ctx = audioContext ?? new AudioContext();
  audioContext = ctx;
  void ctx.resume().catch(() => undefined);
  const source = ctx.createBufferSource();
  source.buffer = testSignal(ctx);
  const chain = chainFor(ctx, treated);
  const master = ctx.createGain();
  master.gain.value = DEMO_MASTER_GAIN;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const buffer = new Float32Array(analyser.fftSize);
  source.connect(chain.input);
  chain.output.connect(master);
  master.connect(analyser);
  analyser.connect(ctx.destination);
  source.start();

  let raf = 0;
  const startedAt = ctx.currentTime;
  const tick = (): void => {
    analyser.getFloatTimeDomainData(buffer);
    let peak = 0;
    for (const value of buffer) peak = Math.max(peak, Math.abs(value));
    // Reported before the master gain, so the figure is the chain's own output.
    const db = 20 * Math.log10(Math.max(peak / DEMO_MASTER_GAIN, 1e-5));
    const t = ctx.currentTime - startedAt;
    levelFill.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
    levelText.textContent = `${db > -59 ? db.toFixed(0) : '−60'} dB`;
    if (t < 2.5) soundLine.textContent = treated ? 'The whisper, brought up' : 'The whisper, as mixed';
    else if (t < 3) soundLine.textContent = treated ? 'The burst, held at the peak it already had' : 'The burst';
    else soundLine.textContent = 'Back to the room';
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  const stop = (): void => {
    cancelAnimationFrame(raf);
    try {
      source.stop();
    } catch {
      /* already ended */
    }
    source.disconnect();
    levelFill.style.width = '0%';
    levelText.textContent = '—';
    playing = null;
    playOriginal.disabled = false;
    playTreated.disabled = false;
  };
  source.onended = stop;
  playing = { stop };
  playOriginal.disabled = true;
  playTreated.disabled = true;
}

playOriginal.addEventListener('click', () => play(false));
playTreated.addEventListener('click', () => play(true));

/* -------------------------------- presets -------------------------------- */

const chips = byId<HTMLElement>('chips');
const presetLine = byId<HTMLElement>('preset-line');
let pointed: PresetId | null = null;

function renderPresets(): void {
  const active = activePreset(settings);
  for (const chip of chips.querySelectorAll<HTMLButtonElement>('.chip')) {
    const id = chip.dataset.preset as PresetId;
    chip.setAttribute('aria-pressed', String(id === active));
    chip.title = presetById(id).sets;
  }
  const shown = pointed ?? active;
  presetLine.textContent = shown ? presetById(shown).sets : CUSTOM_PRESET_LINE;
}

for (const id of PRESET_ORDER) {
  const chip = chips.querySelector<HTMLButtonElement>(`.chip[data-preset="${id}"]`);
  if (!chip) continue;
  chip.addEventListener('click', () => {
    void store.save(presetPatch(id)).then(applySettings);
  });
  chip.addEventListener('mouseenter', () => {
    pointed = id;
    renderPresets();
  });
  chip.addEventListener('mouseleave', () => {
    if (pointed === id) pointed = null;
    renderPresets();
  });
}

/* ------------------------------- try it now ------------------------------- */

const trySection = document.querySelector('.try') as HTMLElement;
const tryCopy = byId<HTMLElement>('try-copy');
const tryNow = byId<HTMLButtonElement>('try-now');
const tryNote = byId<HTMLElement>('try-note');
let trial = false;

function renderTry(): void {
  const hours = `${describeClock(settings.nightStart)} to ${describeClock(settings.nightEnd)}`;
  if (!settings.nightOnly) {
    trySection.dataset.state = 'running';
    tryCopy.textContent = trial
      ? `Only at night is off for a look. It comes back — ${hours} — when Chrome next starts; the popup can put it back sooner.`
      : 'Only at night is off, so it runs whenever the extension is on. Open any page with a video and press play.';
    tryNow.hidden = true;
    tryNote.textContent = 'Running now — open a video.';
    return;
  }
  const inside = isWithinWindow(minutesOfDay(new Date()), settings.nightStart, settings.nightEnd);
  if (inside) {
    trySection.dataset.state = 'running';
    tryCopy.textContent = `By default it only runs from ${hours}, or whenever a light sensor says the room is dark. It is inside those hours now.`;
    tryNow.hidden = true;
    tryNote.textContent = 'Running now — open a video.';
    return;
  }
  trySection.dataset.state = 'waiting';
  tryCopy.textContent = `By default it only runs from ${hours}, or whenever a light sensor says the room is dark — so it is not doing anything yet. That is the point of it, and also why you might want a look now.`;
  tryNow.hidden = false;
  tryNote.textContent = `Turns Only at night off until Chrome restarts, then it is back to ${hours}.`;
}

tryNow.addEventListener('click', () => {
  if (!localArea) return;
  void startNightTrial({ local: localArea, settings: store })
    .then(() => store.load())
    .then((next) => {
      trial = true;
      applySettings(next);
    });
});

/* -------------------------------- wiring --------------------------------- */

function applySettings(next: Settings): void {
  settings = next;
  videoParams = mapVideoStrength(next.videoStrength, next.protectedBrightness);
  renderPresets();
  renderTry();
  const [lift, gap] = describeAudioEffect(next.audioStrength, next.nightEq);
  playTreated.title = `${lift} · ${gap}`;
}

async function init(): Promise<void> {
  try {
    byId<HTMLElement>('version').textContent = chrome.runtime?.getManifest?.().version ?? '';
  } catch {
    /* not an extension page */
  }
  if (localArea) trial = await isNightTrialActive(localArea);
  applySettings(await store.load());
  store.subscribe(applySettings);
  try {
    const commands = (await chrome.commands?.getAll()) ?? [];
    const toggle = commands.find((command) => command.name === 'toggle-enabled');
    const shortcut = toggle?.shortcut?.trim() ?? '';
    const line = byId<HTMLElement>('shortcut-line');
    if (/[A-Za-z0-9]/.test(shortcut)) {
      const kbd = document.createElement('kbd');
      kbd.textContent = shortcut;
      line.append(kbd, ' switches it on and off anywhere.');
    } else {
      line.textContent = 'No keyboard shortcut is set; the popup can open the page to set one.';
    }
  } catch {
    /* commands unavailable */
  }
}

void init();
