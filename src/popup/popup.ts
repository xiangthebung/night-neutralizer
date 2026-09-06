/**
 * Popup controller.
 *
 * Writes go to `chrome.storage`; content scripts observe the same key and react
 * immediately, so the popup never needs tab or scripting permissions to apply a
 * change. Slider writes are debounced because `storage.sync` rate-limits.
 *
 * The site name shown on the "turn off here" button does not come from a tab
 * permission either: each content script reports its own top-level hostname
 * with its status, and that report lives only in `chrome.storage.session`.
 *
 * Two things do not go through storage: the live meter and the Compare button.
 * Both ride a `chrome.tabs.connect` port to the tab's content scripts (see
 * `core/messages.ts`), because one has to move several times a second and the
 * other has to stop the moment this popup closes, and a setting can do neither.
 */
import { createChromeSettingsStore, sanitizeSettings, settingsEqual } from '../core/settings';
import {
  audioTransferDb,
  describeStrength,
  mapAudioStrength,
  mapVideoStrength,
} from '../core/strength';
import {
  describeAudioEffect,
  describeStaticVideoEffect,
  describeVideoEffect,
} from '../core/readings';
import { describePageEffect } from '../core/page';
import { isSiteDisabled, isSiteListFull, toggleSite } from '../core/site';
import { describeLux } from '../core/ambient';
import { describeClock, formatClock, parseClock } from '../core/schedule';
import { adaptBounds, buildToneCurve, staticAdaptState } from '../core/tone-curve';
import {
  LIVE,
  LIVE_PORT,
  MSG,
  type LiveHoldMessage,
  type LiveMeterMessage,
  type StatusQueryResponse,
} from '../core/messages';
import { describeMeter } from '../core/meter';
import {
  CUSTOM_PRESET_LINE,
  PRESET_ORDER,
  activePreset,
  presetById,
  presetPatch,
  type PresetId,
} from '../core/presets';
import { NIGHT_TRIAL_KEY, clearNightTrial, isNightTrialActive } from '../core/night-trial';
import { MAX_DISABLED_SITES, type Settings, type TabStatus } from '../core/types';

const STRENGTH_WRITE_DEBOUNCE_MS = 180;
const STATUS_POLL_MS = 1500;
const TOAST_MS = 2400;
/** Level range plotted on the audio graph. */
const AUDIO_FLOOR_DB = -60;

const store = createChromeSettingsStore();
/** Where the night trial's flag lives; absent in odd contexts, and then there is no trial. */
const localArea = (typeof chrome !== 'undefined' ? chrome.storage?.local : undefined) ?? null;

/** Grouped the way the panels are, so a new control has one obvious home. */
const el = {
  app: document.getElementById('app') as HTMLElement,
  master: document.getElementById('master') as HTMLInputElement,
  summaryDot: document.getElementById('summary-dot') as HTMLElement,
  summaryText: document.getElementById('summary-text') as HTMLElement,
  liveRow: document.getElementById('live-row') as HTMLElement,
  meter: document.getElementById('meter') as HTMLElement,
  compare: document.getElementById('compare') as HTMLButtonElement,
  chips: document.getElementById('chips') as HTMLElement,
  presetLine: document.getElementById('preset-line') as HTMLElement,
  more: document.getElementById('more') as HTMLDetailsElement,

  soundCard: document.getElementById('sound-card') as HTMLElement,
  audio: document.getElementById('audio') as HTMLInputElement,
  audioStrength: document.getElementById('audio-strength') as HTMLInputElement,
  audioStrengthValue: document.getElementById('audio-strength-value') as HTMLOutputElement,
  nightEq: document.getElementById('night-eq') as HTMLInputElement,
  skipMusic: document.getElementById('skip-music') as HTMLInputElement,

  pictureCard: document.getElementById('picture-card') as HTMLElement,
  pictureDesc: document.getElementById('picture-desc') as HTMLElement,
  /** The front-of-popup switch for the whole picture path; not a stored key. */
  picture: document.getElementById('picture') as HTMLInputElement,
  video: document.getElementById('video') as HTMLInputElement,
  images: document.getElementById('images') as HTMLInputElement,
  videoStrength: document.getElementById('video-strength') as HTMLInputElement,
  videoStrengthValue: document.getElementById('video-strength-value') as HTMLOutputElement,
  protectedBrightness: document.getElementById('protected-brightness') as HTMLInputElement,
  protectedBrightnessValue: document.getElementById(
    'protected-brightness-value',
  ) as HTMLOutputElement,
  darkMode: document.getElementById('dark-mode') as HTMLInputElement,
  pageNote: document.getElementById('page-note') as HTMLElement,

  nightOnly: document.getElementById('night-only') as HTMLInputElement,
  nightWindow: document.getElementById('night-window') as HTMLElement,
  nightStart: document.getElementById('night-start') as HTMLInputElement,
  nightEnd: document.getElementById('night-end') as HTMLInputElement,
  nightDesc: document.getElementById('night-desc') as HTMLElement,
  audioStatus: document.getElementById('audio-status') as HTMLElement,
  pictureStatus: document.getElementById('picture-status') as HTMLElement,
  audioDot: document.getElementById('audio-dot') as HTMLElement,
  pictureDot: document.getElementById('picture-dot') as HTMLElement,
  notes: document.getElementById('notes') as HTMLElement,
  siteToggle: document.getElementById('site-toggle') as HTMLButtonElement,
  siteToggleText: document.getElementById('site-toggle-text') as HTMLElement,
  skipList: document.getElementById('skip-list') as HTMLElement,
  skipListCount: document.getElementById('skip-list-count') as HTMLElement,
  skipListClear: document.getElementById('skip-list-clear') as HTMLButtonElement,
  reset: document.getElementById('reset') as HTMLButtonElement,
  resetNote: document.getElementById('reset-note') as HTMLElement,
  shortcut: document.getElementById('shortcut') as HTMLElement,
  shortcutBound: document.getElementById('shortcut-bound') as HTMLElement,
  shortcutNone: document.getElementById('shortcut-none') as HTMLElement,
  shortcutKeys: document.getElementById('shortcut-keys') as HTMLElement,
  shortcutEdit: document.getElementById('shortcut-edit') as HTMLButtonElement,
  videoCurve: document.getElementById('video-curve') as HTMLCanvasElement,
  audioCurve: document.getElementById('audio-curve') as HTMLCanvasElement,
  videoReading1: document.getElementById('video-reading-1') as HTMLElement,
  videoReading2: document.getElementById('video-reading-2') as HTMLElement,
  videoReading3: document.getElementById('video-reading-3') as HTMLElement,
  audioReading1: document.getElementById('audio-reading-1') as HTMLElement,
  audioReading2: document.getElementById('audio-reading-2') as HTMLElement,
};

