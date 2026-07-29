/**
 * Builds the Chrome Web Store artifacts from the built extension.
 *
 *   npm run build && node scripts/store-shots.mjs
 *   npm install --no-save playwright   (once, if it is not already there)
 *
 * Writes `store-assets/`: three 1280x800 screenshots and the 440x280 promotional
 * tile, at exactly those sizes. The script measures its own output from the PNG
 * headers at the end and fails if a file is even one pixel off, because the store
 * rejects the upload rather than resizing it.
 *
 * Three rather than four. A fourth was drafted from the popup's other cards and
 * came out as the same composition again with less in it; a listing is read by
 * flicking through thumbnails, and two shots that look alike cost more attention
 * than the second one earns.
 *
 * Decisions worth knowing about.
 *
 * It loads `dist/`, not `src/`. `dist/` is what `npm run zip` packages and what a
 * reviewer installs, so it is what the pictures have to come from. The other
 * headless tools here (`smoke.mjs`, `popup-shot.mjs`) load the same directory over
 * the DevTools protocol; this one uses Playwright's `--load-extension` because it
 * needs several pages of the same profile open at once.
 *
 * Every pixel of interface in these files was rendered by the extension. A real
 * Chromium loads the real build, the content script finds the player on the
 * stand-in page, the tone filter is applied by the compositor, and the popup is
 * its own document. The only things this tool draws are the caption band, the
 * two "off/on" labels in the comparison, and the promotional tile. What the popup
 * says about the page is the extension's own report: the status lines are read
 * from the service worker's session store, not typed in here.
 *
 * The stand-in page is served by intercepting the request rather than from a local
 * HTTP server. A server would need a real host to be reachable, and every host
 * worth photographing is in Chromium's HSTS preload list, so `http://` is upgraded
 * to `https://` before the resolver sees it and the handshake fails with
 * ERR_SSL_PROTOCOL_ERROR. Fulfilling the route hands the document back through the
 * automation channel, so its origin really is `https://stand-in.example` — which
 * is what makes the content script run on it — with no certificate involved.
 *
 * Nothing on that page names or imitates anybody. This extension runs on every
 * http(s) page, so unlike a per-site extension it needs no real host's markup to
 * work, and the page can be entirely invented. The footage is drawn frame by frame
 * on a canvas and piped into a `<video>` through `captureStream()`, so the
 * repository still contains no binary media, and the frames are same-origin, which
 * is what lets the engine measure them and report `adaptive` rather than the fixed
 * curve. Both comparison halves are the same still scene, so the only difference
 * between them is the extension.
 *
 * Composition happens in the browser rather than through an image library. The
 * page being screenshotted is already a layout engine, so putting one PNG on top
 * of another is less code than a dependency, and the caption typography is set in
 * CSS instead of measured by hand. Every source is captured at exactly the size it
 * is placed at: where the interface needed to be larger, the popup is *zoomed*
 * before capture so it re-renders at that size, because enlarging a PNG afterwards
 * only produces a soft one. 1.9 is not arbitrary — the popup's graph canvases have
 * a backing store 1.93x their layout size (see `popup.css`), so that is as large as
 * they go before the compositor starts inventing pixels.
 *
 * The night restriction is off in the two shots that show the effect. That is a
 * build-reproducibility problem, not a cosmetic one: with it on, whether the
 * extension is processing anything at all depends on the clock at the moment the
 * script runs, and a store screenshot that differs between two builds of the same
 * commit is worse than one that names the setting it is using. The third shot has
 * the night window on at its real default hours and gets its determinism from the
 * site exclusion instead, which outranks the clock in `core/gate.ts`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import playwright from 'playwright';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = path.join(root, 'dist');
const out = path.join(root, 'store-assets');

/** Store sizes. The band is the caption strip; the stage is the picture under it. */
const WIDTH = 1280;
const HEIGHT = 800;
const BAND = 128;
const STAGE = HEIGHT - BAND;
/** The "off"/"on" strip above each half of the comparison. */
const SPLIT_LABEL = 30;
/** `.app` in `popup.css`. Chrome caps a popup at 600px tall, hence the density. */
const POPUP_WIDTH = 330;
const TILE = { width: 440, height: 280 };

/**
 * Reserved by RFC 2606, so it can never be a real site, and it says what it is
 * in the one place the popup shows a hostname ("Skip stand-in.example").
 */
const HOST = 'stand-in.example';
const SITE_URL = `https://${HOST}/`;

