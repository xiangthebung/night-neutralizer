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

const strength = Number(process.argv[2] ?? 45);
const outFile = process.argv[3] ?? '/tmp/popup.png';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
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
    expression: `chrome.storage.sync.set({ settings: { enabled: true, strength: ${strength}, audio: true, video: true } })`,
    awaitPromise: true,
  });
  sw.ws.close();
}

const tab = await openTab(`chrome-extension://${extensionId}/popup.html`);
const page = await connect(tab.webSocketDebuggerUrl);
await page.send('Runtime.enable');
await page.send('Page.enable');
await new Promise((r) => setTimeout(r, 1200));

const size = await page.send('Runtime.evaluate', {
  expression: `JSON.stringify({ w: document.querySelector('.app').offsetWidth, h: document.body.scrollHeight })`,
  returnByValue: true,
});
const { w, h } = JSON.parse(size.result.value);
console.log(`strength ${strength}: popup is ${w} x ${h} CSS px (Chrome caps popups at 600 tall)`);

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
await rm(profile, { recursive: true, force: true });