const INK = {
  grid: 'rgba(140, 152, 175, 0.45)',
  band: 'rgba(232, 189, 124, 0.28)',
  line: '#e8bd7c',
  idle: 'rgba(140, 152, 175, 0.8)',
};

const ADAPTIVE_GRAPH_TITLE =
  'Original brightness left to right, resulting brightness bottom to top. The dotted diagonal is no change. The shaded band is how far the curve moves as scenes get darker or brighter.';
const STATIC_GRAPH_TITLE =
  'Original brightness left to right, resulting brightness bottom to top. The dotted diagonal is no change. This is the fixed curve a protected player gets: it cannot be measured, so the curve does not move.';

let settings: Settings = sanitizeSettings({});
let lastStatus: TabStatus | null = null;
let strengthTimer: ReturnType<typeof setTimeout> | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
/** Slider moves waiting out the debounce, merged so none is dropped. */
let pendingWrite: Partial<Settings> = {};
/** True while *Only at night* is off for a look rather than for good. */
let nightTrial = false;

function renderSettings(next: Settings): void {
  settings = next;
  el.master.checked = next.enabled;

  el.audio.checked = next.audio;
  el.audioStrength.value = String(next.audioStrength);
  el.nightEq.checked = next.nightEq;
  el.skipMusic.checked = next.skipMusic;

  el.video.checked = next.video;
  el.images.checked = next.images;
  el.picture.checked = next.video || next.images;
  el.videoStrength.value = String(next.videoStrength);
  el.protectedBrightness.value = String(next.protectedBrightness);
  el.darkMode.checked = next.darkMode;

  el.nightOnly.checked = next.nightOnly;
  el.nightStart.value = formatClock(next.nightStart);
  el.nightEnd.value = formatClock(next.nightEnd);

  renderNightWindow();
  renderLabels();
  el.app.dataset.paused = String(!next.enabled);
  renderCardStates();
  renderPresets();
  renderSiteToggle();
  renderSummary();
  renderMeter();
}

/**
 * Dim a panel whose own switch is off.
 *
 * The picture panel has no single stored flag to read: its front switch stands
 * for two, so "off" here means neither half is on. That is also why the front
 * switch is derived on every render rather than kept as state — the two halves
 * can be changed independently downstairs, and the switch has to follow them.
 */
function renderCardStates(): void {
  el.soundCard.dataset.off = String(!settings.audio);
  el.pictureCard.dataset.off = String(!settings.video && !settings.images);
}

/** The clock fields are only meaningful while the night restriction is on. */
function renderNightWindow(): void {
  el.nightWindow.hidden = !settings.nightOnly;
  renderNightDesc();
}

/**
 * The line under "Only at night" doubles as the light-sensor readout.
 *
 * It has to be honest about which signal is in charge, because the two can
 * disagree and because most installs will never see the sensor at all: Chrome
 * keeps `AmbientLightSensor` behind a flag, so "no sensor, using the clock" is
 * the normal case rather than a fault.
 */
function renderNightDesc(): void {
  if (!settings.nightOnly) {
    // "Try it now" on the welcome page: off for this browser session only, and
    // the line has to say so, or the restart that puts it back looks like a bug.
    el.nightDesc.textContent = nightTrial
      ? 'Off for a look; the hours come back when Chrome restarts'
      : 'Running whenever the extension is on';
    return;
  }

  if (settings.nightStart === settings.nightEnd) {
    el.nightDesc.textContent = 'Those times match, so the clock never stops it';
    return;
  }

  const gate = lastStatus?.gate;
  if (gate?.source === 'sensor' && gate.lux !== null) {
    el.nightDesc.textContent =
      gate.reason === 'daylight'
        ? `Light sensor: ${describeLux(gate.lux)}, too bright to bother`
        : `Light sensor: ${describeLux(gate.lux)}, dark enough`;
    return;
  }

  // The hours themselves are in the two fields directly below this line, so
  // repeating them here was one reading of the same fact twice.
  el.nightDesc.textContent =
    gate?.source === 'clock'
      ? 'No light sensor here, so the clock decides'
      : 'A dark room, or the hours below';
}

/**
 * The word, not the number.
 *
 * "45 · balanced" asked the reader to translate twice: from the digit to the
 * word beside it, and from the word to what it means for what they are
 * watching. Only the second translation is useful, and the digit is still on
 * the slider itself and in its `aria-valuetext` for anyone who wants it.
 */
function labelFor(value: number): string {
  return value === 0 ? 'Off' : describeStrength(value);
}

function paintSlider(slider: HTMLInputElement, out: HTMLOutputElement, value: number): void {
  out.textContent = labelFor(value);
  // Each slider already has a visible <label for>, so only the *value* needs an
  // accessible override: "45" alone tells a screen reader nothing useful.
  slider.setAttribute('aria-valuetext', `${value} of 100, ${describeStrength(value)}`);
  slider.style.setProperty('--fill', `${value}%`);
}

