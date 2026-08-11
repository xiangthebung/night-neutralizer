/**
 * Test-bench wiring. Generates the video stream and the audio clip at runtime,
 * and provides buttons for the media-lifecycle cases.
 */
/* global startScene */

const log = (message) => {
  const el = document.getElementById('log');
  el.textContent = `${new Date().toLocaleTimeString()}  ${message}\n${el.textContent}`
    .split('\n')
    .slice(0, 6)
    .join('\n');
};

/* ---------------------------------------------------------------- video ---- */

const source = document.getElementById('source');
startScene(source);

const scene = document.getElementById('scene');
scene.srcObject = source.captureStream(30);
scene.play().catch(() => log('autoplay blocked; press "Play video"'));

document.getElementById('play-video').addEventListener('click', () => {
  scene.play().catch((error) => log(`play failed: ${error}`));
});
document.getElementById('pause-video').addEventListener('click', () => scene.pause());
document.getElementById('fullscreen').addEventListener('click', () => {
  scene.requestFullscreen?.().catch((error) => log(`fullscreen failed: ${error}`));
});

/* ------------------------------------------------- static test pattern ---- */

/**
 * A fixed 32-step grey ramp plus solid black and white patches. Redrawn twice a
 * second so the capture stream keeps producing frames, but visually constant,
 * which makes before/after pixel comparisons meaningful.
 *
 * Drawn twice: at full range (reads as a normal scene, must stay essentially
 * untouched) and scaled down to 30% (reads as a dark scene, must get its
 * shadows lifted). The pair is what pins the scene gating at the pixel level.
 */
const wedgeCanvas = document.getElementById('wedge-source');
const wedgeCtx = wedgeCanvas.getContext('2d');
const nightWedgeCanvas = document.getElementById('night-wedge-source');
const nightWedgeCtx = nightWedgeCanvas.getContext('2d');
const NIGHT_WEDGE_SCALE = 0.3;

function drawWedgePattern(ctx, canvas, scale = 1) {
  const { width, height } = canvas;
  const steps = 32;
  const w = width / steps;
  const level = (value) => Math.round(value * scale);
  for (let i = 0; i < steps; i++) {
    const value = level((i / (steps - 1)) * 255);
    ctx.fillStyle = `rgb(${value},${value},${value})`;
    ctx.fillRect(i * w, 0, w + 1, height * 0.6);
  }
  // Dedicated shadow band: 8 very dark steps.
  for (let i = 0; i < 8; i++) {
    const value = level(i * 4);
    ctx.fillStyle = `rgb(${value},${value},${value})`;
    ctx.fillRect((i * width) / 8, height * 0.6, width / 8 + 1, height * 0.2);
  }
  ctx.fillStyle = 'rgb(0,0,0)';
  ctx.fillRect(0, height * 0.8, width / 2, height * 0.2);
  const white = level(255);
  ctx.fillStyle = `rgb(${white},${white},${white})`;
  ctx.fillRect(width / 2, height * 0.8, width / 2, height * 0.2);
}

/**
 * Redrawn every animation frame even though it looks static. A canvas capture
 * stream only emits a frame when the canvas is painted, so a lazily redrawn
 * canvas would produce a 2 fps video — and a 2 fps source cannot express a
 * flash, because consecutive frames are half a second apart.
 */
let wedgeFlashUntil = 0;

function wedgeFrame() {
  if (performance.now() < wedgeFlashUntil) {
    wedgeCtx.fillStyle = 'rgb(255,255,255)';
    wedgeCtx.fillRect(0, 0, wedgeCanvas.width, wedgeCanvas.height);
  } else {
    drawWedgePattern(wedgeCtx, wedgeCanvas);
  }
  drawWedgePattern(nightWedgeCtx, nightWedgeCanvas, NIGHT_WEDGE_SCALE);
  requestAnimationFrame(wedgeFrame);
}

drawWedgePattern(wedgeCtx, wedgeCanvas);
drawWedgePattern(nightWedgeCtx, nightWedgeCanvas, NIGHT_WEDGE_SCALE);
requestAnimationFrame(wedgeFrame);

const wedge = document.getElementById('wedge');
wedge.srcObject = wedgeCanvas.captureStream(30);
wedge.play().catch(() => {});

