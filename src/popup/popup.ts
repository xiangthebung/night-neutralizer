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
 */
import { createChromeSettingsStore, sanitizeSettings, settingsEqual } from '../core/settings';
import {
  audioStrengthOf,
  audioTransferDb,
  describeStrength,
  mapAudioStrength,
  mapVideoStrength,
  videoStrengthOf,
} from '../core/strength';
import { describeAudioEffect, describeVideoEffect } from '../core/readings';
import { isSiteDisabled, toggleSite } from '../core/site';
import { describeLux } from '../core/ambient';
import { describeClock, describeWindow, formatClock, parseClock } from '../core/schedule';
import { adaptBounds, buildToneCurve } from '../core/tone-curve';
import { MSG, type StatusQueryResponse } from '../core/messages';
import type { Settings, TabStatus } from '../core/types';

const STRENGTH_WRITE_DEBOUNCE_MS = 180;
const STATUS_POLL_MS = 1500;
const TOAST_MS = 2400;
/** Level range plotted on the audio graph. */
const AUDIO_FLOOR_DB = -60;

const store = createChromeSettingsStore();

const el = {
  app: document.getElementById('app') as HTMLElement,
  master: document.getElementById('master') as HTMLInputElement,
  strength: document.getElementById('strength') as HTMLInputElement,
  strengthValue: document.getElementById('strength-value') as HTMLOutputElement,
  linkedRow: document.getElementById('linked-row') as HTMLElement,
  split: document.getElementById('split') as HTMLElement,
  linkToggle: document.getElementById('link-toggle') as HTMLButtonElement,
  audioStrength: document.getElementById('audio-strength') as HTMLInputElement,
  audioStrengthValue: document.getElementById('audio-strength-value') as HTMLOutputElement,
  videoStrength: document.getElementById('video-strength') as HTMLInputElement,
  videoStrengthValue: document.getElementById('video-strength-value') as HTMLOutputElement,
  audio: document.getElementById('audio') as HTMLInputElement,
  video: document.getElementById('video') as HTMLInputElement,
  images: document.getElementById('images') as HTMLInputElement,
  nightEq: document.getElementById('night-eq') as HTMLInputElement,
  skipMusic: document.getElementById('skip-music') as HTMLInputElement,
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
  reset: document.getElementById('reset') as HTMLButtonElement,
  resetNote: document.getElementById('reset-note') as HTMLElement,
  shortcut: document.getElementById('shortcut') as HTMLElement,
  shortcutKeys: document.getElementById('shortcut-keys') as HTMLElement,
  shortcutEdit: document.getElementById('shortcut-edit') as HTMLButtonElement,
  curve: document.getElementById('curve') as HTMLCanvasElement,
  audioCurve: document.getElementById('audio-curve') as HTMLCanvasElement,
  videoReading1: document.getElementById('video-reading-1') as HTMLElement,
  videoReading2: document.getElementById('video-reading-2') as HTMLElement,
  audioReading1: document.getElementById('audio-reading-1') as HTMLElement,
  audioReading2: document.getElementById('audio-reading-2') as HTMLElement,
};

const INK = {
  grid: 'rgba(140, 152, 175, 0.45)',
  band: 'rgba(232, 189, 124, 0.28)',
  line: '#e8bd7c',
  idle: 'rgba(140, 152, 175, 0.8)',
};

let settings: Settings = sanitizeSettings({});
let lastStatus: TabStatus | null = null;
let strengthTimer: ReturnType<typeof setTimeout> | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function renderSettings(next: Settings): void {
  settings = next;
  el.master.checked = next.enabled;
  el.audio.checked = next.audio;
  el.video.checked = next.video;
  el.images.checked = next.images;
  el.nightEq.checked = next.nightEq;
  el.skipMusic.checked = next.skipMusic;
  el.nightOnly.checked = next.nightOnly;
  el.nightStart.value = formatClock(next.nightStart);
  el.nightEnd.value = formatClock(next.nightEnd);
  el.strength.value = String(next.strength);
  el.audioStrength.value = String(next.audioStrength);
  el.videoStrength.value = String(next.videoStrength);
  renderLinkMode(next.linked);
  renderNightWindow();
  renderLabels();
  el.app.dataset.paused = String(!next.enabled);
  renderSiteToggle();
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
    el.nightDesc.textContent = 'Running whenever the extension is on';
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

  el.nightDesc.textContent =
    gate?.source === 'clock'
      ? 'No light sensor here, so the clock decides'
      : `A dark room, or ${describeWindow(settings.nightStart, settings.nightEnd)}`;
}

