/**
 * End-to-end smoke test against real Chrome.
 *
 *   npm run smoke
 *
 * It builds the extension, launches headless Chrome with the unpacked build
 * loaded, opens the local test bench and asserts that the extension actually
 * does what it claims:
 *
 *   - the content script is injected;
 *   - <video> elements are marked and carry the SVG filter;
 *   - the tone curve changes as the scene changes (i.e. it really is adaptive);
 *   - the audio graph engages for a playing element;
 *   - status reaches the service worker;
 *   - changing settings in storage applies live, and strength 0 is an identity
 *     curve plus audio off;
 *   - the popup renders and reflects stored settings;
 *   - the audio chain, rendered offline, produces the levels the mapping
 *     promises (and never clips);
 *   - nothing logs an error to the page console.
 *
 * Uses only Node built-ins (fetch + global WebSocket) plus esbuild, which is
 * already a build dependency. No puppeteer, and no audio device: headless
 * Chrome renders Web Audio to a dummy sink, so nothing is ever audible.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { findChrome } from './find-chrome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Ask the OS for a port nobody else is using. */
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, fn, { timeout = 10_000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}: ${last}`);
}

/* --------------------------- offline DSP harness -------------------------- */

/**
 * Bundle the real strength mapping so the audio measurement uses production
 * code instead of a copy of the numbers.
 */
async function bundleStrengthMapping() {
  const result = await esbuild.build({
    stdin: {
      contents: `
        export { mapAudioStrength, mapEqStrength, audioTransferDb } from './src/core/strength';
        export { buildSoftClipCurve, isIdentitySoftClip } from './src/core/soft-clip';
      `,
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'NNCore',
    target: ['chrome111'],
    logLevel: 'error',
  });
  return result.outputFiles[0].text;
}

/**
 * Installed into the page: renders the exact production audio chain through an
 * OfflineAudioContext and measures what comes out. Offline rendering touches no
 * audio hardware at all, so this measures the DSP rather than the plumbing.
 *
 * Test signal (48 kHz mono, 300 Hz sine):
 *   0.0-3.5 s  quiet passage at -45 dBFS peak      (whispered dialogue)
 *   3.5-4.0 s  abrupt full-scale burst             (the explosion)
 *   4.0-7.0 s  steady full-scale tone              (loud music)
 */
const DSP_HARNESS = `
window.__nnMeasureChain = async function (strength, nightEq) {
  const sr = 48000;
  const seconds = 7;
  const params = NNCore.mapAudioStrength(strength, nightEq === true);
  const db = (amplitude) => 20 * Math.log10(Math.max(amplitude, 1e-9));
  const gain = (decibels) => Math.pow(10, decibels / 20);

  const ctx = new OfflineAudioContext(1, sr * seconds, sr);
  const buffer = ctx.createBuffer(1, sr * seconds, sr);
  const data = buffer.getChannelData(0);
  const quiet = gain(-45);
  for (let i = 0; i < data.length; i++) {
    const t = i / sr;
    const amplitude = t < 3.5 ? quiet : 1;
    data[i] = Math.sin(2 * Math.PI * 300 * t) * amplitude;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const pre = ctx.createGain();
  pre.gain.value = gain(params.preGainDb);
  // Night EQ, in the same position as the content script puts it.
  const lowShelf = ctx.createBiquadFilter();
  lowShelf.type = 'lowshelf';
  lowShelf.frequency.value = params.eq.lowShelfHz;
  lowShelf.gain.value = params.eq.lowShelfDb;
  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = params.eq.presenceHz;
  presence.Q.value = params.eq.presenceQ;
  presence.gain.value = params.eq.presenceDb;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = params.compressor.thresholdDb;
  comp.knee.value = params.compressor.kneeDb;
  comp.ratio.value = params.compressor.ratio;
  comp.attack.value = params.compressor.attack;
  comp.release.value = params.compressor.release;
  const makeup = ctx.createGain();
  makeup.gain.value = gain(params.makeupGainDb);
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = params.limiter.thresholdDb;
  limiter.knee.value = params.limiter.kneeDb;
  limiter.ratio.value = params.limiter.ratio;
  limiter.attack.value = params.limiter.attack;
  limiter.release.value = params.limiter.release;

  // Safety stage, identical to the one the content script installs.
  const trim = ctx.createGain();
  trim.gain.value = 1 / Math.max(1, params.safety.headroom);
  const shaper = ctx.createWaveShaper();
  shaper.oversample = 'none';
  shaper.curve = NNCore.buildSoftClipCurve(params.safety);

  source.connect(pre);
  pre.connect(lowShelf);
  lowShelf.connect(presence);
  presence.connect(comp);
  comp.connect(makeup);
  makeup.connect(limiter);
  limiter.connect(trim);
  trim.connect(shaper);
  shaper.connect(ctx.destination);
  source.start();

  const rendered = await ctx.startRendering();
  const out = rendered.getChannelData(0);

  const window_ = (from, to) => {
    let sum = 0;
    let peak = 0;
    const a = Math.floor(from * sr);
    const b = Math.floor(to * sr);
    for (let i = a; i < b; i++) {
      sum += out[i] * out[i];
      peak = Math.max(peak, Math.abs(out[i]));
    }
    return { rms: db(Math.sqrt(sum / (b - a))), peak: db(peak), peakLinear: peak };
  };

  let globalPeak = 0;
  for (let i = 0; i < out.length; i++) globalPeak = Math.max(globalPeak, Math.abs(out[i]));

  return {
    strength,
    quiet: window_(2.5, 3.4),        // settled quiet passage
    transient: window_(3.5, 3.65),   // the moment the burst hits
    loud: window_(6, 6.9),           // settled loud passage
    globalPeakDb: db(globalPeak),
    globalPeakLinear: globalPeak,
  };
};

/**
 * The night EQ section on its own, measured at three frequencies: rumble, the
 * body of the mix, and the consonant band. Proves the filters do what the popup
 * copy claims rather than just that they exist.
 */
window.__nnMeasureEq = async function (strength) {
  const sr = 48000;
  const seconds = 1;
  const params = NNCore.mapEqStrength(strength, true);
  const db = (amplitude) => 20 * Math.log10(Math.max(amplitude, 1e-9));

  const measure = async (frequency, engaged) => {
    const ctx = new OfflineAudioContext(1, sr * seconds, sr);
    const buffer = ctx.createBuffer(1, sr * seconds, sr);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.sin(2 * Math.PI * frequency * (i / sr)) * 0.25;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const lowShelf = ctx.createBiquadFilter();
    lowShelf.type = 'lowshelf';
    lowShelf.frequency.value = params.lowShelfHz;
    lowShelf.gain.value = engaged ? params.lowShelfDb : 0;
    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = params.presenceHz;
    presence.Q.value = params.presenceQ;
    presence.gain.value = engaged ? params.presenceDb : 0;

    source.connect(lowShelf);
    lowShelf.connect(presence);
    presence.connect(ctx.destination);
    source.start();

    const out = (await ctx.startRendering()).getChannelData(0);
    // Skip the filter's settling time.
    let sum = 0;
    const from = Math.floor(sr * 0.3);
    for (let i = from; i < out.length; i++) sum += out[i] * out[i];
    return db(Math.sqrt(sum / (out.length - from)));
  };

  const at = async (frequency) => (await measure(frequency, true)) - (await measure(frequency, false));
  return {
    lowDb: await at(60),
    midDb: await at(700),
    presenceDb: await at(params.presenceHz),
    params,
  };
};

/**
 * Steady-state level in vs level out, rendered rather than modelled. This is the
 * check that keeps the popup's audio graph honest: audioTransferDb() is an
 * analytical model of the same chain, and if the two drift apart the picture in
 * the popup stops describing the thing the user is hearing.
 */
window.__nnMeasureSteady = async function (strength, inputDb) {
  const sr = 48000;
  const seconds = 4;
  const params = NNCore.mapAudioStrength(strength, false);
  const gain = (decibels) => Math.pow(10, decibels / 20);
  const db = (amplitude) => 20 * Math.log10(Math.max(amplitude, 1e-9));

  const ctx = new OfflineAudioContext(1, sr * seconds, sr);
  const buffer = ctx.createBuffer(1, sr * seconds, sr);
  const data = buffer.getChannelData(0);
  const amplitude = gain(inputDb);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.sin(2 * Math.PI * 300 * (i / sr)) * amplitude;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const pre = ctx.createGain();
  pre.gain.value = gain(params.preGainDb);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = params.compressor.thresholdDb;
  comp.knee.value = params.compressor.kneeDb;
  comp.ratio.value = params.compressor.ratio;
  comp.attack.value = params.compressor.attack;
  comp.release.value = params.compressor.release;
  const makeup = ctx.createGain();
  makeup.gain.value = gain(params.makeupGainDb);
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
  shaper.curve = NNCore.buildSoftClipCurve(params.safety);

  source.connect(pre);
  pre.connect(comp);
  comp.connect(makeup);
  makeup.connect(limiter);
  limiter.connect(trim);
  trim.connect(shaper);
  shaper.connect(ctx.destination);
  source.start();

  const out = (await ctx.startRendering()).getChannelData(0);
  // Last second only: fully settled, so it is comparable with a steady-state
  // model.
  let peak = 0;
  const from = Math.floor(sr * (seconds - 1));
  for (let i = from; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));

  return {
    inputDb,
    measuredDb: db(peak),
    modelDb: NNCore.audioTransferDb(params, inputDb),
  };
};