/** The one slider whose readout is the number: a brightness is a percentage. */
function paintProtectedSlider(value: number): void {
  el.protectedBrightnessValue.textContent = `${value}%`;
  el.protectedBrightness.setAttribute('aria-valuetext', `${value}% of the original brightness`);
  const min = Number(el.protectedBrightness.min) || 0;
  const max = Number(el.protectedBrightness.max) || 100;
  el.protectedBrightness.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
}

/** True when the tab in front of the user is on the fixed curve. */
function onProtectedPlayer(): boolean {
  return lastStatus?.video.mode === 'static' && settings.video;
}

/**
 * Repaint both panels' labels and thumbnails from the *pending* slider
 * positions, so the graphs track the pointer rather than the last committed
 * write.
 */
function renderLabels(): void {
  const audio = Number(el.audioStrength.value);
  const video = Number(el.videoStrength.value);
  const brightness = Number(el.protectedBrightness.value);
  paintSlider(el.audioStrength, el.audioStrengthValue, audio);
  paintSlider(el.videoStrength, el.videoStrengthValue, video);
  paintProtectedSlider(brightness);

  drawAudioCurve(audio, el.nightEq.checked);

  const [audioLine1, audioLine2] = describeAudioEffect(audio, el.nightEq.checked);
  el.audioReading1.textContent = audioLine1;
  el.audioReading2.textContent = audioLine2;
  el.audioReading2.hidden = audioLine2 === '';

  // On a protected player the adaptive curve never runs, so the graph and its
  // caption describe the fixed curve that does — computed from the same
  // setting the slider below them writes. Anything else would be a picture of
  // an effect the player in front of the user is not getting.
  const protectedPlayer = onProtectedPlayer();
  drawVideoCurve(video, protectedPlayer ? brightness : null);
  const [videoLine1, videoLine2] = protectedPlayer
    ? describeStaticVideoEffect(video, brightness)
    : describeVideoEffect(video);
  el.videoReading1.textContent = videoLine1;
  el.videoReading2.textContent = videoLine2;
  el.videoReading2.hidden = videoLine2 === '';
  el.videoReading3.textContent = protectedPlayer ? 'Fixed curve on this player' : '';
  el.videoReading3.hidden = !protectedPlayer;
  el.videoCurve.title = protectedPlayer ? STATIC_GRAPH_TITLE : ADAPTIVE_GRAPH_TITLE;
  el.pictureDesc.textContent = protectedPlayer
    ? `Protected player: fixed curve at ${brightness}% brightness`
    : 'Shadows lifted, glare pulled back';

  renderPageNote();
}

/**
 * The line under the dark mode switch.
 *
 * Rendered only while the switch is on, because it exists for the one thing in
 * the picture panel that a setting cannot tell you: which of the two paths a
 * page took is a measurement the content script makes, and the two do not look
 * alike. Every other control here is explained by the graph above it.
 */
function renderPageNote(): void {
  el.pageNote.hidden = !el.darkMode.checked;
  if (!el.darkMode.checked) return;
  el.pageNote.textContent = describePageEffect(lastStatus?.page?.dark ?? 'pending');
}

/* ------------------------------- presets --------------------------------- */

/**
 * Which chip the current settings match, and what the line under them says.
 * The line follows the pointer while a chip is hovered or focused, so "what
 * would this do?" is answered before the tap, and returns to the active
 * preset — or to "your own settings" — afterwards.
 */
let pointedPreset: PresetId | null = null;

function renderPresets(): void {
  const active = activePreset(settings);
  for (const chip of el.chips.querySelectorAll<HTMLButtonElement>('.chip')) {
    const id = chip.dataset.preset as PresetId;
    chip.setAttribute('aria-pressed', String(id === active));
    chip.title = presetById(id).sets;
  }
  const shown = pointedPreset ?? active;
  el.presetLine.textContent = shown ? presetById(shown).sets : CUSTOM_PRESET_LINE;
}

for (const id of PRESET_ORDER) {
  const chip = el.chips.querySelector<HTMLButtonElement>(`.chip[data-preset="${id}"]`);
  if (!chip) continue;
  chip.addEventListener('click', () => {
    const patch = presetPatch(id);
    persist(patch);
    renderSettings(settings);
    toast(`${presetById(id).name} applied.`);
  });
  const point = (): void => {
    pointedPreset = id;
    renderPresets();
  };
  const unpoint = (): void => {
    if (pointedPreset === id) pointedPreset = null;
    renderPresets();
  };
  chip.addEventListener('mouseenter', point);
  chip.addEventListener('focus', point);
  chip.addEventListener('mouseleave', unpoint);
  chip.addEventListener('blur', unpoint);
}

/* -------------------------------- graphs --------------------------------- */

/** Logical drawing width. The backing store is larger for hidpi crispness. */
const PLOT_WIDTH = 136;
const PLOT_PAD = 4;

/**
 * Shared canvas setup: scale to logical units, clear, and return a padded
 * coordinate mapper. Both graphs are drawn in a fixed 136-unit-wide space
 * whatever the element's real pixel size, so line weights and padding stay
 * consistent; the logical height follows the canvas aspect ratio so the markup
 * can change the shape of the thumbnails without touching this code.
 */
function plot(canvas: HTMLCanvasElement): {
  ctx: CanvasRenderingContext2D;
  x: (t: number) => number;
  y: (t: number) => number;
} | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const scale = canvas.width / PLOT_WIDTH;
  const height = canvas.height / scale;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, PLOT_WIDTH, height);
  return {
    ctx,
    x: (t) => PLOT_PAD + t * (PLOT_WIDTH - PLOT_PAD * 2),
    y: (t) => height - PLOT_PAD - t * (height - PLOT_PAD * 2),
  };
}

function strokeIdentity(
  ctx: CanvasRenderingContext2D,
  x: (t: number) => number,
  y: (t: number) => number,
): void {
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = INK.grid;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x(0), y(0));
  ctx.lineTo(x(1), y(1));
  ctx.stroke();
  ctx.setLineDash([]);
}