/** Show either the single slider or the pair, never both. */
function renderLinkMode(linked: boolean): void {
  el.linkedRow.hidden = !linked;
  el.strength.hidden = !linked;
  el.split.hidden = linked;
  el.linkToggle.textContent = linked
    ? 'Set audio and video separately'
    : 'Use one slider for both';
  el.linkToggle.setAttribute('aria-pressed', String(!linked));
}

function labelFor(value: number): string {
  return value === 0 ? 'off' : `${value} · ${describeStrength(value).toLowerCase()}`;
}

function paintSlider(slider: HTMLInputElement, out: HTMLOutputElement, value: number): void {
  out.textContent = labelFor(value);
  // Each slider already has a visible <label for>, so only the *value* needs an
  // accessible override: "45" alone tells a screen reader nothing useful.
  slider.setAttribute('aria-valuetext', `${value} of 100, ${describeStrength(value)}`);
  slider.style.setProperty('--fill', `${value}%`);
}

/**
 * Repaint every label and both thumbnails from the *pending* slider positions,
 * so the graphs track the pointer rather than the last committed write.
 */
function renderLabels(): void {
  const strength = Number(el.strength.value);
  paintSlider(el.strength, el.strengthValue, strength);
  paintSlider(el.audioStrength, el.audioStrengthValue, Number(el.audioStrength.value));
  paintSlider(el.videoStrength, el.videoStrengthValue, Number(el.videoStrength.value));

  const linked = el.split.hidden;
  const audio = linked ? strength : Number(el.audioStrength.value);
  const video = linked ? strength : Number(el.videoStrength.value);
  drawCurve(video);
  drawAudioCurve(audio, el.nightEq.checked);

  const [videoLine1, videoLine2] = describeVideoEffect(video);
  el.videoReading1.textContent = videoLine1;
  el.videoReading2.textContent = videoLine2;
  el.videoReading2.hidden = videoLine2 === '';

  const [audioLine1, audioLine2] = describeAudioEffect(audio, el.nightEq.checked);
  el.audioReading1.textContent = audioLine1;
  el.audioReading2.textContent = audioLine2;
  el.audioReading2.hidden = audioLine2 === '';
}



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

/**
 * Draw the video tone curve for the selected strength against the identity
 * diagonal, as a band between the two ends of the adaptive range (bright scene
 * to dark scene). It calls the same `buildToneCurve()` the content script uses,
 * so the thumbnail is the real shape of the effect, and its width is a real
 * indication of how much the curve moves as scenes change.
 */