/** The shipped defaults, from `core/types.ts`. Each shot patches this. */
const DEFAULTS = {
  enabled: true,
  strength: 45,
  linked: true,
  audioStrength: 45,
  videoStrength: 45,
  audio: true,
  video: true,
  nightEq: false,
  disabledSites: [],
  nightOnly: true,
  nightStart: 21 * 60,
  nightEnd: 7 * 60,
  skipMusic: true,
};

const dataUrl = (buffer) => `data:image/png;base64,${buffer.toString('base64')}`;
const fileUrl = (file) => dataUrl(readFileSync(file));

/* ------------------------------ the stand-in ------------------------------ */

/**
 * A player page, invented from nothing. It needs to be a plausible thing to be
 * watching at midnight and nothing more: no wordmark, no imitation of anybody's
 * layout, and copy that could not be mistaken for a real listing.
 *
 * The footage is a still night interior — deep shadow detail, one blown-out
 * window — redrawn every animation frame so `captureStream()` keeps presenting
 * frames to measure while the content stays identical between captures. A moving
 * scene would make the off/on pair incomparable.
 */
const STAND_IN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Stand-in player</title>
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body {
    margin: 0;
    background: #0b0c10;
    color: #e6e8ee;
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  header {
    display: flex;
    align-items: center;
    gap: 16px;
    height: 52px;
    padding: 0 22px;
    border-bottom: 1px solid #1b1d24;
  }
  header .mark { width: 20px; height: 20px; border-radius: 6px; background: #3c4354 }
  header input {
    flex: 0 1 340px;
    padding: 6px 12px;
    border: 1px solid #262a33;
    border-radius: 999px;
    background: #14161c;
    color: #e6e8ee;
    font: inherit;
  }
  header .spacer { flex: 1 }
  header .avatar { width: 26px; height: 26px; border-radius: 50%; background: #39404f }
  main { display: flex; gap: 24px; padding: 18px 22px }
  /* Capped, and the list pushed flush right. At full width an uncapped player is
     540px tall and pushes its own title off the bottom of the frame. */
  .player { flex: 1 1 auto; min-width: 0; max-width: 800px }
  video {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    background: #000;
    border-radius: 10px;
  }
  .bar { height: 4px; margin: 10px 0 0; border-radius: 999px; background: #23262f }
  .bar span { display: block; width: 38%; height: 4px; border-radius: 999px; background: #6b7488 }
  .times { display: flex; justify-content: space-between; margin: 6px 0 0; color: #767e91; font-size: 12px }
  h1 { margin: 14px 0 0; font-size: 19px; font-weight: 650; letter-spacing: -0.01em }
  .sub { margin: 5px 0 0; color: #868ea1; font-size: 13px }
  aside { width: 252px; flex: none; margin-left: auto }
  aside p { margin: 0 0 10px; color: #7b839a; font-size: 11.5px; font-weight: 700; letter-spacing: 0.1em }
  aside .item { display: flex; gap: 10px; padding: 7px 0 }
  aside .thumb { width: 62px; height: 35px; flex: none; border-radius: 5px; background: #1d2129 }
  aside .t { font-size: 12.5px; line-height: 1.35 }
  aside .d { color: #767e91; font-size: 11.5px }
  /* Below the width where a sidebar makes sense the list moves under the player,
     two across, which is what keeps the 640px comparison halves from ending in
     dead space or cutting a row in half. */
  @media (max-width: 900px) {
    main { flex-direction: column; gap: 16px }
    aside { width: auto; margin-left: 0 }
    aside .items { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px }
    aside .item { padding: 5px 0 }
    /* Two, so the column ends above the fold instead of being cut through the
       middle of a row. */
    aside .item:nth-child(n + 3) { display: none }
  }
</style></head>
<body>
  <header>
    <span class="mark"></span>
    <input type="search" placeholder="Search" aria-label="Search">
    <span class="spacer"></span>
    <span class="avatar"></span>
  </header>
  <main>
    <div class="player">
      <video id="film" playsinline muted></video>
      <div class="bar"><span></span></div>
      <p class="times"><span>18:24</span><span>47:50</span></p>
      <h1>Chapter Seven &mdash; The Long Walk Home</h1>
      <p class="sub">Stand-in footage, drawn in the browser &middot; no real title, channel or account</p>
    </div>
    <aside>
      <p>UP NEXT</p>
      <div class="items">
        <div class="item"><span class="thumb"></span><span><span class="t">Chapter Eight &mdash; Low Tide</span><br><span class="d">41 min</span></span></div>
        <div class="item"><span class="thumb"></span><span><span class="t">A Quiet Interview</span><br><span class="d">28 min</span></span></div>
        <div class="item"><span class="thumb"></span><span><span class="t">Night Roads, Part One</span><br><span class="d">52 min</span></span></div>
        <div class="item"><span class="thumb"></span><span><span class="t">The Storm Sequence</span><br><span class="d">1 h 06 min</span></span></div>
      </div>
    </aside>
  </main>
<script>
(() => {
  const canvas = document.createElement('canvas');
  /* 640x360, the same as the manual test bench. Headless Chromium reads frames
     back through software GL, and at 960x540 that measured over the engine's
     1.2 ms budget, so it halved its sampling rate and — correctly — said so in the
     popup. A note about CPU headroom in a store screenshot describes this machine,
     not the extension, so the source is small enough not to provoke it. */
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  /* A city at night from a rooftop. The luminance spread is the point: a full-scale
     moon, mid-tone lit windows, and building tiers between 2% and 7% luma that a
     dim screen swallows whole. Flat blocks were the first attempt and photographed
     like a diagram, so everything here is graded, and a fixed grain pattern breaks
     up the banding the way a real encode would.

     Seeded, and identical on every frame: the off/on pair has to differ only by
     the extension, so random grain would put noise in the comparison. */
  const rand = (() => {
    let seed = 0x9e3779b9;
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();

  const MOON = { x: W * 0.71, y: H * 0.2, r: 23 };
  const grain = Array.from({ length: 2200 }, () => [rand() * W, rand() * H, rand()]);
  /** Back tier, front tier: [x, width, top, luma, lit-window count]. */
  const towers = [
    [0.0, 0.11, 0.52, 15, 5],
    [0.1, 0.08, 0.44, 12, 4],
    [0.17, 0.13, 0.57, 17, 6],
    [0.29, 0.07, 0.4, 11, 3],
    [0.35, 0.12, 0.5, 14, 5],
    [0.46, 0.09, 0.34, 10, 4],
    [0.54, 0.1, 0.55, 16, 5],
    [0.63, 0.08, 0.47, 12, 3],
    [0.7, 0.14, 0.6, 15, 6],
    [0.83, 0.09, 0.42, 11, 4],
    [0.91, 0.11, 0.53, 13, 5],
  ];
  const blocks = [
    [0.04, 0.16, 0.66, 5, 3],
    [0.2, 0.12, 0.72, 7, 3],
    [0.33, 0.18, 0.63, 4, 3],
    [0.52, 0.14, 0.7, 6, 3],
    [0.67, 0.16, 0.65, 4, 3],
    [0.84, 0.16, 0.74, 6, 3],
  ];

  /**
   * Walls and windows are resolved once, not per frame. They are placed with the
   * same seeded generator, and calling it inside the paint loop would move every
   * window on every frame — which would show up as the two halves of the
   * comparison disagreeing about the building, not about the tone curve.
   */
  const walls = [];
  const windows = [];
  for (const [tier, warm, floor] of [
    // The vertical limit keeps a back-tier window from being placed where the
    // front tier or the rooftop will later be painted over it.
    [towers, true, 0.6],
    [blocks, false, 0.83],
  ]) {
    for (const [x, w, top, luma, lights] of tier) {
      const px = W * x;
      const pw = W * w;
      const py = H * top;
      walls.push([px, pw, py, luma]);
      const span = Math.max(1, H * floor - py - 18);
      for (let i = 0; i < lights; i++) {
        windows.push([
          px + 8 + rand() * Math.max(1, pw - 22),
          py + 10 + rand() * span,
          Math.round(warm ? 60 + rand() * 55 : 26 + rand() * 18),
        ]);
      }
    }
  }

  function paint() {
    // Sky: near-black overhead, a thin warm haze on the horizon.
    const sky = ctx.createLinearGradient(0, 0, 0, H * 0.78);
    sky.addColorStop(0, 'rgb(3,4,9)');
    sky.addColorStop(0.62, 'rgb(11,13,22)');
    sky.addColorStop(0.86, 'rgb(26,22,26)');
    sky.addColorStop(1, 'rgb(38,29,25)');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // Moon: full scale, and the reason a bright cut hurts at 1 a.m.
    const halo = ctx.createRadialGradient(MOON.x, MOON.y, MOON.r * 0.8, MOON.x, MOON.y, 190);
    halo.addColorStop(0, 'rgba(226,236,255,0.5)');
    halo.addColorStop(0.35, 'rgba(190,208,240,0.12)');
    halo.addColorStop(1, 'rgba(160,180,220,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgb(255,255,255)';
    ctx.beginPath();
    ctx.arc(MOON.x, MOON.y, MOON.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgb(232,238,250)';
    ctx.beginPath();
    ctx.arc(MOON.x - 6, MOON.y + 4, MOON.r * 0.78, 0, Math.PI * 2);
    ctx.fill();

    // One thin cloud band across the moon. Three flat ellipses read as lens
    // artefacts rather than weather, so this one is graded out at both ends.
    const band = ctx.createLinearGradient(0, 0, W, 0);
    band.addColorStop(0, 'rgba(150,163,190,0)');
    band.addColorStop(0.45, 'rgba(150,163,190,0.14)');
    band.addColorStop(1, 'rgba(150,163,190,0)');
    ctx.fillStyle = band;
    ctx.beginPath();
    ctx.ellipse(W * 0.58, H * 0.27, W * 0.42, H * 0.035, 0, 0, Math.PI * 2);
    ctx.fill();

    // Two tiers of towers. The back tier carries the lit windows, which are the
    // only mid-tones in frame; the front tier is nearly black.
    for (const [px, pw, py, luma] of walls) {
      const wall = ctx.createLinearGradient(px, py, px + pw, py);
      wall.addColorStop(0, 'rgb(' + luma + ',' + (luma + 1) + ',' + (luma + 6) + ')');
      wall.addColorStop(
        1,
        'rgb(' + Math.max(2, luma - 5) + ',' + Math.max(2, luma - 4) + ',' + (luma + 1) + ')',
      );
      ctx.fillStyle = wall;
      ctx.fillRect(px, py, pw, H - py);
    }
    for (const [lx, ly, level] of windows) {
      ctx.fillStyle =
        'rgb(' + level + ',' + Math.round(level * 0.86) + ',' + Math.round(level * 0.62) + ')';
      ctx.fillRect(lx, ly, 7, 5);
    }

    // Rooftop in the foreground: the deepest black, with one rim highlight so the
    // edge is findable once the shadows open up.
    ctx.fillStyle = 'rgb(2,3,6)';
    ctx.beginPath();
    ctx.moveTo(0, H * 0.86);
    ctx.lineTo(W * 0.36, H * 0.82);
    ctx.lineTo(W, H * 0.88);
    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(178,196,232,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, H * 0.86);
    ctx.lineTo(W * 0.36, H * 0.82);
    ctx.lineTo(W, H * 0.88);
    ctx.stroke();
    // A rail, at 4% luma: the detail that decides whether a shadow lift works.
    ctx.strokeStyle = 'rgb(10,11,16)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(W * 0.06, H * 0.85);
    ctx.lineTo(W * 0.06, H * 0.97);
    ctx.moveTo(W * 0.24, H * 0.845);
    ctx.lineTo(W * 0.24, H * 0.99);
    ctx.stroke();

    for (const [gx, gy, g] of grain) {
      ctx.fillStyle = 'rgba(' + (g > 0.5 ? '226,232,244,0.05' : '0,0,0,0.16') + ')';
      ctx.fillRect(gx, gy, 1.4, 1.4);
    }
  }

  const stream = canvas.captureStream(30);

  /* A real audio track, so the audio half has something to attach to. A canvas
     capture is video-only, and audio-engine.ts deliberately spends no context on
     a stream with no audio tracks, so without this the popup would report
     "waiting for playback" next to a playing film. Low-level and continuous;
     nothing is audible, there is no audio device in headless Chromium. */
  const audio = new AudioContext();
  const dest = audio.createMediaStreamDestination();
  const osc = audio.createOscillator();
  osc.frequency.value = 180;
  const gain = audio.createGain();
  gain.gain.value = 0.04;
  osc.connect(gain);
  gain.connect(dest);
  osc.start();
  for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
  void audio.resume().catch(() => undefined);

  const video = document.getElementById('film');
  video.srcObject = stream;
  void video.play().catch(() => undefined);

  const frame = () => {
    paint();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
})();
</script>
</body></html>`;

/* ------------------------------- composition ------------------------------ */

/**
 * The caption band, in the popup's own palette (`popup.css`). A listing that
 * does not look like the product it is selling makes the reader wonder which of
 * the two is out of date, and a light band around a deliberately dark UI would
 * also defeat the point being made.
 */
const STYLE = `
  * { box-sizing: border-box }
  body {
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    margin: 0;
    overflow: hidden;
    background: #0a0e15;
    color: #eaeef7;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .head {
    display: flex;
    height: ${BAND}px;
    flex-direction: column;
    justify-content: center;
    padding: 0 56px;
    background:
      radial-gradient(120% 320% at 100% 0%, #17202f 0%, transparent 60%),
      #0a0e15;
  }
  .eyebrow {
    margin: 0;
    color: #e8bd7c;
    font-size: 11.5px;
    font-weight: 800;
    letter-spacing: 0.17em;
    text-transform: uppercase;
  }
  h1 {
    margin: 9px 0 0;
    font-size: 31px;
    font-weight: 700;
    letter-spacing: -0.025em;
    line-height: 1.15;
  }
  .note { margin: 7px 0 0; color: #8994a8; font-size: 15.5px }
  .stage {
    position: relative;
    width: ${WIDTH}px;
    height: ${STAGE}px;
    overflow: hidden;
    border-top: 1px solid #1f2839;
  }
  img.page { display: block; width: ${WIDTH}px; height: ${STAGE}px }
  img.popup {
    position: absolute;
    top: 24px;
    right: 26px;
    border-radius: 12px;
    box-shadow:
      0 0 0 1px rgba(232, 189, 124, 0.14),
      0 34px 80px -20px rgba(0, 0, 0, 0.85);
  }
  /* Two full-height captures, edge to edge, each screenshotted at exactly the
     width and height it sits at. A single 1280 shot scaled to a half is a soft
     shot. The labels get a strip of their own rather than floating over the page:
     the first version landed them on top of the stand-in page's search field. */
  .split { display: flex; height: 100% }
  .split .col { position: relative; width: ${WIDTH / 2}px }
  .split img { display: block }
  .split .lab {
    display: flex;
    height: ${SPLIT_LABEL}px;
    align-items: center;
    padding: 0 18px;
    background: #0d1420;
    color: #9aa5ba;
    font-size: 12.5px;
    font-weight: 650;
    letter-spacing: 0.02em;
  }
  .split .col + .col .lab { color: #f0d5a8; background: #131a26 }
  .split .col + .col { box-shadow: inset 2px 0 0 rgba(232, 189, 124, 0.45) }
  /* The stand-in disclosure rides in the label strip on this shot. As a corner
     badge it landed on top of the page's own text, and this is more legible. */
  .split .why { margin-left: auto; color: #7f8a9e; font-weight: 500 }
  /* Detail shots: the real popup, zoomed before capture, on a backdrop rather
     than floating on white. */
  .cards {
    display: flex;
    height: 100%;
    align-items: center;
    justify-content: center;
    gap: var(--gap, 34px);
    padding: 0 30px;
    background: radial-gradient(80% 130% at 50% 0%, #131a27 0%, #090c12 100%);
  }
  .cards img {
    display: block;
    border-radius: 12px;
    box-shadow:
      0 0 0 1px rgba(232, 189, 124, 0.12),
      0 26px 60px -26px rgba(0, 0, 0, 0.9);
  }

  /* Says out loud that the page under the extension is invented. The extension
     itself is the shipped build, and a picture that leaves the difference to be
     guessed at is asking to be misread. */
  .stamp {
    position: absolute;
    right: 14px;
    bottom: 13px;
    padding: 5px 9px;
    border-radius: 7px;
    color: rgba(234, 238, 247, 0.9);
    background: rgba(8, 11, 17, 0.72);
    font-size: 10.5px;
    font-weight: 600;
  }
`;

function frame({ eyebrow, title, note, body, stamp }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head>
<body>
  <div class="head">
    <p class="eyebrow">${eyebrow}</p>
    <h1>${title}</h1>
    <p class="note">${note}</p>
  </div>
  <div class="stage">
    ${body}
    ${stamp ? `<span class="stamp">${stamp}</span>` : ''}
  </div>
</body></html>`;
}

const STAND_IN = 'Stand-in page and footage &middot; the extension is the shipped build';

/** 440x280. The real icon, the name, one claim the code can support. */
function tile(icon) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box }
  body {
    display: flex;
    width: ${TILE.width}px;
    height: ${TILE.height}px;
    flex-direction: column;
    justify-content: center;
    margin: 0;
    padding: 0 34px;
    overflow: hidden;
    background:
      radial-gradient(60% 90% at 88% 8%, rgba(232, 189, 124, 0.16) 0%, transparent 62%),
      radial-gradient(125% 145% at 10% 0%, #26375a 0%, #131c2e 52%, #080a10 100%);
    color: #f3f6fc;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  img { display: block; width: 58px; height: 58px }
  h1 { margin: 18px 0 0; font-size: 33px; font-weight: 720; letter-spacing: -0.03em }
  p { margin: 9px 0 0; color: #e8bd7c; font-size: 15px }
</style></head>
<body>
  <img src="${icon}" alt="">
  <h1>Night Neutralizer</h1>
  <p>Dark scenes brighter. Loud parts quieter.</p>
</body></html>`;
}

async function shoot(context, name, html, size = { width: WIDTH, height: HEIGHT }) {
  const page = await context.newPage();
  await page.setViewportSize(size);
  await page.setContent(html, { waitUntil: 'load' });
  // Data URLs decode asynchronously; without this the first frame can be blank.
  await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
  await page.screenshot({ path: path.join(out, name) });
  await page.close();
  process.stdout.write(`  ${name}\n`);
}

/* -------------------------------- helpers -------------------------------- */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The box a contiguous run of the popup occupies, from the top of `first` to the
 * bottom of `last`, in the page's own CSS pixels.
 *
 * `locator.screenshot()` can only take one element, and the popup's cards are
 * siblings, so a slab of two or three of them needs the box worked out and handed
 * to `page.screenshot({ clip })`. At a device scale factor of 1 that comes out at
 * exactly one image pixel per CSS pixel, which is what keeps these captures the
 * size they are placed at.
 */
async function slab(page, first, last) {
  const a = await page.locator(first).boundingBox();
  const b = await page.locator(last).boundingBox();
  if (!a || !b) throw new Error(`could not measure ${first} .. ${last} in the popup`);
  const x = Math.min(a.x, b.x);
  return {
    x: Math.round(x),
    y: Math.round(a.y),
    width: Math.round(Math.max(a.x + a.width, b.x + b.width) - x),
    height: Math.round(b.y + b.height - a.y),
  };
}

/** Reads width and height out of the PNG header. No dependency, no guessing. */
function pngSize(file) {
  const buffer = readFileSync(file);
  if (buffer.length < 24 || buffer.readUInt32BE(12) !== 0x49484452) {
    throw new Error(`${path.basename(file)} is not a PNG with a leading IHDR chunk`);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function main() {
  if (!existsSync(path.join(dist, 'manifest.json'))) {
    process.stderr.write('dist/manifest.json is missing. Run `npm run build` first.\n');
    process.exit(1);
  }
  const icon = path.join(dist, 'icons', 'icon-128.png');
  if (!existsSync(icon)) {
    process.stderr.write(`${path.relative(root, icon)} is missing. Run \`npm run build\` first.\n`);
    process.exit(1);
  }
  mkdirSync(out, { recursive: true });
  const profile = mkdtempSync(path.join(tmpdir(), 'nn-store-'));

  const context = await playwright.chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: WIDTH, height: STAGE },
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      // The extension engages its audio chain on the first user gesture, which a
      // click supplies below. This only removes the race between the click and
      // the 1.2 s window in `audio-engine.ts`; it is a browser policy, not a
      // change to the extension.
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  // The stand-in page, answered without a network. Everything it needs is inline,
  // so anything else asked for under this host (a favicon) gets an empty 204
  // rather than a console error.
  await context.route(`https://${HOST}/**`, (route) =>
    route.request().url() === SITE_URL
      ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: STAND_IN_PAGE })
      : route.fulfill({ status: 204, body: '' }),
  );

  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).hostname;

  /**
   * An extension page, used only to write settings the way the popup writes
   * them. Content scripts see the change through `storage.onChanged`, so nothing
   * here reloads a page to apply one.
   */
  const control = await context.newPage();
  await control.goto(`chrome-extension://${id}/popup.html`);
  const apply = async (patch) => {
    await control.evaluate(
      (settings) => chrome.storage.sync.set({ settings }),
      { ...DEFAULTS, ...patch },
    );
    await wait(500);
  };

  // Night off for the shots about the effect: see the note at the top of the file.
  await apply({ nightOnly: false });

  /* --- the page, with the extension working on it -------------------------- */
  const site = await context.newPage();
  await site.setViewportSize({ width: WIDTH, height: STAGE });
  await site.goto(SITE_URL);
  await site.waitForFunction(() => {
    const video = document.querySelector('video');
    return Boolean(video) && video.readyState >= 2 && !video.paused;
  });
  await site.waitForSelector('video[data-nn-tone="1"]');
  // A real gesture, for the audio chain. `maybeEngage()` retries on pointerdown.
  await site.mouse.click(WIDTH / 2, 320);
  // The adaptation settles with a 0.3 s / 1.6 s time constant, so a shot taken
  // immediately shows a curve on its way somewhere rather than the real answer.
  await wait(3000);
  const heroShot = await site.screenshot();

  /* --- the popup, as its own document ------------------------------------- */
  /**
   * The popup asks `chrome.tabs.query` which tab to describe. Opened as a tab it
   * would describe itself, and report — correctly — that there is no media on it.
   * The stub answers with the tab the extension has actually reported on, found
   * through the extension's own session store, so every line the popup then
   * renders is its real reading of the real page.
   */
  const openPopup = async (viewport) => {
    const page = await context.newPage();
    await page.setViewportSize(viewport);
    await page.addInitScript((host) => {
      chrome.tabs.query = async () => {
        const stored = await chrome.storage.session.get('frameStatus');
        const map = stored.frameStatus ?? {};
        const found = Object.entries(map).find(([, frames]) =>
          Object.values(frames).some((entry) => entry.site === host),
        );
        return found ? [{ id: Number(found[0]) }] : [];
      };
    }, HOST);
    await page.goto(`chrome-extension://${id}/popup.html`);
    // init() loads settings, reads the shortcut and polls status once; the
    // switches animate into place over 140 ms.
    await wait(2500);
    return page;
  };

  const popup = await openPopup({ width: 460, height: 760 });
  const status = await popup.evaluate(() => ({
    audio: document.getElementById('audio-status').textContent,
    video: document.getElementById('video-status').textContent,
    site: document.getElementById('site-toggle').hidden
      ? '(no site button)'
      : document.getElementById('site-toggle-text').textContent,
  }));
  process.stdout.write(
    `  popup reports: ${status.audio} / ${status.video} / ${status.site}\n`,
  );
  const popupShot = await popup.locator('.app').screenshot();

  /* --- the same frame, processed and not ---------------------------------- */
  const half = { width: WIDTH / 2, height: STAGE - SPLIT_LABEL };
  await site.setViewportSize(half);
  await wait(1500);
  const onShot = await site.screenshot();
  await apply({ nightOnly: false, video: false });
  await site.waitForSelector('video[data-nn-tone="1"]', { state: 'detached' });
  await wait(600);
  const offShot = await site.screenshot();

  /* --- the panel, in two legible columns ---------------------------------- */
  /**
   * The settings behind this shot are the interesting ones: the night window on
   * with its real default hours, the sliders separated, and this host on the
   * exclusion list.
   *
   * The exclusion is also what makes the shot reproducible. `core/gate.ts` checks
   * the site before it checks the clock, so the status card reads the same at
   * three in the afternoon as at midnight; driven by the clock alone it would say
   * "waiting for 09:00 PM" in one build and "compressing 1 player" in the next.
   */
  await apply({
    linked: false,
    audioStrength: 70,
    videoStrength: 25,
    disabledSites: [HOST],
  });
  // The frame has to notice the change and report it, and the popup polls status
  // every 1.5 s, before the panel can name the site it is leaving alone.
  await wait(4500);

  const NIGHT_CARD = 'section.card[aria-labelledby="when-title"]';
  const columns = [
    ['.header', '#controls'],
    [NIGHT_CARD, 'section.card.status'],
  ];
  // Measured unzoomed, then zoomed to fit: the graph canvases hold their detail
  // up to 1.93x their layout size and no further, and the taller column has to
  // leave a margin inside the 672px stage.
  const boxes = await Promise.all(columns.map(([first, last]) => slab(popup, first, last)));
  const tallest = Math.max(...boxes.map((box) => box.height));
  const zoom = Math.min(1.9, Math.round(((STAGE - 84) / tallest) * 100) / 100);
  // `page.screenshot({ clip })` cannot reach outside the viewport, and zooming a
  // 330x556 panel to 1.7x makes it both wider and much taller than the window it
  // was opened in. The whole panel has to fit, not just the tallest column: the
  // second column starts halfway down it, so sizing this to the column alone left
  // the toggles sawn off at the bottom and the sliders cut down the right edge.
  const panel = await popup.locator('.app').boundingBox();
  await popup.setViewportSize({
    width: Math.ceil((panel?.width ?? POPUP_WIDTH) * zoom) + 60,
    height: Math.ceil((panel?.height ?? 600) * zoom) + 120,
  });
  await popup.evaluate((value) => {
    document.documentElement.style.zoom = String(value);
  }, zoom);
  await wait(800);
  process.stdout.write(`  panel columns zoomed to ${zoom}x\n`);

  const reported = await popup.evaluate(() => ({
    audio: document.getElementById('audio-status').textContent,
    night: document.getElementById('night-desc').textContent,
    site: document.getElementById('site-toggle').hidden
      ? '(no site button)'
      : document.getElementById('site-toggle-text').textContent,
  }));
  process.stdout.write(`  popup reports: ${reported.audio} / ${reported.night} / ${reported.site}\n`);

  const panels = [];
  for (const [first, last] of columns) {
    panels.push(await popup.screenshot({ clip: await slab(popup, first, last) }));
  }

  await popup.close();
  await site.close();
  await control.close();

  /* --- compose ----------------------------------------------------------- */
  await shoot(
    context,
    '01-tone-1280x800.png',
    frame({
      eyebrow: 'Night Neutralizer &middot; Chrome extension',
      title: 'Watch in the dark without the glare.',
      note: 'Shadows opened up, whites pulled back, quiet dialogue brought up to the effects. One slider, and it applies without a reload.',
      body:
        `<img class="page" src="${dataUrl(heroShot)}" alt="">` +
        `<img class="popup" src="${dataUrl(popupShot)}" alt="">`,
      stamp: STAND_IN,
    }),
  );

  await shoot(
    context,
    '02-picture-1280x800.png',
    frame({
      eyebrow: 'Night Neutralizer &middot; The picture',
      title: 'The same frame, and the same screen brightness.',
      note: 'A per-pixel tone curve, applied by the compositor: shadow detail separates, the moon stops burning. Nothing is inserted between the site and its video, so controls, captions and fullscreen keep working.',
      body:
        `<div class="split">` +
        `<div class="col"><p class="lab">Video processing off</p>` +
        `<img src="${dataUrl(offShot)}" alt=""></div>` +
        `<div class="col"><p class="lab">On &middot; strength 45, the default` +
        `<span class="why">${STAND_IN}</span></p>` +
        `<img src="${dataUrl(onShot)}" alt=""></div>` +
        `</div>`,
    }),
  );

  await shoot(
    context,
    '03-panel-1280x800.png',
    frame({
      eyebrow: 'Night Neutralizer &middot; The panel',
      title: 'Every control, and a straight answer about each.',
      note: 'Both graphs are drawn from the same maths the engines run, and the caption under each states the change in numbers. The status lines say what is happening right now — here, nothing, because this site is on the skip list.',
      body:
        `<div class="cards">` +
        `<img src="${dataUrl(panels[0])}" alt=""><img src="${dataUrl(panels[1])}" alt="">` +
        `</div>`,
      stamp: STAND_IN,
    }),
  );

  await shoot(context, 'promo-440x280.png', tile(fileUrl(icon)), TILE);

  await context.close();
  // Windows keeps a handle on Crashpad files for a moment after the browser
  // exits, so a failed profile cleanup must not fail the build.
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    process.stdout.write(`  (left ${profile} behind: ${error.code ?? error.message})\n`);
  }

  /* --- verify ------------------------------------------------------------- */
  const expected = [
    ['01-tone-1280x800.png', WIDTH, HEIGHT],
    ['02-picture-1280x800.png', WIDTH, HEIGHT],
    ['03-panel-1280x800.png', WIDTH, HEIGHT],
    ['promo-440x280.png', TILE.width, TILE.height],
  ];
  let bad = 0;
  for (const [name, width, height] of expected) {
    const size = pngSize(path.join(out, name));
    const ok = size.width === width && size.height === height;
    if (!ok) bad++;
    process.stdout.write(
      `  ${ok ? 'ok  ' : 'WRONG'} ${name}: ${size.width}x${size.height}` +
        (ok ? '\n' : ` (expected ${width}x${height})\n`),
    );
  }
  if (bad > 0) {
    process.stderr.write(`${bad} file(s) are not the size the store requires.\n`);
    process.exit(1);
  }
  process.stdout.write(`store assets in ${path.relative(root, out)}\n`);
}

await main();