function tracePath(
  ctx: CanvasRenderingContext2D,
  curve: readonly number[],
  x: (t: number) => number,
  y: (t: number) => number,
): void {
  curve.forEach((value, index) => {
    const px = x(index / (curve.length - 1));
    const py = y(value);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
}

/**
 * Draw the video tone curve for the selected strength against the identity
 * diagonal, as a band between the two ends of the adaptive range (bright scene
 * to dark scene). It calls the same `buildToneCurve()` the content script uses,
 * so the thumbnail is the real shape of the effect, and its width is a real
 * indication of how much the curve moves as scenes change.
 *
 * With `protectedBrightness` given, the graph is the fixed curve instead: one
 * line, shaded against the diagonal, and no band — a protected player's curve
 * does not move.
 */
function drawVideoCurve(strength: number, protectedBrightness: number | null): void {
  const frame = plot(el.videoCurve);
  if (!frame) return;
  const { ctx, x, y } = frame;

  strokeIdentity(ctx, x, y);

  if (protectedBrightness !== null) {
    const params = mapVideoStrength(strength, protectedBrightness);
    const fixed = buildToneCurve(params, staticAdaptState(params), 65);
    ctx.beginPath();
    tracePath(ctx, fixed, x, y);
    for (let index = fixed.length - 1; index >= 0; index--) {
      const t = index / (fixed.length - 1);
      ctx.lineTo(x(t), y(t));
    }
    ctx.closePath();
    ctx.fillStyle = INK.band;
    ctx.fill();
    ctx.beginPath();
    tracePath(ctx, fixed, x, y);
    ctx.strokeStyle = strength === 0 ? INK.idle : INK.line;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.stroke();
    return;
  }

  const params = mapVideoStrength(strength);
  const bounds = adaptBounds(params);
  const dark = buildToneCurve(params, bounds.dark, 65);
  const bright = buildToneCurve(params, bounds.bright, 65);

  // Band between the dark-scene and bright-scene curves.
  ctx.beginPath();
  tracePath(ctx, dark, x, y);
  for (let index = bright.length - 1; index >= 0; index--) {
    ctx.lineTo(x(index / (bright.length - 1)), y(bright[index] as number));
  }
  ctx.closePath();
  ctx.fillStyle = INK.band;
  ctx.fill();

  // The dark-scene curve, i.e. the effect at its most engaged.
  ctx.beginPath();
  tracePath(ctx, dark, x, y);
  ctx.strokeStyle = strength === 0 ? INK.idle : INK.line;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

/**
 * Draw the audio side the same way: input level along x, output level along y,
 * both in dBFS from -60 up to 0, with the shaded area showing how far the chain
 * moves the signal. Quiet input rises above the diagonal, loud input is held
 * below it, and the flat top is the limiter.
 *
 * The numbers come from `audioTransferDb()`, which models the settled response
 * of the real parameters. It is not a measurement: transients land above this
 * line, which is what the caption says.
 */
function drawAudioCurve(strength: number, nightEq: boolean): void {
  const frame = plot(el.audioCurve);
  if (!frame) return;
  const { ctx, x, y } = frame;

  const params = mapAudioStrength(strength, nightEq);
  const steps = 64;
  const toDb = (t: number): number => AUDIO_FLOOR_DB + t * -AUDIO_FLOOR_DB;
  const toUnit = (db: number): number =>
    Math.min(1, Math.max(0, (db - AUDIO_FLOOR_DB) / -AUDIO_FLOOR_DB));
  const points: Array<[number, number]> = [];
  for (let index = 0; index <= steps; index++) {
    const t = index / steps;
    points.push([x(t), y(toUnit(audioTransferDb(params, toDb(t))))]);
  }

  strokeIdentity(ctx, x, y);

  // Shade between the transfer curve and unity, so the amount of gain (or
  // reduction) at each input level is the visible quantity.
  ctx.beginPath();
  points.forEach(([px, py], index) => {
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  for (let index = steps; index >= 0; index--) {
    const t = index / steps;
    ctx.lineTo(x(t), y(t));
  }
  ctx.closePath();
  ctx.fillStyle = INK.band;
  ctx.fill();

  ctx.beginPath();
  points.forEach(([px, py], index) => {
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.strokeStyle = params.bypass ? INK.idle : INK.line;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

/* -------------------------------- writes --------------------------------- */

function persist(patch: Partial<Settings>): void {
  settings = sanitizeSettings({ ...settings, ...patch });
  void store.save(patch);
}

function toast(message: string): void {
  el.resetNote.textContent = message;
  el.resetNote.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastTimer = null;
    el.resetNote.hidden = true;
  }, TOAST_MS);
}

/**
 * Debounced slider write; the label and graphs update on every input event.
 *
 * Patches accumulate rather than replace, because there are two sliders and one
 * timer: dragging the sound slider and then the picture slider inside the
 * debounce window used to write only the second of them.
 */
function queueWrite(patch: Partial<Settings>): void {
  pendingWrite = { ...pendingWrite, ...patch };
  renderLabels();
  if (strengthTimer) clearTimeout(strengthTimer);
  strengthTimer = setTimeout(() => {
    strengthTimer = null;
    const next = pendingWrite;
    pendingWrite = {};
    persist(next);
    renderPresets();
  }, STRENGTH_WRITE_DEBOUNCE_MS);
}

el.master.addEventListener('change', () => {
  el.app.dataset.paused = String(!el.master.checked);
  persist({ enabled: el.master.checked });
  renderSummary();
  renderMeter();
});

el.audio.addEventListener('change', () => {
  persist({ audio: el.audio.checked });
  renderCardStates();
  renderPresets();
  renderSummary();
});
el.nightEq.addEventListener('change', () => {
  persist({ nightEq: el.nightEq.checked });
  renderLabels(); // the audio graph shape depends on it
  renderPresets();
});
el.skipMusic.addEventListener('change', () => persist({ skipMusic: el.skipMusic.checked }));

/**
 * The front switch for the picture, standing for both halves of the path.
 *
 * Off means off: neither moving pictures nor stills. On means both, rather
 * than whichever pair happened to be set last — restoring a remembered
 * combination would make one switch produce two different results from the
 * same visible state, and the two halves are one click away downstairs for
 * anyone who wants them apart.
 */
el.picture.addEventListener('change', () => {
  const on = el.picture.checked;
  el.video.checked = on;
  el.images.checked = on;
  persist({ video: on, images: on });
  renderCardStates();
  renderPresets();
  renderSummary();
});

el.video.addEventListener('change', () => {
  persist({ video: el.video.checked });
  el.picture.checked = el.video.checked || el.images.checked;
  renderCardStates();
  renderPresets();
  renderSummary();
});
el.images.addEventListener('change', () => {
  persist({ images: el.images.checked });
  el.picture.checked = el.video.checked || el.images.checked;
  renderCardStates();
  renderPresets();
  renderSummary();
});
el.darkMode.addEventListener('change', () => {
  persist({ darkMode: el.darkMode.checked });
  renderPageNote();
  renderPresets();
});

el.nightOnly.addEventListener('change', () => {
  // A hand on the switch is a decision; a trial that would flip it back at
  // the next start is not wanted any more, whichever way the switch went.
  nightTrial = false;
  if (localArea) void clearNightTrial(localArea);
  persist({ nightOnly: el.nightOnly.checked });
  renderNightWindow();
  renderSummary();
});

/**
 * Remember whether the disclosure was left open.
 *
 * In `localStorage` rather than in settings: it describes this popup on this
 * machine, not how anything is processed, and syncing it to another profile
 * would be surprising. Storage can throw when the profile blocks it, and a
 * disclosure that forgets its state is not worth failing the popup over.
 */
const MORE_OPEN_KEY = 'nn:more-open';

el.more.addEventListener('toggle', () => {
  try {
    localStorage.setItem(MORE_OPEN_KEY, el.more.open ? '1' : '0');
  } catch {
    /* storage unavailable: the disclosure simply opens closed next time */
  }
});

/**
 * A time input can hold an incomplete or empty value, and Chrome reports both as
 * an empty string. Rather than write a garbage window, the field is put back to
 * what is actually stored.
 */
function onClockChange(input: HTMLInputElement, key: 'nightStart' | 'nightEnd'): void {
  const minutes = parseClock(input.value);
  if (minutes === null) {
    input.value = formatClock(settings[key]);
    return;
  }
  persist({ [key]: minutes });
  renderNightDesc();
}

el.nightStart.addEventListener('change', () => onClockChange(el.nightStart, 'nightStart'));
el.nightEnd.addEventListener('change', () => onClockChange(el.nightEnd, 'nightEnd'));

el.audioStrength.addEventListener('input', () =>
  queueWrite({ audioStrength: Number(el.audioStrength.value) }),
);
el.videoStrength.addEventListener('input', () =>
  queueWrite({ videoStrength: Number(el.videoStrength.value) }),
);
el.protectedBrightness.addEventListener('input', () =>
  queueWrite({ protectedBrightness: Number(el.protectedBrightness.value) }),
);

el.reset.addEventListener('click', () => {
  void store.reset().then((next) => {
    renderSettings(next);
    toast('Defaults restored.');
  });
});

el.siteToggle.addEventListener('click', () => {
  const site = lastStatus?.site;
  if (!site) return;
  const currentlyDisabled = isSiteDisabled(settings.disabledSites, [site]);
  const disabledSites = toggleSite(settings.disabledSites, site, !currentlyDisabled);
  // `toggleSite` refuses to add past the cap rather than deleting one of the
  // user's existing entries to make room, so the click can legitimately change
  // nothing. Saying so is the whole point of the refusal: the previous
  // behaviour toasted "Left alone on ..." over a list that did not contain the
  // site. The row below offers the way out.
  if (!currentlyDisabled && !isSiteDisabled(disabledSites, [site])) {
    toast(`Skip list is full at ${MAX_DISABLED_SITES} sites. Clear it below first.`);
    return;
  }
  persist({ disabledSites });
  renderSiteToggle();
  toast(currentlyDisabled ? `Back on for ${site}.` : `Left alone on ${site}.`);
});

el.skipListClear.addEventListener('click', () => {
  const count = settings.disabledSites.length;
  if (count === 0) return;
  persist({ disabledSites: [] });
  renderSiteToggle();
  toast(count === 1 ? 'Skip list cleared.' : `Skip list cleared (${count} sites).`);
});

el.shortcutEdit.addEventListener('click', () => {
  // Chrome does not allow linking to chrome:// URLs from a page, but an
  // extension may open one in a tab.
  if (!chrome.tabs?.create) return;
  void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(() => undefined);
});

function renderSiteToggle(): void {
  renderSkipList();
  const site = lastStatus?.site ?? '';
  if (!site) {
    el.siteToggle.hidden = true;
    return;
  }
  const disabled = isSiteDisabled(settings.disabledSites, [site]);
  el.siteToggle.hidden = false;
  el.siteToggle.dataset.state = disabled ? 'excluded' : 'included';
  // A toggle button with a stable label and a pressed state, rather than a label
  // that flips between "turn off" and "turn back on": the accent styling and the
  // status lines below already say which way round it currently is, and a stable
  // label keeps the hostname readable in the space available.
  el.siteToggle.setAttribute('aria-pressed', String(disabled));
  el.siteToggle.title = disabled
    ? `Night Neutralizer is leaving ${site} alone. Click to process it again.`
    : `Leave ${site} completely alone.`;
  el.siteToggleText.textContent = `Skip ${site}`;
}

/**
 * How many sites are on the skip list, and the way to empty it.
 *
 * Hidden while the list is empty, which is the state almost every install stays
 * in. It exists because the list is capped and synced: a user who reaches the
 * cap otherwise has no way to see that they have, and no way to make room short
 * of "Reset to defaults", which discards every other setting as well.
 */
function renderSkipList(): void {
  const count = settings.disabledSites.length;
  el.skipList.hidden = count === 0;
  if (count === 0) return;
  const sites = count === 1 ? '1 site' : `${count} sites`;
  el.skipListCount.textContent = isSiteListFull(settings.disabledSites)
    ? `Skipping ${sites} — the list is full.`
    : `Skipping ${sites}.`;
  el.skipListClear.setAttribute('aria-label', `Clear the skip list of ${sites}`);
}

/**
 * Show the real shortcut, whatever the user has remapped it to — and say so
 * when there is none. The row used to disappear entirely on an unbound
 * command, which hid the one link that would have let the user bind it.
 */
async function renderShortcut(): Promise<void> {
  let shortcut = '';
  try {
    const commands = (await chrome.commands?.getAll()) ?? [];
    const toggle = commands.find((command) => command.name === 'toggle-enabled');
    // Unbound is reported inconsistently: sometimes an empty string, sometimes
    // whitespace. Either way, printing an empty key pill would be worse than
    // showing nothing, so require a real character.
    shortcut = toggle?.shortcut?.trim() ?? '';
  } catch {
    /* commands API unavailable: treated as unbound */
  }
  const bound = /[A-Za-z0-9]/.test(shortcut);
  el.shortcutKeys.textContent = bound ? shortcut : '';
  el.shortcutBound.hidden = !bound;
  el.shortcutNone.hidden = bound;
  el.shortcut.hidden = false;
}

// Reflect changes made elsewhere (another window, or a second popup). Our own
// writes echo back through the same channel, so identical values are ignored:
// re-rendering them would yank the slider out from under the pointer.
store.subscribe((next) => {
  if (settingsEqual(next, settings)) return;
  renderSettings(next);
});

// The trial flag can change while this popup is open — "Try it now" on the
// welcome page in another tab, or the service worker ending the trial — and
// the line under *Only at night* has to follow it rather than describe the
// state at the moment the popup opened.
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !(NIGHT_TRIAL_KEY in changes)) return;
    nightTrial = changes[NIGHT_TRIAL_KEY]?.newValue === true;
    renderNightDesc();
  });
}

/* ------------------------------- status ---------------------------------- */

/**
 * The night gate, phrased for a status line, or null when it is not the reason
 * nothing is happening.
 *
 * Read from the frames' own report rather than recomputed here: the gate is
 * decided once, in `core/gate.ts`, and a second implementation in the popup
 * would be a second thing to keep in step. A tab with no content script reports
 * no reason at all, which is why `frames` is checked.
 */
function describeNightGate(status: TabStatus, current: Settings): string | null {
  if (!current.nightOnly || status.frames === 0) return null;
  switch (status.gate.reason) {
    case 'daylight':
      return 'waiting for the room to go dark';
    case 'daytime':
      return `waiting for ${describeClock(current.nightStart)}`;
    default:
      return null;
  }
}

function describeAudio(status: TabStatus, current: Settings): [string, string] {
  if (!current.enabled) return ['Audio: paused (extension off)', 'off'];
  if (status.siteDisabled) return [`Audio: turned off on ${status.site}`, 'off'];
  const night = describeNightGate(status, current);
  if (night) return [`Audio: ${night}`, 'off'];
  if (!current.audio) return ['Audio: turned off', 'off'];
  if (current.audioStrength === 0) return ['Audio: bypassed (strength 0)', 'off'];
  if (status.frames === 0) return ['Audio: no media found on this page', 'off'];

  switch (status.audio.state) {
    case 'active':
      return [
        `Audio: compressing ${status.audio.processed} ${plural(status.audio.processed, 'player')}` +
          (current.nightEq ? ' with night EQ' : '') +
          (status.music.skipped > 0 ? `, ${status.music.skipped} left as music` : ''),
        'active',
      ];
    case 'music':
      return [
        status.music.site
          ? 'Audio: left alone, this is a music service'
          : `Audio: left alone, ${status.music.skipped} ${plural(status.music.skipped, 'player')} playing music`,
        'off',
      ];
    case 'blocked':
      return ["Audio: can't be processed on this player", 'partial'];
    case 'unsupported':
      return ['Audio: not supported in this browser', 'partial'];
    case 'bypassed':
      return ['Audio: graph attached, currently bypassed', 'partial'];
    case 'idle':
      return [
        status.mediaElements > 0
          ? 'Audio: waiting for playback to start'
          : 'Audio: no media found on this page',
        'off',
      ];
    default:
      return ['Audio: off', 'off'];
  }
}

/**
 * The picture line: moving pictures and still ones, in one line.
 *
 * Everything above the two halves — the master switch, the exclusion list, the
 * night gate, a strength of 0 — stops both at once, and repeating each of those
 * on two lines would be two ways of saying the same thing. Below them the two
 * halves genuinely differ (a video is measured, a still is not), so they are
 * reported side by side. One line rather than two is also what keeps the popup
 * inside Chrome's 600 px cap; see the comment on `.toggle-row`.
 */
function describePicture(status: TabStatus, current: Settings): [string, string] {
  if (!current.enabled) return ['Picture: paused (extension off)', 'off'];
  if (status.siteDisabled) return [`Picture: turned off on ${status.site}`, 'off'];
  const night = describeNightGate(status, current);
  if (night) return [`Picture: ${night}`, 'off'];
  if (current.videoStrength === 0) return ['Picture: bypassed (strength 0)', 'off'];
  if (status.frames === 0) return ['Picture: not available on this page', 'off'];

  const [videoText, videoState] = describeVideoPart(status, current);
  const [imageText, imageState] = describeImagePart(status, current);
  // `partial` outranks `active`: something being degraded is the more
  // informative half, and it is the half that explains a surprise.
  const state = [videoState, imageState].includes('partial')
    ? 'partial'
    : [videoState, imageState].includes('active')
      ? 'active'
      : 'off';
  return [`Picture: ${videoText} · ${imageText}`, state];
}

/**
 * Both halves are phrased tightly on purpose: the two of them plus the "Picture:"
 * prefix have to fit one 274 px line, and a wrapped status line costs 17 px of a
 * budget that has none to give.
 */
function describeVideoPart(status: TabStatus, current: Settings): [string, string] {
  if (!current.video) return ['video off', 'off'];
  if (status.video.elements === 0) return ['no video here', 'off'];
  switch (status.video.mode) {
    case 'adaptive':
      return ['adaptive tone mapping', 'active'];
    case 'static':
      return ['fixed curve, protected video', 'partial'];
    case 'idle':
      return ['waiting for playback', 'off'];
    case 'unsupported':
      return ['no tone mapping here', 'partial'];
    default:
      return ['video off', 'off'];
  }
}

/**
 * The still half never claims to be adaptive, because it never is: a picture's
 * pixels are usually cross-origin and cannot be read, so one fixed curve serves
 * every image on the page.
 */
function describeImagePart(status: TabStatus, current: Settings): [string, string] {
  if (!current.images || !status.images.active) return ['images off', 'off'];
  if (status.images.elements === 0) return ['no images here', 'off'];
  const count = status.images.elements;
  return [`${count} ${plural(count, 'image')} toned`, 'active'];
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/**
 * The whole tab in one sentence, for the line under the master switch.
 *
 * It is deliberately not a third status line: it answers "is this doing
 * anything right now", which is the only question most openings of this popup
 * are asking, and it defers to the two detailed lines — still rendered, in
 * "More options" — for the part that explains itself only when something is
 * unexpected.
 *
 * Three sentences here are the ones a first-time user meets most, and all
 * three were wrong before: a paused player read as "nothing to soften", a
 * cross-origin player whose sound cannot be routed at all read as "softening
 * the sound and picture", and a protected player was described the same way
 * as a measured one. Each now says what is happening on *this* player.
 */
function summarize(status: TabStatus | null, current: Settings): [string, string] {
  if (!current.enabled) return ['Paused', 'off'];
  if (!status) return ['Nothing to do on this page', 'off'];
  if (status.siteDisabled) return [`Left alone on ${status.site}`, 'off'];

  const night = describeNightGate(status, current);
  if (night) return [`${night.charAt(0).toUpperCase()}${night.slice(1)}`, 'off'];

  const pictureOn = current.video || current.images;
  if (!current.audio && !pictureOn) return ['Sound and picture are both off', 'off'];
  if (status.frames === 0) return ['Nothing to do on this page', 'off'];

  const soundWanted = current.audio && current.audioStrength > 0;
  const soundOn = soundWanted && status.audio.state === 'active';
  const soundBlocked = soundWanted && status.audio.state === 'blocked';
  const videoWanted = current.video && current.videoStrength > 0;
  const videoMode = videoWanted ? status.video.mode : 'off';
  const videoOn = videoMode === 'adaptive' || videoMode === 'static';
  const imagesOn =
    current.images &&
    current.videoStrength > 0 &&
    status.images.active &&
    status.images.elements > 0;
  const pictureWorking = videoOn || imagesOn;

  if (soundBlocked) {
    return pictureWorking
      ? ["Picture only — this player's sound can't be processed", 'partial']
      : ["This player's sound can't be processed", 'off'];
  }

  const working: string[] = [];
  if (soundOn) working.push('sound');
  if (pictureWorking) working.push('picture');
  if (working.length === 0) {
    // A player that has not started yet is the ordinary case for the first
    // seconds of every visit, and it is waiting, not idle.
    const waiting =
      status.mediaElements > 0 &&
      (status.audio.state === 'idle' || status.video.mode === 'idle') &&
      (soundWanted || videoWanted);
    return waiting ? ['Waiting for playback', 'idle'] : ['Nothing to soften on this page', 'off'];
  }

  const sentence = `Softening the ${working.join(' and ')}`;
  if (videoMode === 'static') return [`${sentence} · protected video`, 'partial'];
  return [sentence, 'active'];
}

function renderSummary(): void {
  const [text, state] = summarize(lastStatus, settings);
  el.summaryText.textContent = text;
  el.summaryDot.dataset.state = state;
}

function renderStatus(status: TabStatus | null): void {
  const wasProtected = onProtectedPlayer();
  lastStatus = status;
  if (!status) {
    el.audioDot.dataset.state = 'off';
    el.pictureDot.dataset.state = 'off';
    el.audioStatus.textContent = 'Audio: not available on this page';
    el.pictureStatus.textContent = 'Picture: not available on this page';
    el.notes.hidden = false;
    el.notes.textContent =
      'Browser pages (chrome://, the Web Store, other extensions) cannot be modified by extensions.';
    renderSiteToggle();
    renderNightDesc();
    renderPageNote();
    renderSummary();
    if (wasProtected) renderLabels();
    return;
  }

  const [audioText, audioState] = describeAudio(status, settings);
  const [pictureText, pictureState] = describePicture(status, settings);
  el.audioStatus.textContent = audioText;
  el.pictureStatus.textContent = pictureText;
  el.audioDot.dataset.state = audioState;
  el.pictureDot.dataset.state = pictureState;

  const notes = status.notes.filter(Boolean);
  el.notes.hidden = notes.length === 0;
  el.notes.textContent = notes.join('\n');
  renderSiteToggle();
  renderSummary();
  // The sensor readout lives in this status too, so it refreshes on the poll.
  renderNightDesc();
  // So does which of the two dark-mode paths this tab ended up on, which is a
  // measurement the content script makes rather than something the popup knows.
  renderPageNote();
  // A tab arriving on, or leaving, the fixed curve changes which curve the
  // graph and the captions have to describe.
  if (wasProtected !== onProtectedPlayer()) renderLabels();
}

async function activeTabId(): Promise<number | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id ?? null;
  } catch {
    return null;
  }
}

/* ---------------------------- the live port ------------------------------ */

let port: chrome.runtime.Port | null = null;
let portTabId: number | null = null;
/** The latest meter from the top frame, and from any other frame, if any. */
let topMeter: LiveMeterMessage | null = null;
let subMeter: LiveMeterMessage | null = null;
/** True while the Compare button is down. */
let holding = false;

function meterActive(message: LiveMeterMessage | null): boolean {
  if (!message) return false;
  const mode = message.video.mode;
  return message.audio.active || mode === 'adaptive' || mode === 'static';
}

/**
 * Open (or re-open) the port to the tab being described. Every frame of the
 * tab answers on the same port, each with its own meter; the popup shows the
 * top frame's unless only an embedded player is doing anything.
 */
function connectLive(tabId: number): void {
  if (port && portTabId === tabId) return;
  disconnectLive();
  if (typeof chrome === 'undefined' || !chrome.tabs?.connect) return;
  try {
    const next = chrome.tabs.connect(tabId, { name: LIVE_PORT });
    portTabId = tabId;
    port = next;
    next.onMessage.addListener((message: LiveMeterMessage) => {
      if (message?.type !== LIVE.METER) return;
      if (message.top) topMeter = message;
      else subMeter = message;
      renderMeter();
    });
    next.onDisconnect.addListener(() => {
      // Either the tab has no content script (a chrome:// page) or it went
      // away. `lastError` has to be read, or Chrome logs it as unchecked.
      void chrome.runtime.lastError;
      if (port === next) {
        port = null;
        portTabId = null;
      }
      topMeter = null;
      subMeter = null;
      renderMeter();
    });
    if (holding) sendHold(true);
  } catch {
    port = null;
    portTabId = null;
  }
}

function disconnectLive(): void {
  const current = port;
  port = null;
  portTabId = null;
  topMeter = null;
  subMeter = null;
  try {
    current?.disconnect();
  } catch {
    /* already gone */
  }
}

function sendHold(held: boolean): void {
  if (!port) return;
  const message: LiveHoldMessage = { type: LIVE.HOLD, held };
  try {
    port.postMessage(message);
  } catch {
    /* the port died between the check and the send; onDisconnect cleans up */
  }
}

function renderMeter(): void {
  const message = meterActive(topMeter) ? topMeter : meterActive(subMeter) ? subMeter : topMeter;
  const show = Boolean(port) && meterActive(message) && settings.enabled;
  el.liveRow.hidden = !show;
  if (!show || !message) {
    if (holding) setHolding(false);
    return;
  }
  const mode = message.video.mode;
  el.meter.textContent = describeMeter({
    held: holding || message.held,
    audio: message.audio,
    video: {
      active: mode === 'adaptive' || mode === 'static',
      lightRatio: message.video.lightRatio,
    },
  });
  el.meter.dataset.held = String(holding || message.held);
}

/**
 * Press and hold. Pointer capture keeps the release arriving even when the
 * pointer wanders off the button, and every way of losing the button — blur,
 * the popup hiding, a cancelled pointer — counts as letting go. A held Compare
 * that outlives the button is a tab left unprocessed with nothing on screen to
 * say why, so the content script also releases it when the port closes.
 */
function setHolding(next: boolean): void {
  if (holding === next) return;
  holding = next;
  el.compare.setAttribute('aria-pressed', String(next));
  el.compare.textContent = next ? 'Comparing…' : 'Hold to compare';
  sendHold(next);
  renderMeter();
}

el.compare.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  try {
    el.compare.setPointerCapture(event.pointerId);
  } catch {
    /* capture is a nicety */
  }
  setHolding(true);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
  el.compare.addEventListener(type, () => setHolding(false));
}
el.compare.addEventListener('keydown', (event) => {
  if (event.key !== ' ' && event.key !== 'Enter') return;
  event.preventDefault();
  if (!event.repeat) setHolding(true);
});
el.compare.addEventListener('keyup', (event) => {
  if (event.key === ' ' || event.key === 'Enter') setHolding(false);
});
el.compare.addEventListener('blur', () => setHolding(false));
// A click with no pointer or key behind it (assistive technology, a synthetic
// click) would otherwise leave nothing to release; make it a moment's
// comparison rather than a hold that never ends.
el.compare.addEventListener('click', (event) => {
  if (event.detail !== 0 || holding) return;
  setHolding(true);
  setTimeout(() => setHolding(false), 1500);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) setHolding(false);
});