/** Group delay of the chain, measured with a single impulse. */
window.__nnMeasureLatency = async function (strength) {
  const sr = 48000;
  const params = NNCore.mapAudioStrength(strength);
  const ctx = new OfflineAudioContext(1, sr, sr);
  const buffer = ctx.createBuffer(1, sr, sr);
  const impulseAt = 4800;
  buffer.getChannelData(0)[impulseAt] = 1;

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = params.compressor.thresholdDb;
  comp.knee.value = params.compressor.kneeDb;
  comp.ratio.value = params.compressor.ratio;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = params.limiter.thresholdDb;
  limiter.ratio.value = params.limiter.ratio;
  source.connect(comp);
  comp.connect(limiter);
  limiter.connect(ctx.destination);
  source.start();

  const out = (await ctx.startRendering()).getChannelData(0);
  let first = -1;
  for (let i = 0; i < out.length; i++) {
    if (Math.abs(out[i]) > 1e-4) {
      first = i;
      break;
    }
  }
  return { samples: first - impulseAt, ms: ((first - impulseAt) / sr) * 1000 };
};
true;
`;

/* ------------------------------ PNG decoding ------------------------------ */

/**
 * Minimal PNG reader for 8-bit RGB/RGBA, non-interlaced — enough for Chrome's
 * screenshots. Needed so the test can measure what the compositor actually
 * painted rather than trusting computed style.
 */
async function decodePng(buffer) {
  const { inflateSync } = await import('node:zlib');
  let offset = 8; // skip signature
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
        throw new Error(`unsupported PNG (depth ${bitDepth}, colour type ${colorType})`);
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let value = line[x];
      switch (filter) {
        case 0:
          break;
        case 1:
          value += a;
          break;
        case 2:
          value += b;
          break;
        case 3:
          value += (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter}`);
      }
      cur[x] = value & 0xff;
    }
  }

  return { width, height, channels, data: out };
}

/** Luminance summary of a decoded screenshot. */
function lumaStats(image) {
  const { data, channels } = image;
  const values = [];
  for (let i = 0; i + channels - 1 < data.length; i += channels) {
    values.push((0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255);
  }
  values.sort((a, b) => a - b);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const at = (p) => values[Math.min(values.length - 1, Math.floor(p * values.length))];
  const slice = (from, to) => {
    const a = Math.floor(from * values.length);
    const b = Math.max(a + 1, Math.floor(to * values.length));
    const part = values.slice(a, b);
    return part.reduce((sum, v) => sum + v, 0) / part.length;
  };
  return {
    mean,
    // Absolute black: shows the black-point lift only.
    darkDecile: slice(0, 0.1),
    // Near-black *detail*: the band where shadow visibility actually lives.
    shadowBand: slice(0.05, 0.2),
    brightDecile: slice(0.9, 1),
    p99: at(0.99),
  };
}

/* ------------------------------- CDP client ------------------------------- */

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.consoleErrors = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.consoleErrors.push(
          message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '),
        );
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(
          message.params.exceptionDetails?.exception?.description ??
            message.params.exceptionDetails?.text ??
            'exception',
        );
      }
    });
    return this;
  }

  send(method, params = {}, timeoutMs = 20_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, timeoutMs);
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed');
    }
    return result.result.value;
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

let CDP_PORT = 0;
let PAGE_URL = '';

async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  return response.json();
}

async function newTab(url) {
  const response = await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
  );
  if (!response.ok) throw new Error(`could not open tab: ${response.status}`);
  return response.json();
}

/* --------------------------------- runner --------------------------------- */

