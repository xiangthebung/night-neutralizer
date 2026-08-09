/**
 * Dev utility: screenshot the popup at a given strength so its visual state can
 * be reviewed without clicking through the browser.
 *
 *   node scripts/popup-shot.mjs [strength] [outfile]
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findChrome } from './find-chrome.mjs';

const strength = Number(process.argv[2] ?? 45);
// Defaults into the OS temp directory rather than a hard-coded /tmp.
const outFile = process.argv[3] ?? path.join(tmpdir(), 'nn-popup.png');
const CHROME = findChrome();
const port = 9351 + (Number(process.env.SHOT_OFFSET) || 0);
const profile = await mkdtemp(path.join(tmpdir(), 'nn-shot-'));
const dist = path.resolve('dist');

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--enable-unsafe-extension-debugging',
    '--force-device-scale-factor=2',
    '--window-size=460,900',
    '--no-first-run',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
await new Promise((r) => setTimeout(r, 2500));

const connect = async (url) => {
  const ws = new WebSocket(url);
  await new Promise((res) => ws.addEventListener('open', res, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result ?? m.error);
      pending.delete(m.id);
    }
  });
  return {
    ws,
    send: (method, params = {}) =>
      new Promise((resolve) => {
        const mid = ++id;
        pending.set(mid, resolve);
        ws.send(JSON.stringify({ id: mid, method, params }));
        setTimeout(() => resolve({ timeout: true }), 10_000);
      }),
  };
};

const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const browser = await connect(version.webSocketDebuggerUrl);
const { id: extensionId } = await browser.send('Extensions.loadUnpacked', { path: dist });
await new Promise((r) => setTimeout(r, 1200));

const openTab = async (url) =>
  (
  await (
    await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  ).json()
  );

// Seed the requested strength through the service worker so the popup renders it.
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const swTarget = targets.find(
  (t) => t.url === `chrome-extension://${extensionId}/service-worker.js`,
);
if (swTarget) {
  const sw = await connect(swTarget.webSocketDebuggerUrl);
  await sw.send('Runtime.evaluate', {
    expression: `chrome.storage.sync.set({ settings: ${JSON.stringify({
      enabled: true,
      strength,
      // SPLIT=1 renders the separated audio/video sliders, NIGHT_EQ=1 the EQ row.
      linked: process.env.SPLIT !== '1',
      audioStrength: Number(process.env.AUDIO_STRENGTH ?? strength),
      videoStrength: Number(process.env.VIDEO_STRENGTH ?? strength),
      audio: true,
      video: true,
      nightEq: process.env.NIGHT_EQ === '1',
      disabledSites: [],
      // Shown by default: the night window row is part of the worst-case height,
      // so measuring it hidden would flatter the layout. NIGHT_ONLY=0 hides it.
      nightOnly: process.env.NIGHT_ONLY !== '0',
      nightStart: 21 * 60,
      nightEnd: 7 * 60,
      skipMusic: true,
    })} })`,
    awaitPromise: true,
  });
  sw.ws.close();
}

const tab = await openTab(`chrome-extension://${extensionId}/popup.html`);
const page = await connect(tab.webSocketDebuggerUrl);
await page.send('Runtime.enable');
await page.send('Page.enable');
// Long enough for the async work in init() (settings load, commands.getAll,
// first status poll) to have settled, otherwise the measurement below describes
// a popup that is still filling in.
await new Promise((r) => setTimeout(r, 3000));

/*
 * Chrome caps a popup at 600 CSS px and scrolls beyond that, so the height is
 * part of the design budget. The worst case is a page where the per-site button
 * is showing, which this profile has no way to produce, so it is measured by
 * revealing the button directly.
 */
const size = await page.send('Runtime.evaluate', {
  expression: `(() => {
     const app = document.querySelector('.app');
     const h = document.body.scrollHeight;
     const button = document.getElementById('site-toggle');
     const wasHidden = button.hidden;
     button.hidden = false;
     const withSite = document.body.scrollHeight;
     button.hidden = wasHidden;
     const keys = document.getElementById('shortcut-keys');
     return JSON.stringify({
       w: app.offsetWidth,
       // The app column has a fixed width, so its own measurement can never
       // reveal a stretched popup. Chrome sizes the popup from the document, so
       // that is what has to be watched: it once rendered at the 800 px cap with
       // the column stranded on the left, and this measurement was blind to it.
       docWidth: document.documentElement.getBoundingClientRect().width,
       h,
       withSite,
       shortcutShown: !document.getElementById('shortcut').hidden,
       shortcutKeys: JSON.stringify(keys.textContent),
     });
   })()`,
  returnByValue: true,
});
const { w, h, docWidth, withSite, shortcutShown, shortcutKeys } = JSON.parse(size.result.value);
const verdict = withSite > 600 ? `OVER the 600 cap by ${withSite - 600}` : 'fits the 600 cap';
console.log(
  `strength ${strength}: popup is ${w} x ${h} CSS px ` +
    `(${withSite} with the per-site button) — ${verdict}`,
);
console.log(
  docWidth > w
    ? `WIDTH REGRESSION: the document is ${docWidth} px against a ${w} px column, ` +
        `so Chrome will render the popup stretched`
    : `document width ${docWidth} px matches the ${w} px column`,
);
console.log(`shortcut hint: ${shortcutShown ? `shown, keys=${shortcutKeys}` : 'hidden'}`);

const shot = await page.send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: true,
  clip: { x: 0, y: 0, width: w, height: h, scale: 1 },
});
await writeFile(outFile, Buffer.from(shot.data, 'base64'));
console.log(`wrote ${outFile}`);

page.ws.close();
browser.ws.close();
chrome.kill('SIGKILL');
// Windows keeps a handle on Crashpad files for a moment after the kill, so a
// failed profile cleanup must not mask a successful screenshot.
await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
  (error) => console.warn(`could not remove the temp profile: ${error.code ?? error.message}`),
);