async function pollStatus(): Promise<void> {
  const tabId = await activeTabId();
  if (tabId === null) {
    disconnectLive();
    renderStatus(null);
    renderMeter();
    return;
  }
  connectLive(tabId);
  try {
    const response = (await chrome.runtime.sendMessage({
      type: MSG.STATUS_QUERY,
      tabId,
    })) as StatusQueryResponse | undefined;
    if (!response?.status || response.status.frames === 0) {
      // No frame ever reported: either an unscriptable page or a page with no
      // media at all. Both are shown as "nothing to do here".
      renderStatus(response?.status ?? null);
    } else {
      renderStatus(response.status);
    }
  } catch {
    renderStatus(null);
  }
  renderMeter();
}

async function init(): Promise<void> {
  try {
    el.more.open = localStorage.getItem(MORE_OPEN_KEY) === '1';
  } catch {
    /* storage unavailable: start closed, which is the default anyway */
  }
  if (localArea) nightTrial = await isNightTrialActive(localArea);
  renderSettings(await store.load());
  void renderShortcut();
  void pollStatus();
  const timer = setInterval(() => void pollStatus(), STATUS_POLL_MS);
  window.addEventListener(
    'pagehide',
    () => {
      clearInterval(timer);
      setHolding(false);
      disconnectLive();
    },
    { once: true },
  );
}

void init();