function drawCurve(strength: number): void {
  const frame = plot(el.curve);
  if (!frame) return;
  const { ctx, x, y } = frame;

  const params = mapVideoStrength(strength);
  const bounds = adaptBounds(params);
  const dark = buildToneCurve(params, bounds.dark, 65);
  const bright = buildToneCurve(params, bounds.bright, 65);
  const at = (curve: readonly number[], index: number): number => x(index / (curve.length - 1));

  strokeIdentity(ctx, x, y);

  // Band between the dark-scene and bright-scene curves.
  ctx.beginPath();
  dark.forEach((value, index) => {
    const px = at(dark, index);
    const py = y(value);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  for (let index = bright.length - 1; index >= 0; index--) {
    ctx.lineTo(at(bright, index), y(bright[index] as number));
  }
  ctx.closePath();
  ctx.fillStyle = INK.band;
  ctx.fill();

  // The dark-scene curve, i.e. the effect at its most engaged.
  ctx.beginPath();
  dark.forEach((value, index) => {
    const px = at(dark, index);
    const py = y(value);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
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

/** Debounced slider write; the label and graphs update on every input event. */
function onSliderInput(patch: () => Partial<Settings>): void {
  renderLabels();
  if (strengthTimer) clearTimeout(strengthTimer);
  strengthTimer = setTimeout(() => {
    strengthTimer = null;
    persist(patch());
  }, STRENGTH_WRITE_DEBOUNCE_MS);
}

el.master.addEventListener('change', () => {
  el.app.dataset.paused = String(!el.master.checked);
  persist({ enabled: el.master.checked });
});

el.audio.addEventListener('change', () => persist({ audio: el.audio.checked }));
el.video.addEventListener('change', () => persist({ video: el.video.checked }));
el.images.addEventListener('change', () => persist({ images: el.images.checked }));
el.nightEq.addEventListener('change', () => {
  persist({ nightEq: el.nightEq.checked });
  renderLabels(); // the audio graph shape depends on it
});
el.skipMusic.addEventListener('change', () => persist({ skipMusic: el.skipMusic.checked }));

el.nightOnly.addEventListener('change', () => {
  persist({ nightOnly: el.nightOnly.checked });
  renderNightWindow();
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

el.strength.addEventListener('input', () =>
  onSliderInput(() => {
    const value = Number(el.strength.value);
    // Keep the per-channel values in step while linked, so unlinking later
    // starts from what you were actually listening to.
    return { strength: value, audioStrength: value, videoStrength: value };
  }),
);
el.audioStrength.addEventListener('input', () =>
  onSliderInput(() => ({ audioStrength: Number(el.audioStrength.value) })),
);
el.videoStrength.addEventListener('input', () =>
  onSliderInput(() => ({ videoStrength: Number(el.videoStrength.value) })),
);

el.linkToggle.addEventListener('click', () => {
  const linked = !settings.linked;
  if (linked) {
    // Re-linking has to choose one number out of two. The midpoint is the least
    // surprising option: it is visible in the slider straight away and neither
    // half jumps to a value the user never chose.
    const merged = Math.round((settings.audioStrength + settings.videoStrength) / 2);
    el.strength.value = String(merged);
    persist({ linked, strength: merged, audioStrength: merged, videoStrength: merged });
    el.audioStrength.value = String(merged);
    el.videoStrength.value = String(merged);
  } else {
    persist({ linked });
  }
  renderLinkMode(linked);
  renderLabels();
});

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
  persist({ disabledSites });
  renderSiteToggle();
  toast(currentlyDisabled ? `Back on for ${site}.` : `Left alone on ${site}.`);
});

el.shortcutEdit.addEventListener('click', () => {
  // Chrome does not allow linking to chrome:// URLs from a page, but an
  // extension may open one in a tab.
  if (!chrome.tabs?.create) return;
  void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(() => undefined);
});

function renderSiteToggle(): void {
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

/** Show the real shortcut, whatever the user has remapped it to. */
async function renderShortcut(): Promise<void> {
  try {
    const commands = (await chrome.commands?.getAll()) ?? [];
    const toggle = commands.find((command) => command.name === 'toggle-enabled');
    // Unbound is reported inconsistently: sometimes an empty string, sometimes
    // whitespace. Either way, printing an empty key pill would be worse than
    // showing nothing, so require a real character.
    const shortcut = toggle?.shortcut?.trim() ?? '';
    // Require a printable key name: an empty pill next to "toggles it anywhere"
    // is worse than no hint at all.
    if (!/[A-Za-z0-9]/.test(shortcut)) return;
    el.shortcutKeys.textContent = shortcut;
    el.shortcut.hidden = false;
  } catch {
    /* commands API unavailable: leave the hint hidden */
  }
}

// Reflect changes made elsewhere (another window, or a second popup). Our own
// writes echo back through the same channel, so identical values are ignored:
// re-rendering them would yank the slider out from under the pointer.
store.subscribe((next) => {
  if (settingsEqual(next, settings)) return;
  renderSettings(next);
});

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
  if (audioStrengthOf(current) === 0) return ['Audio: bypassed (strength 0)', 'off'];
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
      return ['Audio: left untouched on this player', 'partial'];
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
  if (videoStrengthOf(current) === 0) return ['Picture: bypassed (strength 0)', 'off'];
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
      return ['fixed night curve', 'partial'];
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

function renderStatus(status: TabStatus | null): void {
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
  // The sensor readout lives in this status too, so it refreshes on the poll.
  renderNightDesc();
}

async function activeTabId(): Promise<number | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function pollStatus(): Promise<void> {
  const tabId = await activeTabId();
  if (tabId === null) {
    renderStatus(null);
    return;
  }
  try {
    const response = (await chrome.runtime.sendMessage({
      type: MSG.STATUS_QUERY,
      tabId,
    })) as StatusQueryResponse | undefined;
    if (!response?.status || response.status.frames === 0) {
      // No frame ever reported: either an unscriptable page or a page with no
      // media at all. Both are shown as "nothing to do here".
      renderStatus(response?.status ?? null);
      return;
    }
    renderStatus(response.status);
  } catch {
    renderStatus(null);
  }
}

async function init(): Promise<void> {
  renderSettings(await store.load());
  void renderShortcut();
  void pollStatus();
  const timer = setInterval(() => void pollStatus(), STATUS_POLL_MS);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}

void init();