const nightWedge = document.getElementById('night-wedge');
nightWedge.srcObject = nightWedgeCanvas.captureStream(30);
nightWedge.play().catch(() => {});

/**
 * The still-image pair: the same pattern as a picture and as a canvas.
 *
 * A data URL rather than a file, so it is same-origin and identical to the
 * reference to the byte — the only difference between the two elements is that
 * one of them is an `<img>`, which is exactly the variable under test. Drawn
 * once: unlike the wedges above, nothing here has to feed a capture stream.
 */
const stillCanvas = document.getElementById('still-source');
drawWedgePattern(stillCanvas.getContext('2d'), stillCanvas);
document.getElementById('still').src = stillCanvas.toDataURL('image/png');

/**
 * Flash the pattern white for a moment, then return to exactly the same steady
 * state. That is what makes it possible to see whether the flash guard both
 * fires *and* releases. Used by the smoke test, and handy by hand too:
 * run `nnFlashWedge()` in the console.
 */
window.nnFlashWedge = (ms = 250) => {
  wedgeFlashUntil = performance.now() + ms;
  return ms;
};

/* ---------------------------------------------------------------- audio ---- */

/**
 * Build a WAV file with a large dynamic range:
 *   0.0-3.0 s  whisper-level speech-like burst train  (~ -42 dBFS)
 *   3.0-6.0 s  normal level                            (~ -24 dBFS)
 *   6.0-8.0 s  quiet again
 *   8.0-9.0 s  full-scale "explosion" noise            (~   0 dBFS)
 *   9.0-12.0 s quiet tail
 */
function buildWav(seconds = 12, sampleRate = 44100) {
  const frames = seconds * sampleRate;
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, frames * 2, true);

  const amplitudeAt = (t) => {
    if (t < 3) return 0.008; // -42 dBFS
    if (t < 6) return 0.063; // -24 dBFS
    if (t < 8) return 0.008;
    if (t < 9) return 0.95; //    0 dBFS
    return 0.01;
  };

  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const amp = amplitudeAt(t);
    // Voice-ish: 180 Hz fundamental + harmonics, amplitude-modulated at 3 Hz,
    // plus a little noise so nothing is bit-exact digital silence.
    const envelope = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3 * t);
    const tone =
      Math.sin(2 * Math.PI * 180 * t) * 0.6 +
      Math.sin(2 * Math.PI * 360 * t) * 0.25 +
      Math.sin(2 * Math.PI * 720 * t) * 0.12;
    const noise = (Math.random() * 2 - 1) * (t >= 8 && t < 9 ? 0.5 : 0.02);
    const sample = Math.max(-1, Math.min(1, (tone * envelope + noise) * amp));
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

const clip = document.getElementById('clip');
clip.src = URL.createObjectURL(buildWav());

/* ------------------------------------------------------------ lifecycle ---- */

const slot = document.getElementById('slot');
const slot2 = document.getElementById('slot2');

function makeVideo(label) {
  const figure = document.createElement('figure');
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  video.dataset.label = label;
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 270;
  startScene(canvas, { speed: 0.8 });
  video.srcObject = canvas.captureStream(24);
  video.play().catch(() => {});
  const caption = document.createElement('figcaption');
  caption.textContent = label;
  figure.append(video, caption);
  return figure;
}

document.getElementById('add').addEventListener('click', () => {
  slot.appendChild(makeVideo(`inserted at ${new Date().toLocaleTimeString()}`));
  log('inserted a new <video> — the popup count should go up within a second');
});

document.getElementById('swap').addEventListener('click', () => {
  const video = slot.querySelector('video');
  if (!video) return log('nothing to swap; insert a video first');
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 270;
  startScene(canvas, { speed: 2 });
  video.srcObject = canvas.captureStream(24);
  video.play().catch(() => {});
  log('replaced the source on the existing element (element reused, no re-attach)');
});

document.getElementById('move').addEventListener('click', () => {
  const figure = slot.querySelector('figure');
  if (!figure) return log('nothing to move; insert a video first');
  slot2.appendChild(figure);
  log('moved the element to another container — it must NOT be torn down');
});

document.getElementById('remove').addEventListener('click', () => {
  const figure = slot.querySelector('figure') ?? slot2.querySelector('figure');
  if (!figure) return log('nothing to remove');
  figure.remove();
  log('removed the element — cleanup happens after the 4 s grace period');
});
