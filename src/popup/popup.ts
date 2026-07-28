/**
 * Popup controller.
 *
 * Writes go to `chrome.storage`; content scripts observe the same key and react
 * immediately, so the popup never needs tab or scripting permissions to apply a
 * change. Slider writes are debounced because `storage.sync` rate-limits.
 */
import { createChromeSettingsStore, settingsEqual } from '../core/settings';
import { describeStrength, mapVideoStrength } from '../core/strength';
import { adaptBounds, buildToneCurve } from '../core/tone-curve';
import { MSG, type StatusQueryResponse } from '../core/messages';
import { DEFAULT_SETTINGS, type Settings, type TabStatus } from '../core/types';

const STRENGTH_WRITE_DEBOUNCE_MS = 180;
const STATUS_POLL_MS = 1500;

const store = createChromeSettingsStore();

const el = {
  app: document.getElementById('app') as HTMLElement,
  master: document.getElementById('master') as HTMLInputElement,
  strength: document.getElementById('strength') as HTMLInputElement,
  strengthValue: document.getElementById('strength-value') as HTMLOutputElement,
  audio: document.getElementById('audio') as HTMLInputElement,
  video: document.getElementById('video') as HTMLInputElement,
  audioStatus: document.getElementById('audio-status') as HTMLElement,
  videoStatus: document.getElementById('video-status') as HTMLElement,
  audioDot: document.getElementById('audio-dot') as HTMLElement,
  videoDot: document.getElementById('video-dot') as HTMLElement,
  notes: document.getElementById('notes') as HTMLElement,
  reset: document.getElementById('reset') as HTMLButtonElement,
  curve: document.getElementById('curve') as HTMLCanvasElement,
};

let settings: Settings = { ...DEFAULT_SETTINGS };
let strengthTimer: ReturnType<typeof setTimeout> | null = null;

function renderSettings(next: Settings): void {
  settings = next;
  el.master.checked = next.enabled;
  el.audio.checked = next.audio;
  el.video.checked = next.video;
  el.strength.value = String(next.strength);
  renderStrengthLabel(next.strength);
  el.app.dataset.paused = String(!next.enabled);
}

function renderStrengthLabel(value: number): void {
  const label = describeStrength(value);
  el.strengthValue.textContent = value === 0 ? 'off' : `${value} · ${label.toLowerCase()}`;
  el.strength.setAttribute('aria-valuetext', `${value} of 100, ${label}`);
  el.strength.style.setProperty('--fill', `${value}%`);
  drawCurve(value);
}

/**
 * Draw the video tone curve for the selected strength against the identity
 * diagonal, as a band between the two ends of the adaptive range (bright scene
 * to dark scene). It calls the same `buildToneCurve()` the content script uses,
 * so the thumbnail is the real shape of the effect, and its width is a real
 * indication of how much the curve moves as scenes change.
 */
function drawCurve(strength: number): void {
  const canvas = el.curve;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;
  const params = mapVideoStrength(strength);
  const bounds = adaptBounds();
  const dark = buildToneCurve(params, bounds.dark, 65);
  const bright = buildToneCurve(params, bounds.bright, 65);

  ctx.clearRect(0, 0, width, height);
  const pad = 5;
  const x = (t: number) => pad + t * (width - pad * 2);
  const y = (v: number) => height - pad - v * (height - pad * 2);
  const at = (curve: readonly number[], index: number): number =>
    x(index / (curve.length - 1));

  // Identity reference.
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = 'rgba(140, 152, 175, 0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x(0), y(0));
  ctx.lineTo(x(1), y(1));
  ctx.stroke();
  ctx.setLineDash([]);

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
  ctx.fillStyle = 'rgba(232, 189, 124, 0.28)';
  ctx.fill();

  // The dark-scene curve, i.e. the effect at its most engaged.
  ctx.beginPath();
  dark.forEach((value, index) => {
    const px = at(dark, index);
    const py = y(value);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.strokeStyle = strength === 0 ? 'rgba(140, 152, 175, 0.8)' : '#e8bd7c';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function persist(patch: Partial<Settings>): void {
  settings = { ...settings, ...patch } as Settings;
  void store.save(patch);
}

el.master.addEventListener('change', () => {
  el.app.dataset.paused = String(!el.master.checked);
  persist({ enabled: el.master.checked });
});

el.audio.addEventListener('change', () => persist({ audio: el.audio.checked }));
el.video.addEventListener('change', () => persist({ video: el.video.checked }));

el.strength.addEventListener('input', () => {
  const value = Number(el.strength.value);
  renderStrengthLabel(value);
  if (strengthTimer) clearTimeout(strengthTimer);
  strengthTimer = setTimeout(() => {
    strengthTimer = null;
    persist({ strength: value });
  }, STRENGTH_WRITE_DEBOUNCE_MS);
});

el.reset.addEventListener('click', () => {
  void store.reset().then(renderSettings);
});

// Reflect changes made elsewhere (another window, or a second popup). Our own
// writes echo back through the same channel, so identical values are ignored:
// re-rendering them would yank the slider out from under the pointer.
store.subscribe((next) => {
  if (settingsEqual(next, settings)) return;
  renderSettings(next);
});

/* ------------------------------- status ---------------------------------- */

function describeAudio(status: TabStatus, current: Settings): [string, string] {
  if (!current.enabled) return ['Audio: paused (extension off)', 'off'];
  if (!current.audio) return ['Audio: turned off', 'off'];
  if (current.strength === 0) return ['Audio: bypassed (strength 0)', 'off'];
  if (status.frames === 0) return ['Audio: no media found on this page', 'off'];

  switch (status.audio.state) {
    case 'active':
      return [
        `Audio: compressing ${status.audio.processed} ${plural(status.audio.processed, 'player')}`,
        'active',
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

function describeVideo(status: TabStatus, current: Settings): [string, string] {
  if (!current.enabled) return ['Video: paused (extension off)', 'off'];
  if (!current.video) return ['Video: turned off', 'off'];
  if (current.strength === 0) return ['Video: bypassed (strength 0)', 'off'];
  if (status.frames === 0 || status.video.elements === 0)
    return ['Video: no video element on this page', 'off'];

  switch (status.video.mode) {
    case 'adaptive':
      return ['Video: adaptive tone mapping (scene analysis on)', 'active'];
    case 'static':
      return ['Video: fixed night curve (frames not readable)', 'partial'];
    case 'unsupported':
      return ['Video: tone mapping unavailable here', 'partial'];
    default:
      return ['Video: off', 'off'];
  }
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function renderStatus(status: TabStatus | null): void {
  if (!status) {
    el.audioDot.dataset.state = 'off';
    el.videoDot.dataset.state = 'off';
    el.audioStatus.textContent = 'Audio: not available on this page';
    el.videoStatus.textContent = 'Video: not available on this page';
    el.notes.hidden = false;
    el.notes.textContent =
      'Browser pages (chrome://, the Web Store, other extensions) cannot be modified by extensions.';
    return;
  }

  const [audioText, audioState] = describeAudio(status, settings);
  const [videoText, videoState] = describeVideo(status, settings);
  el.audioStatus.textContent = audioText;
  el.videoStatus.textContent = videoText;
  el.audioDot.dataset.state = audioState;
  el.videoDot.dataset.state = videoState;

  const notes = status.notes.filter(Boolean);
  el.notes.hidden = notes.length === 0;
  el.notes.textContent = notes.join('\n');
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
  void pollStatus();
  const timer = setInterval(() => void pollStatus(), STATUS_POLL_MS);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}

void init();