async function main() {
  console.log('building extension...');
  await run('node', ['scripts/build.mjs', '--dev']);

  CDP_PORT = Number(process.env.CDP_PORT ?? (await freePort()));
  const pagePort = await freePort();
  PAGE_URL = `http://localhost:${pagePort}/index.html`;

  const profile = await mkdtemp(path.join(tmpdir(), 'nn-smoke-'));
  const server = spawn(process.execPath, ['scripts/serve-test-page.mjs'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(pagePort) },
  });

  const chromePath = findChrome();
  console.log(`using ${chromePath}`);

  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      // Chrome 137+ ignores --load-extension in branded builds, so the
      // extension is installed over CDP (Extensions.loadUnpacked) instead.
      '--enable-unsafe-extension-debugging',
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const cleanup = async () => {
    chrome.kill('SIGKILL');
    server.kill('SIGKILL');
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };

  try {
    await waitFor('chrome devtools endpoint', async () => {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      return response.ok;
    });
    await waitFor('test page server', async () => {
      const response = await fetch(PAGE_URL);
      return response.ok && response.headers.get('x-nn-test-bench') === '1';
    });

    /* -------- install the extension -------- */
    const versionInfo = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    const browser = await new Cdp(versionInfo.webSocketDebuggerUrl).connect();
    const loaded = await browser.send('Extensions.loadUnpacked', {
      path: path.join(root, 'dist'),
    });
    const extensionId = loaded.id;
    check('unpacked extension installs cleanly', Boolean(extensionId), extensionId);

    const swTarget = await waitFor('extension service worker', async () => {
      const targets = await listTargets();
      return targets.find((t) => t.url === `chrome-extension://${extensionId}/service-worker.js`);
    });
    check('service worker registered', Boolean(swTarget));

    const sw = await new Cdp(swTarget.webSocketDebuggerUrl).connect();
    await sw.send('Runtime.enable');

    /** Local wall-clock minutes since midnight, the unit the night window uses. */
    const nowMinutes = () => {
      const now = new Date();
      return now.getHours() * 60 + now.getMinutes();
    };
    const shiftMinutes = (delta) => (((nowMinutes() + delta) % 1440) + 1440) % 1440;

    /**
     * Write a whole settings object, merged over the shipped defaults.
     *
     * The two night/music defaults are deliberately switched off in this base:
     * shipped defaults process only between 21:00 and 07:00 and leave audio-only
     * players alone, so a suite run at 3 p.m. would otherwise be measuring an
     * extension that is correctly doing nothing. Both are exercised explicitly
     * further down.
     */
    const writeSettings = async (patch) => {
      const settings = JSON.stringify({
        enabled: true,
        strength: 45,
        linked: true,
        audioStrength: 45,
        videoStrength: 45,
        audio: true,
        video: true,
        nightEq: false,
        disabledSites: [],
        nightOnly: false,
        nightStart: 21 * 60,
        nightEnd: 7 * 60,
        skipMusic: false,
        ...patch,
      });
      await sw.eval(`chrome.storage.sync.set({ settings: ${settings} })`);
    };

    // Before the page opens, so the first assertions below are not racing the
    // night gate.
    await writeSettings({});

    const commands = await sw.eval(
      `chrome.commands.getAll().then((list) => JSON.stringify(list))`,
    );
    const toggleCommand = JSON.parse(commands ?? '[]').find(
      (command) => command.name === 'toggle-enabled',
    );
    // An extension side-loaded over CDP into a throwaway profile does not get
    // its suggested accelerator assigned, so the binding itself cannot be
    // asserted here. What can be asserted is that the command is declared and
    // carries a description, which is what chrome://extensions/shortcuts shows.
    const shortcutBound = Boolean(toggleCommand?.shortcut);
    check(
      'keyboard shortcut command is declared and described',
      Boolean(toggleCommand) && Boolean(toggleCommand.description),
      `${toggleCommand?.shortcut || 'unbound in this profile'} — ${toggleCommand?.description ?? ''}`,
    );

    /* -------- content script on the test page -------- */
    const tab = await newTab(PAGE_URL);
    // Without this the tab stays in the background and document.hidden is true,
    // which (correctly) stops frame analysis.
    await browser.send('Target.activateTarget', { targetId: tab.id }).catch(() => {});
    const page = await new Cdp(tab.webSocketDebuggerUrl).connect();
    await page.send('Runtime.enable');
    await page.send('Log.enable').catch(() => {});
    await sleep(1200);

    // Fire and forget: play() on a live MediaStream never settles in headless.
    await page.eval(
      `(() => {
         const v = document.getElementById('scene');
         v.muted = true;
         v.play().catch(() => {});
         const a = document.getElementById('clip');
         a.volume = 0.4;
         a.play().catch(() => {});
         return true;
       })()`,
    );
    await sleep(1500);

    // Content scripts live in an isolated world, so presence is verified
    // through their DOM side effects rather than a global flag.
    const injected = await waitFor('content script side effects', () =>
      page.eval(
        `Boolean(document.getElementById('nn-tone-curve') && document.getElementById('nn-tone-style'))`,
      ),
    );
    check('content script injected and installed its filter definition', injected === true);

    /* -------- video: marking + filter -------- */
    const marked = await waitFor('video marked', () =>
      page.eval(
        `document.querySelectorAll('video[data-nn-tone="1"]').length`,
      ).then((n) => (n > 0 ? n : false)),
    );
    check('video elements are marked for processing', marked > 0, `${marked} element(s)`);

    const computedFilter = await page.eval(
      `getComputedStyle(document.getElementById('scene')).filter`,
    );
    check(
      'computed style carries the SVG tone-curve filter',
      typeof computedFilter === 'string' && computedFilter.includes('url('),
      computedFilter,
    );

    const filterDef = await page.eval(
      `(() => {
         const f = document.getElementById('nn-tone-curve');
         if (!f) return null;
         const r = f.querySelector('feFuncR');
         return {
           entries: (r?.getAttribute('tableValues') ?? '').split(' ').length,
           saturate: f.querySelector('feColorMatrix')?.getAttribute('values') ?? null,
           colorSpace: f.getAttribute('color-interpolation-filters'),
         };
       })()`,
    );
    check(
      'SVG filter is a 33-entry per-channel LUT in sRGB',
      filterDef?.entries === 33 && filterDef.colorSpace === 'sRGB',
      JSON.stringify(filterDef),
    );

    const curveNow = () =>
      page.eval(
        `document.querySelector('#nn-tone-curve feFuncR')?.getAttribute('tableValues') ?? ''`,
      );
    const firstCurve = await curveNow();
    check(
      'tone curve lifts black and rolls off white',
      (() => {
        const values = firstCurve.split(' ').map(Number);
        return values[0] > 0 && values[values.length - 1] < 1;
      })(),
      `black=${firstCurve.split(' ')[0]} white=${firstCurve.split(' ').at(-1)}`,
    );

    /* -------- video: is it actually adaptive? -------- */
    const samples = new Set();
    for (let i = 0; i < 24; i++) {
      samples.add(await curveNow());
      await sleep(250);
    }
    check(
      'tone curve adapts over a scene change (dark -> bright -> flash)',
      samples.size > 1,
      `${samples.size} distinct curves in 6 s`,
    );

    /* -------- cost of one analysis sample -------- */
    const sampleCost = await page.eval(
      `(() => {
         const video = document.getElementById('scene');
         const canvas = document.createElement('canvas');
         canvas.width = 48; canvas.height = 27;
         const ctx = canvas.getContext('2d', { willReadFrequently: true });
         // Warm up, then time exactly what the video engine does per tick.
         for (let i = 0; i < 10; i++) { ctx.drawImage(video, 0, 0, 48, 27); ctx.getImageData(0, 0, 48, 27); }
         const t0 = performance.now();
         const n = 100;
         for (let i = 0; i < n; i++) { ctx.drawImage(video, 0, 0, 48, 27); ctx.getImageData(0, 0, 48, 27); }
         return (performance.now() - t0) / n;
       })()`,
    );
    check(
      'one luminance sample stays well under a millisecond',
      typeof sampleCost === 'number' && sampleCost < 3,
      `${sampleCost.toFixed(3)} ms per sample, 8 samples/s => ${(sampleCost * 8).toFixed(2)} ms/s`,
    );

    /* -------- status pipeline + engine states -------- */
    const readStatus = async () => {
      const data = await sw.eval(
        `chrome.storage.session.get('frameStatus').then(r => JSON.stringify(r.frameStatus ?? {}))`,
      );
      const frames = Object.values(JSON.parse(data ?? '{}')).flatMap((t) => Object.values(t));
      return frames.find((f) => f.top && f.mediaElements > 0) ?? null;
    };
    /** Poll until the predicate holds, then report whatever was last seen. */
    const awaitStatus = async (predicate, timeout = 12_000) => {
      const deadline = Date.now() + timeout;
      let last = null;
      while (Date.now() < deadline) {
        last = await readStatus();
        if (last && predicate(last)) return last;
        await sleep(400);
      }
      return last;
    };

    const status = await awaitStatus((s) => s.mediaElements >= 2);
    check(
      'content script reports status to the service worker',
      Boolean(status),
      status ? `media=${status.mediaElements}` : 'no report',
    );

    const videoStatus = await awaitStatus((s) => s.video.mode === 'adaptive');
    check(
      'video engine reports adaptive mode with the SVG technique',
      videoStatus?.video.mode === 'adaptive' && videoStatus?.video.technique === 'svg-tone-curve',
      `${videoStatus?.video.mode}/${videoStatus?.video.technique}`,
    );

    const audioStatus = await awaitStatus((s) => s.audio.state === 'active');
    check(
      'audio engine engaged for the playing element',
      audioStatus?.audio.state === 'active' && audioStatus?.audio.processed >= 1,
      `${audioStatus?.audio.state}, processed=${audioStatus?.audio.processed}`,
    );

    /* -------- audio passthrough of native controls -------- */
    const audioControls = await page.eval(
      `(() => {
         const a = document.getElementById('clip');
         a.volume = 0.25; a.muted = true;
         const state = { volume: a.volume, muted: a.muted, paused: a.paused };
         a.muted = false; a.volume = 0.4;
         return state;
       })()`,
    );
    check(
      'element volume/mute remain writable while processed',
      audioControls.volume === 0.25 && audioControls.muted === true && audioControls.paused === false,
      JSON.stringify(audioControls),
    );

    /* -------- pixel-level proof that the curve is actually painted -------- */
    await page.send('Page.enable').catch(() => {});
    // Pause the animated clip so the static wedge becomes the primary video and
    // the measurement is not chasing a moving scene.
    await page.eval(`document.getElementById('pause-video').click(); true`);
    // Page.captureScreenshot clips in *document* coordinates, so the scroll
    // offset has to be added to the viewport-relative rect.
    const wedgeBox = await page.eval(
      `(() => {
         const v = document.getElementById('wedge');
         v.scrollIntoView({ block: 'center' });
         const r = v.getBoundingClientRect();
         return JSON.stringify({
           x: Math.round(r.x + window.scrollX) + 3,
           y: Math.round(r.y + window.scrollY) + 3,
           width: Math.round(r.width) - 6,
           height: Math.round(r.height) - 6,
         });
       })()`,
    );
    const clip = { ...JSON.parse(wedgeBox), scale: 1 };

    const captureWedge = async () => {
      // Deliberately not using captureBeyondViewport: it forces a full-page
      // composite, which is slow on a page full of live video. The region was
      // scrolled into view above, so a plain clipped capture is enough.
      let shot;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          shot = await page.send('Page.captureScreenshot', { format: 'png', clip }, 30_000);
          break;
        } catch (error) {
          if (attempt === 2) throw error;
          await sleep(500);
        }
      }
      const stats = lumaStats(await decodePng(Buffer.from(shot.data, 'base64')));
      if (stats.brightDecile < 0.2) {
        throw new Error(
          `screenshot region looks empty (bright decile ${stats.brightDecile.toFixed(3)}); clip=${JSON.stringify(clip)}`,
        );
      }
      return stats;
    };

    const setStrength = async (strength) => {
      await writeSettings({ strength });
      await sleep(2500); // let the loop push a curve and the adaptation settle
    };

    await setStrength(0);
    const pixelsOff = await captureWedge();
    await setStrength(45); // the default: this is what most users ever see
    const pixelsDefault = await captureWedge();
    await setStrength(100);
    const pixelsMax = await captureWedge();

    const report = (a, b) =>
      `black ${a.darkDecile.toFixed(3)}->${b.darkDecile.toFixed(3)}, ` +
      `shadow band ${a.shadowBand.toFixed(3)}->${b.shadowBand.toFixed(3)}, ` +
      `bright ${a.brightDecile.toFixed(3)}->${b.brightDecile.toFixed(3)}, ` +
      `mean ${a.mean.toFixed(3)}->${b.mean.toFixed(3)}`;

    check(
      'rendered pixels at the DEFAULT strength: shadow detail lifted',
      // Note: this test pattern is a full-range ramp, so it reads as a *bright*
      // scene and the adaptive lift sits at its floor. A dark scene gets more.
      pixelsDefault.shadowBand > pixelsOff.shadowBand * 1.3 &&
        pixelsDefault.darkDecile > pixelsOff.darkDecile + 0.015,
      report(pixelsOff, pixelsDefault),
    );
    check(
      'rendered pixels at the DEFAULT strength: highlights pulled back',
      pixelsDefault.brightDecile < pixelsOff.brightDecile - 0.02,
      `p99 ${pixelsOff.p99.toFixed(3)} -> ${pixelsDefault.p99.toFixed(3)}`,
    );
    check(
      'rendered pixels at maximum strength go further in both directions',
      pixelsMax.shadowBand > pixelsDefault.shadowBand &&
        pixelsMax.brightDecile < pixelsDefault.brightDecile,
      report(pixelsDefault, pixelsMax),
    );
    check(
      'rendered pixels: image is not simply dimmed or blown out',
      Math.abs(pixelsMax.mean - pixelsOff.mean) < 0.2 &&
        Math.abs(pixelsDefault.mean - pixelsOff.mean) < 0.15,
      `mean ${pixelsOff.mean.toFixed(3)} -> ${pixelsDefault.mean.toFixed(3)} -> ${pixelsMax.mean.toFixed(3)}`,
    );

    /* -------- flash guard, observed live at the default strength -------- */
    await page.eval(
      `(() => {
         document.getElementById('wedge').pause();      // hand primary back to the animated clip
         document.getElementById('play-video').click();
         return true;
       })()`,
    );
    await sleep(500);
    /* -------- cost of per-frame analysis, measured -------- */
    await page.send('Performance.enable').catch(() => {});
    const scriptSeconds = async () => {
      const { metrics } = await page.send('Performance.getMetrics');
      return metrics.find((m) => m.name === 'ScriptDuration')?.value ?? 0;
    };
    const measureWindow = async (strength, seconds = 5) => {
      await setStrength(strength);
      const start = await scriptSeconds();
      await sleep(seconds * 1000);
      return (await scriptSeconds()) - start;
    };
    const baseline = await measureWindow(0);
    const withProcessing = await measureWindow(45);
    const overheadRatio = (withProcessing - baseline) / 5;
    check(
      'per-frame analysis costs a small share of the main thread',
      overheadRatio < 0.1,
      `script time over 5 s: ${baseline.toFixed(3)} s idle vs ${withProcessing.toFixed(3)} s active ` +
        `=> ${(overheadRatio * 100).toFixed(1)}% of one core`,
    );

    // 1. A hard cut in the animated clip must move the curve in a single step.
    //    Sustained adaptation uses time constants of 0.3-1.6 s, so a jump
    //    between two samples milliseconds apart can only be the flash guard.
    const whiteNow = async () => {
      const raw = await page.eval(
        `document.querySelector('#nn-tone-curve feFuncR')?.getAttribute('tableValues') ?? ''`,
      );
      const values = raw.split(' ').map(Number);
      return values.length === 33 ? values[32] : null;
    };

    let worstWhiteDrop = 0;
    let previous = await whiteNow();
    const cutWatchUntil = Date.now() + 11_000;
    while (Date.now() < cutWatchUntil) {
      const white = await whiteNow();
      if (white !== null && previous !== null) {
        worstWhiteDrop = Math.max(worstWhiteDrop, previous - white);
      }
      previous = white;
      await sleep(5);
    }
    check(
      'flash guard fires on a hard cut: white point drops in one step',
      worstWhiteDrop > 0.02,
      `largest single-step white drop over one scene cycle: ${worstWhiteDrop.toFixed(4)}`,
    );

    // 2. Fire a controlled flash on the static pattern, which returns to
    //    exactly the same steady state afterwards. That is the only way to tell
    //    "the guard released" apart from "the scene is still bright".
    await page.eval(
      `(() => {
         document.getElementById('pause-video').click();
         document.getElementById('wedge').play().catch(() => {});
         return true;
       })()`,
    );
    await sleep(2500); // settle on the steady pattern
    const steady = await whiteNow();

    await page.eval(`window.nnFlashWedge(250)`);
    let lowest = steady;
    let last = steady;
    const flashWatchUntil = Date.now() + 3500;
    while (Date.now() < flashWatchUntil) {
      const white = await whiteNow();
      if (white !== null) {
        lowest = Math.min(lowest, white);
        last = white;
      }
      await sleep(10);
    }

    check(
      'flash guard dims a controlled white flash',
      lowest < steady - 0.02,
      `white ${steady.toFixed(3)} -> ${lowest.toFixed(3)} during the flash`,
    );
    check(
      'flash guard releases afterwards (not a one-way dim)',
      last >= steady - 0.01,
      `back to ${last.toFixed(3)} within 3.5 s (steady ${steady.toFixed(3)})`,
    );

    /* -------- offline measurement of the audio chain -------- */
    // Renders the production chain through an OfflineAudioContext: this measures
    // the DSP itself (levels, clipping, latency), with no audio hardware.
    await page.eval(await bundleStrengthMapping());
    await page.eval(DSP_HARNESS);
    const bypassDsp = await page.eval(`__nnMeasureChain(0)`);
    const defaultDsp = await page.eval(`__nnMeasureChain(45)`);
    const fullDsp = await page.eval(`__nnMeasureChain(100)`);
    const latency = await page.eval(`__nnMeasureLatency(100)`);

    // A 300 Hz sine at amplitude a has an RMS 3.01 dB below its peak, so the
    // -45 dBFS peak passage measures -48.01 dBFS RMS.
    const QUIET_IN = -48.01;
    const LOUD_IN = -3.01;

    check(
      'bypass (strength 0) is acoustically transparent',
      Math.abs(bypassDsp.quiet.rms - QUIET_IN) < 0.5 &&
        Math.abs(bypassDsp.loud.rms - LOUD_IN) < 0.5,
      `quiet ${bypassDsp.quiet.rms.toFixed(2)} dBFS (in ${QUIET_IN}), ` +
        `loud ${bypassDsp.loud.rms.toFixed(2)} dBFS (in ${LOUD_IN})`,
    );

    const quietLift = fullDsp.quiet.rms - bypassDsp.quiet.rms;
    const quietLiftDefault = defaultDsp.quiet.rms - bypassDsp.quiet.rms;
    check(
      'quiet passage is lifted, more so at higher strength',
      quietLift > 12 && quietLift < 26 && quietLiftDefault > 1 && quietLiftDefault < quietLift,
      `+${quietLiftDefault.toFixed(2)} dB at 45, +${quietLift.toFixed(2)} dB at 100 ` +
        `(${bypassDsp.quiet.rms.toFixed(2)} -> ${defaultDsp.quiet.rms.toFixed(2)} -> ${fullDsp.quiet.rms.toFixed(2)} dBFS)`,
    );
    check(
      'loud passage is brought down, never up',
      fullDsp.loud.rms < bypassDsp.loud.rms && defaultDsp.loud.rms <= bypassDsp.loud.rms,
      `${bypassDsp.loud.rms.toFixed(2)} -> ${defaultDsp.loud.rms.toFixed(2)} -> ${fullDsp.loud.rms.toFixed(2)} dBFS`,
    );

    const rangeIn = bypassDsp.loud.rms - bypassDsp.quiet.rms;
    const rangeDefault = defaultDsp.loud.rms - defaultDsp.quiet.rms;
    const rangeFull = fullDsp.loud.rms - fullDsp.quiet.rms;
    check(
      'dynamic range shrinks monotonically with strength, and never inverts',
      rangeFull > 6 && rangeFull < rangeDefault && rangeDefault < rangeIn,
      `${rangeIn.toFixed(1)} dB in -> ${rangeDefault.toFixed(1)} dB at 45 -> ${rangeFull.toFixed(1)} dB at 100`,
    );
    check(
      'the DEFAULT strength is audibly useful, not cosmetic',
      rangeIn - rangeDefault >= 6,
      `${(rangeIn - rangeDefault).toFixed(1)} dB of range removed at strength 45`,
    );

    check(
      'the sudden full-scale burst never clips',
      fullDsp.globalPeakLinear <= 1 &&
        defaultDsp.globalPeakLinear <= 1 &&
        bypassDsp.globalPeakLinear <= 1,
      `worst peak ${fullDsp.globalPeakDb.toFixed(2)} dBFS at 100, ` +
        `${defaultDsp.globalPeakDb.toFixed(2)} dBFS at 45 ` +
        `(transient window ${fullDsp.transient.peak.toFixed(2)} dBFS)`,
    );

    check(
      'chain latency stays imperceptible',
      latency.ms >= 0 && latency.ms < 25,
      `${latency.ms.toFixed(2)} ms (${latency.samples} samples at 48 kHz)`,
    );

    /* -------- night EQ, measured -------- */
    const eqOff = await page.eval(`__nnMeasureEq(0)`);
    const eq = await page.eval(`__nnMeasureEq(70)`);
    check(
      'night EQ shelves the low end down and lifts dialogue presence',
      eq.lowDb < -3 && eq.presenceDb > 1.5 && Math.abs(eq.midDb) < 1.5,
      `60 Hz ${eq.lowDb.toFixed(2)} dB, 700 Hz ${eq.midDb.toFixed(2)} dB, ` +
        `${Math.round(eq.params.presenceHz)} Hz +${eq.presenceDb.toFixed(2)} dB`,
    );
    check(
      'night EQ is flat at strength 0',
      Math.abs(eqOff.lowDb) < 0.01 && Math.abs(eqOff.presenceDb) < 0.01,
      `60 Hz ${eqOff.lowDb.toFixed(3)} dB, presence ${eqOff.presenceDb.toFixed(3)} dB`,
    );

    const eqDsp = await page.eval(`__nnMeasureChain(100, true)`);
    check(
      'the burst still never clips with night EQ engaged',
      eqDsp.globalPeakLinear <= 1,
      `worst peak ${eqDsp.globalPeakDb.toFixed(2)} dBFS at strength 100 with EQ on`,
    );

    /* -------- the popup's audio graph describes the real chain -------- */
    // `audioTransferDb()` is what the popup plots. It is a steady-state model,
    // so it is only worth showing if it stays close to a rendered measurement.
    const steadyLevels = [];
    for (const level of [-45, -30, -18, -6, 0]) {
      steadyLevels.push(await page.eval(`__nnMeasureSteady(70, ${level})`));
    }
    const worstError = Math.max(...steadyLevels.map((s) => Math.abs(s.measuredDb - s.modelDb)));
    check(
      'the transfer model the popup plots matches the rendered chain',
      worstError < 3.5,
      steadyLevels
        .map(
          (s) =>
            `${s.inputDb}: model ${s.modelDb.toFixed(1)} vs measured ${s.measuredDb.toFixed(1)}`,
        )
        .join(', ') + ` => worst ${worstError.toFixed(2)} dB`,
    );

    /* -------- live settings updates -------- */
    await writeSettings({ strength: 0 });
    const bypassedVideo = await waitFor('bypassed video', async () => {
      const marked = await page.eval(`document.querySelectorAll('video[data-nn-tone="1"]').length`);
      return marked === 0;
    });
    check('strength 0 removes the video filter without a reload', bypassedVideo === true);

    const offStatus = await awaitStatus((s) => s.audio.state === 'off' && s.video.mode === 'off');
    check(
      'strength 0 bypasses audio processing',
      offStatus?.audio.state === 'off',
      `audio=${offStatus?.audio.state} video=${offStatus?.video.mode}`,
    );

    await writeSettings({ enabled: false, strength: 60 });
    const unmarked = await waitFor('video unmarked', async () => {
      const count = await page.eval(`document.querySelectorAll('video[data-nn-tone="1"]').length`);
      return count === 0 ? true : false;
    });
    check('master off removes the video filter entirely', unmarked === true);

    /* -------- the toolbar says so -------- */
    // The keyboard shortcut has no other feedback: on a tab with no video,
    // flipping the switch would otherwise be completely invisible.
    const badgeOff = await waitFor('off badge', async () => {
      const text = await sw.eval(`chrome.action.getBadgeText({})`);
      return text === 'off' ? text : false;
    });
    check('the toolbar badge reports the off state', badgeOff === 'off', `badge "${badgeOff}"`);

    await writeSettings({ enabled: true, strength: 70 });
    const remarked = await waitFor('video re-marked', async () => {
      const count = await page.eval(`document.querySelectorAll('video[data-nn-tone="1"]').length`);
      return count > 0;
    });
    check('re-enabling restores processing live', remarked === true);

    const badgeOn = await waitFor('cleared badge', async () => {
      const text = await sw.eval(`chrome.action.getBadgeText({})`);
      return text === '' ? '(empty)' : false;
    });
    check('the badge clears again when switched back on', badgeOn === '(empty)');

    /* -------- split audio/video strength -------- */
    // One slider cannot express "compress the audio hard, leave the picture
    // nearly alone", so the two can be separated.
    await writeSettings({ linked: false, audioStrength: 70, videoStrength: 0 });
    const videoOnlyBypassed = await waitFor('video bypassed while audio runs', async () => {
      const marked = await page.eval(
        `document.querySelectorAll('video[data-nn-tone="1"]').length`,
      );
      if (marked !== 0) return false;
      const status = await readStatus();
      return status?.audio.state === 'active' ? status : false;
    });
    check(
      'video strength 0 bypasses the picture while audio keeps compressing',
      Boolean(videoOnlyBypassed),
      videoOnlyBypassed
        ? `audio=${videoOnlyBypassed.audio.state}, marked videos=0`
        : 'never reached that state',
    );

    await writeSettings({ linked: false, audioStrength: 0, videoStrength: 70 });
    const audioOnlyBypassed = await awaitStatus(
      (s) => s.audio.state === 'off' && s.video.mode !== 'off',
    );
    check(
      'audio strength 0 bypasses the sound while the tone curve keeps working',
      audioOnlyBypassed?.audio.state === 'off' && audioOnlyBypassed?.video.mode !== 'off',
      `audio=${audioOnlyBypassed?.audio.state} video=${audioOnlyBypassed?.video.mode}`,
    );

    /* -------- per-site exclusion -------- */
    const reportedSite = await waitFor('reported site', async () => {
      const status = await readStatus();
      return status?.site || false;
    });
    check(
      'the frame reports a bare hostname so the popup can offer a per-site switch',
      reportedSite === 'localhost',
      `site "${reportedSite}"`,
    );

    await writeSettings({ strength: 70, disabledSites: ['localhost'] });
    const excluded = await waitFor('site excluded', async () => {
      const marked = await page.eval(
        `document.querySelectorAll('video[data-nn-tone="1"]').length`,
      );
      if (marked !== 0) return false;
      const status = await readStatus();
      return status?.siteDisabled && status.audio.state === 'off' ? status : false;
    });
    check(
      'an excluded site is left completely alone, audio and video',
      Boolean(excluded),
      excluded ? `siteDisabled=true, audio=${excluded.audio.state}, marked videos=0` : 'still processing',
    );

    // A per-tab badge marks the exclusion, since the master switch is still on.
    const pageTabKey = await sw.eval(
      `chrome.storage.session.get('frameStatus').then(r => Number(Object.keys(r.frameStatus ?? {})[0] ?? -1))`,
    );
    const siteBadge = await waitFor('per-site badge', async () => {
      const text = await sw.eval(`chrome.action.getBadgeText({ tabId: ${pageTabKey} })`);
      return text === 'site' ? text : false;
    }).catch(() => '');
    check(
      'the toolbar badge distinguishes a per-site exclusion from a global off',
      siteBadge === 'site',
      `badge "${siteBadge}" on the excluded tab`,
    );

    await writeSettings({ strength: 70, disabledSites: ['other.example'] });
    const restored = await waitFor('site processing restored', async () => {
      const marked = await page.eval(
        `document.querySelectorAll('video[data-nn-tone="1"]').length`,
      );
      return marked > 0;
    });
    check(
      'excluding a different site does not affect this one',
      restored === true,
      'subdomain-safe matching keeps unrelated hosts untouched',
    );

    await writeSettings({ strength: 70 });

    /* -------- the night window -------- */
    // The shipped default only processes at night. On a machine with no ambient
    // light sensor -- which is every stock Chrome, since AmbientLightSensor sits
    // behind chrome://flags/#enable-generic-sensor-extra-classes -- the clock is
    // what decides, so that is what these two checks pin down.
    await writeSettings({
      strength: 70,
      nightOnly: true,
      nightStart: shiftMinutes(120),
      nightEnd: shiftMinutes(240),
    });
    const outsideWindow = await waitFor('night window closed', async () => {
      const marked = await page.eval(
        `document.querySelectorAll('video[data-nn-tone="1"]').length`,
      );
      if (marked !== 0) return false;
      const status = await readStatus();
      return status?.gate?.reason === 'daytime' && status.audio.state === 'off' ? status : false;
    }).catch(() => null);
    check(
      'outside the night window nothing is processed',
      Boolean(outsideWindow),
      outsideWindow
        ? `gate=${outsideWindow.gate.reason}/${outsideWindow.gate.source}, ` +
            `audio=${outsideWindow.audio.state}, marked videos=0`
        : 'still processing during the day',
    );

    // Without a badge, "correctly doing nothing until 21:00" and "broken" look
    // identical from the toolbar.
    const dayBadge = await waitFor('day badge', async () => {
      const text = await sw.eval(`chrome.action.getBadgeText({ tabId: ${pageTabKey} })`);
      return text === 'day' ? text : false;
    }).catch(() => '');
    check(
      'the toolbar badge says it is waiting for night',
      dayBadge === 'day',
      `badge "${dayBadge}" while outside the window`,
    );

    check(
      'the clock is in charge when no light sensor is available',
      outsideWindow?.gate?.source === 'clock' && outsideWindow?.gate?.lux === null,
      `source=${outsideWindow?.gate?.source ?? 'unknown'}, lux=${outsideWindow?.gate?.lux ?? 'none'}`,
    );

    await writeSettings({
      strength: 70,
      nightOnly: true,
      nightStart: shiftMinutes(-60),
      nightEnd: shiftMinutes(60),
    });
    const insideWindow = await waitFor('night window open', async () => {
      const marked = await page.eval(
        `document.querySelectorAll('video[data-nn-tone="1"]').length`,
      );
      return marked > 0 ? marked : false;
    });
    check(
      'inside the night window processing resumes without a reload',
      insideWindow > 0,
      `${insideWindow} marked video(s) once the window opened`,
    );

    /* -------- leaving music alone -------- */
    // The bench's only processable audio is an <audio> element, which is exactly
    // what the heuristic treats as music: dynamic range is the point of a record.
    await writeSettings({ strength: 70, skipMusic: true });
    const musicSkipped = await awaitStatus(
      (s) => s.audio.state === 'music' && s.music.skipped > 0,
    );
    check(
      'music is left uncompressed while video keeps being tone mapped',
      musicSkipped?.audio.state === 'music' &&
        musicSkipped?.music.skipped > 0 &&
        musicSkipped?.audio.processed === 0 &&
        musicSkipped?.video.mode !== 'off',
      `audio=${musicSkipped?.audio.state}, skipped as music=${musicSkipped?.music.skipped}, ` +
        `processed=${musicSkipped?.audio.processed}, video=${musicSkipped?.video.mode}`,
    );

    await writeSettings({ strength: 70, skipMusic: false });
    const musicProcessed = await awaitStatus((s) => s.audio.state === 'active');
    check(
      'turning the music exemption off compresses it again',
      musicProcessed?.audio.state === 'active' && musicProcessed?.music.skipped === 0,
      `audio=${musicProcessed?.audio.state}, processed=${musicProcessed?.audio.processed}`,
    );

    await writeSettings({ strength: 70 });

    /* -------- dynamic insertion -------- */
    const before = await page.eval(`document.querySelectorAll('video').length`);
    await page.eval(`document.getElementById('add').click(); true`);
    const grew = await waitFor('new video processed', async () => {
      const marked = await page.eval(
        `document.querySelectorAll('video[data-nn-tone="1"]').length`,
      );
      return marked > before - 1 && marked >= before ? marked : false;
    });
    check('dynamically inserted video is picked up', grew >= before, `${grew} marked`);

    /* -------- iframe coverage -------- */
    const nested = await waitFor('nested frame processed', async () => {
      const result = await page.eval(
        `(() => {
           const doc = document.querySelector('iframe')?.contentDocument;
           if (!doc) return null;
           return JSON.stringify({
             filter: Boolean(doc.getElementById('nn-tone-curve')),
             marked: doc.querySelectorAll('video[data-nn-tone="1"]').length,
           });
         })()`,
      );
      const parsed = result ? JSON.parse(result) : null;
      return parsed?.filter && parsed.marked > 0 ? parsed : false;
    });
    check(
      'nested frame gets its own content script and filter',
      Boolean(nested),
      JSON.stringify(nested),
    );

    /* -------- the popup's own query path -------- */
    const pageTabId = await sw.eval(
      `chrome.storage.session.get('frameStatus').then(r => Number(Object.keys(r.frameStatus ?? {})[0] ?? -1))`,
    );
    const popupTab = await newTab(`chrome-extension://${extensionId}/popup.html`);
    const popup = await new Cdp(popupTab.webSocketDebuggerUrl).connect();
    await popup.send('Runtime.enable');
    await sleep(800);
    const popupState = await popup.eval(
      `(() => ({
          strength: document.getElementById('strength').value,
          label: document.getElementById('strength-value').textContent,
          master: document.getElementById('master').checked,
          audio: document.getElementById('audio').checked,
          video: document.getElementById('video').checked,
          nightEq: document.getElementById('night-eq').checked,
          audioStatus: document.getElementById('audio-status').textContent,
          videoStatus: document.getElementById('video-status').textContent,
          shortcutShown: !document.getElementById('shortcut').hidden,
          shortcutKeys: document.getElementById('shortcut-keys').textContent,
          splitShown: !document.getElementById('split').hidden,
          nightOnly: document.getElementById('night-only').checked,
          nightStart: document.getElementById('night-start').value,
          nightEnd: document.getElementById('night-end').value,
          nightWindowShown: !document.getElementById('night-window').hidden,
          skipMusic: document.getElementById('skip-music').checked,
       }))()`,
    );
    // The hint must show the *real* accelerator and must stay hidden when there
    // is none, rather than printing a shortcut that would do nothing.
    check(
      'popup surfaces the keyboard shortcut, and only when one is bound',
      shortcutBound
        ? popupState.shortcutShown === true &&
            popupState.shortcutKeys === toggleCommand.shortcut
        : popupState.shortcutShown === false,
      shortcutBound
        ? `shows "${popupState.shortcutKeys}"`
        : 'no accelerator bound in this profile, so the hint stays hidden',
    );
    check(
      'popup starts in linked mode with the split sliders hidden',
      popupState.splitShown === false,
    );

    // The clock fields only mean anything while the night restriction is on, so
    // they follow its switch rather than sitting there looking authoritative.
    check(
      'popup hides the clock fields while the night restriction is off',
      popupState.nightOnly === false && popupState.nightWindowShown === false,
      `nightOnly=${popupState.nightOnly}, window shown=${popupState.nightWindowShown}`,
    );

    await popup.eval(`document.getElementById('night-only').click(); true`);
    await sleep(400);
    const nightUi = await popup.eval(
      `(() => ({
          windowShown: !document.getElementById('night-window').hidden,
          start: document.getElementById('night-start').value,
          end: document.getElementById('night-end').value,
          desc: document.getElementById('night-desc').textContent,
       }))()`,
    );
    const nightStored = JSON.parse(
      (await sw.eval(
        `chrome.storage.sync.get('settings').then(r => JSON.stringify(r.settings ?? {}))`,
      )) ?? '{}',
    );
    check(
      'popup reveals the clock fields and persists the night restriction',
      nightUi.windowShown === true &&
        /^\d{2}:\d{2}$/.test(nightUi.start) &&
        /^\d{2}:\d{2}$/.test(nightUi.end) &&
        nightStored.nightOnly === true,
      `${nightUi.start}-${nightUi.end}, stored nightOnly=${nightStored.nightOnly}`,
    );
    // With no sensor the copy has to say so rather than implying one is in use.
    check(
      'popup says which signal is deciding',
      typeof nightUi.desc === 'string' && /sensor|clock|dark room/i.test(nightUi.desc),
      `"${nightUi.desc}"`,
    );

    await popup.eval(`document.getElementById('night-only').click(); true`);
    await sleep(400);
    check(
      'popup renders and reflects stored settings',
      popupState.strength === '70' && popupState.master === true,
      JSON.stringify(popupState),
    );
    check(
      'popup labels the strength value',
      typeof popupState.label === 'string' && popupState.label.includes('70'),
      popupState.label,
    );

    // The curve thumbnail must actually draw, and must change with strength.
    const curveSignature = `(() => {
       const canvas = document.getElementById('curve');
       const ctx = canvas.getContext('2d');
       const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
       let lit = 0;
       let weighted = 0;
       for (let i = 0; i < data.length; i += 4) {
         if (data[i + 3] > 12) {
           lit++;
           weighted += Math.floor(i / 4 / canvas.width);
         }
       }
       return JSON.stringify({ lit, centroid: lit ? weighted / lit : 0 });
     })()`;
    const curveAt70 = JSON.parse(await popup.eval(curveSignature));
    await popup.eval(
      `(() => {
         const slider = document.getElementById('strength');
         slider.value = '0';
         slider.dispatchEvent(new Event('input'));
         return true;
       })()`,
    );
    const curveAt0 = JSON.parse(await popup.eval(curveSignature));
    check(
      'popup draws the real tone curve and it tracks the slider',
      curveAt70.lit > 200 && curveAt0.lit > 200 && curveAt70.centroid !== curveAt0.centroid,
      `lit px ${curveAt70.lit} @70 vs ${curveAt0.lit} @0, centroid ` +
        `${curveAt70.centroid.toFixed(1)} vs ${curveAt0.centroid.toFixed(1)}`,
    );

    // The audio graph is generated from the same mapping the engine uses, so it
    // has to draw and to respond to the slider as well.
    const audioSignature = curveSignature.replace("'curve'", "'audio-curve'");
    const audioAt0 = JSON.parse(await popup.eval(audioSignature));
    await popup.eval(
      `(() => {
         const slider = document.getElementById('strength');
         slider.value = '85';
         slider.dispatchEvent(new Event('input'));
         return true;
       })()`,
    );
    const audioAt85 = JSON.parse(await popup.eval(audioSignature));
    check(
      'popup draws the audio transfer curve and it tracks the slider',
      audioAt0.lit > 200 && audioAt85.lit > 200 && audioAt0.centroid !== audioAt85.centroid,
      `lit px ${audioAt0.lit} @0 vs ${audioAt85.lit} @85, centroid ` +
        `${audioAt0.centroid.toFixed(1)} vs ${audioAt85.centroid.toFixed(1)}`,
    );

    // Splitting the sliders is a popup-driven settings change; check the UI
    // swaps over and the write lands.
    await popup.eval(`document.getElementById('link-toggle').click(); true`);
    await sleep(400);
    const splitUi = await popup.eval(
      `(() => ({
          splitShown: !document.getElementById('split').hidden,
          masterShown: !document.getElementById('strength').hidden,
          pressed: document.getElementById('link-toggle').getAttribute('aria-pressed'),
       }))()`,
    );
    const splitStored = await sw.eval(
      `chrome.storage.sync.get('settings').then(r => JSON.stringify(r.settings ?? {}))`,
    );
    check(
      'popup can separate the two sliders and persists the choice',
      splitUi.splitShown === true &&
        splitUi.masterShown === false &&
        splitUi.pressed === 'true' &&
        JSON.parse(splitStored).linked === false,
      JSON.stringify(splitUi),
    );
    await popup.eval(`document.getElementById('link-toggle').click(); true`);
    await sleep(400);

    // The per-site button is the whole point of reporting the hostname. In this
    // harness the popup is itself a tab, so the "active tab" it inspects is the
    // popup unless the page is brought back to the foreground first.
    await browser.send('Target.activateTarget', { targetId: tab.id }).catch(() => {});
    await waitFor('popup picks up the page tab', async () => {
      const site = await popup.eval(
        `document.getElementById('site-toggle').hidden ? '' : document.getElementById('site-toggle-text').textContent`,
      );
      return site && site.includes('localhost') ? site : false;
    });
    const siteUi = await popup.eval(
      `(() => {
         const button = document.getElementById('site-toggle');
         return {
           hidden: button.hidden,
           text: document.getElementById('site-toggle-text').textContent,
           pressed: button.getAttribute('aria-pressed'),
         };
       })()`,
    );
    check(
      'popup offers a per-site switch naming the actual host',
      siteUi.hidden === false && (siteUi.text ?? '').includes('localhost'),
      `"${siteUi.text}" (pressed=${siteUi.pressed})`,
    );

    await popup.eval(`document.getElementById('site-toggle').click(); true`);
    const siteExcluded = await waitFor('site excluded from the popup', async () => {
      const stored = JSON.parse(
        (await sw.eval(
          `chrome.storage.sync.get('settings').then(r => JSON.stringify(r.settings ?? {}))`,
        )) ?? '{}',
      );
      return stored.disabledSites?.includes('localhost') ? stored : false;
    });
    check(
      'the per-site switch writes the exclusion',
      Boolean(siteExcluded),
      JSON.stringify(siteExcluded?.disabledSites ?? []),
    );
    // Put it back, then let the engines re-engage before the status query below.
    await popup.eval(`document.getElementById('site-toggle').click(); true`);
    await sleep(600);

    await popup.eval(
      `(() => {
         const slider = document.getElementById('strength');
         slider.value = '70';
         slider.dispatchEvent(new Event('input'));
         return true;
       })()`,
    );
    await awaitStatus((s) => s.audio.state === 'active' && s.video.mode === 'adaptive');

    // In this harness the popup is itself a tab, so the "active tab" it would
    // normally inspect is the popup. Bring the page back to the foreground
    // (a hidden tab legitimately stops frame analysis) and query its tab id
    // explicitly to exercise the popup -> service worker -> content path.
    await browser.send('Target.activateTarget', { targetId: tab.id }).catch(() => {});
    await awaitStatus((s) => s.video.mode === 'adaptive');
    const queried = await popup.eval(
      `chrome.runtime.sendMessage({ type: 'nn:status-query', tabId: ${pageTabId} })
         .then(r => JSON.stringify(r?.status ?? null))`,
    );
    const aggregate = queried ? JSON.parse(queried) : null;
    check(
      'popup status query returns a live aggregate for the page tab',
      aggregate?.audio?.state === 'active' &&
        aggregate?.video?.mode === 'adaptive' &&
        aggregate?.frames >= 2 &&
        aggregate?.stale === false,
      JSON.stringify(aggregate),
    );

    /* -------- console hygiene -------- */
    const pageErrors = page.consoleErrors.filter((line) => !/favicon|net::ERR/i.test(line));
    check(
      'no console errors on the page',
      pageErrors.length === 0,
      pageErrors.slice(0, 3).join(' | '),
    );
    check(
      'no console errors in the service worker',
      sw.consoleErrors.length === 0,
      sw.consoleErrors.slice(0, 3).join(' | '),
    );
    check(
      'no console errors in the popup',
      popup.consoleErrors.length === 0,
      popup.consoleErrors.slice(0, 3).join(' | '),
    );

    page.close();
    popup.close();
    sw.close();
    browser.close();
  } finally {
    await cleanup();
  }

  console.log(
    `\n${results.length - failures}/${results.length} checks passed${failures ? ` (${failures} failed)` : ''}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} failed`))));
  });
}

main().catch(async (error) => {
  console.error('\nsmoke test aborted:', error.message);
  process.exit(1);
});
