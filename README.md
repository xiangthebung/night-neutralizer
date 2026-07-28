# Night Neutralizer

A Chrome extension for watching and listening in a dark room. It reduces the
**dynamic range** of both video and audio so you can keep the screen dim and the
volume low without losing dark scenes or quiet dialogue — and without being
ambushed by a bright cut or an explosion.

- **Audio:** Web Audio compressor + make-up gain + limiter per media element.
- **Video:** adaptive tone mapping (shadow lift, highlight roll-off, flash
  guard) driven by real per-frame luminance measurements.
- **Local only:** one permission (`storage`), no network access, no accounts,
  no telemetry, no remote code.

---

## Table of contents

- [Install and build](#install-and-build)
- [Using it](#using-it)
- [Architecture](#architecture)
- [Audio processing](#audio-processing)
- [Video processing](#video-processing)
  - [Why not canvas or WebGL?](#why-not-canvas-or-webgl)
  - [What "adaptive" means here](#what-adaptive-means-here)
- [Performance](#performance)
- [Limitations (read this)](#limitations-read-this)
- [Privacy](#privacy)
- [Permissions, and how to narrow them](#permissions-and-how-to-narrow-them)
- [Testing](#testing)
- [Project layout](#project-layout)
- [License](#license)

---

## Install and build

Requirements: Node 18+ and Chrome 111+.

```bash
npm install
npm run build          # -> dist/
```

Then load it:

1. open `chrome://extensions`
2. turn on **Developer mode** (top right)
3. click **Load unpacked**
4. select the `dist/` folder

Other commands:

| command | what it does |
| --- | --- |
| `npm run build` | production build into `dist/` (minified) |
| `npm run build:dev` | unminified build with inline sourcemaps and debug logging |
| `npm run watch` | rebuild TS on change (re-run for `manifest.json`/`popup.html` edits) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | unit tests (Vitest) |
| `npm run verify` | typecheck + unit tests + production build |
| `npm run smoke` | end-to-end checks in real headless Chrome |
| `npm run testpage` | serves the manual test bench on `http://localhost:8791` |
| `npm run zip` | build and package `night-neutralizer.zip` |

There are no runtime dependencies. The build is esbuild only, and the icons are
generated at build time by `scripts/icons.mjs`, so the repository contains no
binary assets.

---

## Using it

Click the toolbar icon:

- **On/off** — master switch. Off means nothing is processed anywhere.
- **Neutralization strength (0–100)** — higher strength means stronger
  dynamic-range compression: quiet gets louder, loud gets quieter, shadows get
  lifted further and highlights roll off earlier. Lower strength keeps more of
  the original contrast and punch. **0 is a complete bypass.** Default is 45.
  The thumbnail beside the slider is the actual tone curve for the chosen
  strength, drawn with the same `buildToneCurve()` the content script uses,
  against a dotted "no change" diagonal. The shaded band is the range the curve
  moves within as scenes get darker or brighter, so its width shows how much
  adaptation headroom the setting has.
- **Audio** / **Video** — process each independently.
- **Right now on this tab** — shows what is actually happening: how many players
  are being compressed, and whether video is running *adaptive tone mapping*
  (frames are being measured) or a *fixed night curve* (frames cannot be read,
  e.g. DRM).

Changes apply immediately to open tabs; no reload. Settings live in
`chrome.storage.sync`, so they follow your Chrome profile.

**Keyboard shortcut:** `Alt+Shift+N` toggles the extension on and off without
opening the popup — handy when a scene is already too bright and you just want it
gone. Remap it at `chrome://extensions/shortcuts`.

All controls are native form elements: tab to them, toggle with `Space`, move
the slider with arrow keys / `Home` / `End`. The slider announces both the value
and its label ("70 of 100, Strong") via `aria-valuetext`, and the status block is
an `aria-live` region.

---

## Architecture

```
popup (popup.ts)                    service worker (service-worker.ts)
  │  writes settings                   │  seeds defaults on install
  │                                    │  relays + aggregates status
  ▼                                    ▲
chrome.storage.sync  ──onChanged──►  content script (one per frame)
                                       │
                        ┌──────────────┼───────────────┐
                        ▼              ▼               ▼
                 MediaRegistry    AudioEngine     VideoEngine
                 (discovery,      (Web Audio      (measure frames,
                  dedupe,          DRC chain)      push tone curve)
                  lifecycle)                            │
                                                        ▼
                                                   ToneFilter
                                              (SVG LUT + CSS rule)
```

Design notes:

- **Settings flow through storage, not messages.** The popup only writes a key;
  every content script reacts to `chrome.storage.onChanged`. That is why applying
  a change needs no tab permissions and no page reload.
- **Pure core, impure edges.** All parameter maths (`core/strength.ts`,
  `core/tone-curve.ts`), settings validation and status aggregation are pure
  modules with no DOM or Chrome dependency, which is what makes them unit
  testable. Everything that touches the DOM or Web Audio lives in `content/`.
- **The service worker holds no page data.** It stores only per-frame status
  summaries (counts and states, no URLs) in `chrome.storage.session`, which never
  hits disk, and drops them when a tab closes.
- **One instance per frame.** The content script guards against double
  initialisation and cleans up on `pagehide`.

### Media discovery and lifecycle

`content/media-registry.ts` handles the messy part of real sites:

- initial `querySelectorAll('video, audio')` plus a bounded walk into **open
  shadow roots** (custom-element players), which are then observed too;
- a `MutationObserver` for elements added later, batched in a microtask, with a
  fall back to a single full rescan if a page produces a mutation storm;
- capture-phase `play`/`loadedmetadata` listeners on `document` as a second
  discovery path (media events do not bubble, but they do capture);
- **duplicate protection** via a `Set` of tracked elements. This is not
  cosmetic: calling `createMediaElementSource()` twice on one element throws and
  can leave it silent forever;
- **removal with a 4 s grace period.** Single-page players constantly re-parent
  their `<video>`; tearing down and rebuilding the audio graph on every move
  would click and drop audio. Cleanup only happens if the element is still
  disconnected after the delay.

---

## Audio processing

Per element, created lazily on first playback:

```
MediaElementSource → preGain → DynamicsCompressor → makeupGain
                   → limiter → safety soft clipper → destination
```

| stage | role |
| --- | --- |
| `preGain` | pushes quiet material into the compressor knee |
| compressor | the actual range reduction, soft knee, release grows with strength |
| `makeupGain` | computed so a 0 dBFS peak lands near −4 dBFS |
| limiter | ratio 20, 2 ms attack, −2 dB threshold: catches transients only |
| safety clipper | instantaneous `WaveShaper`, bounded at 0.99, so nothing can reach the sink above full scale |

Mapping (from `core/strength.ts`, verified by unit tests):

| strength | threshold | ratio | knee | attack | release | pre | make-up | knee upper edge | quiet-vs-loud gain |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | — | 1.00 | — | — | — | 0 | 0 | — | 0.0 dB (bypass) |
| 25 | −13.1 | 1.47 | 22 | 27 ms | 277 ms | +0.8 | +0.5 | +8.4 | 4.4 dB |
| 45 | −18.5 | 2.28 | 17 | 21 ms | 322 ms | +2.1 | +1.5 | −1.3 | 11.6 dB |
| 70 | −25.7 | 3.35 | 11 | 13 ms | 383 ms | +3.9 | +2.9 | −14.2 | 20.8 dB |
| 100 | −30.0 | 4.00 | 8 | 8 ms | 420 ms | +5.0 | +3.8 | −22.0 | 26.3 dB |

The last column is `(preGain − threshold) × (1 − 1/ratio)`: how much more gain a
sub-threshold whisper receives than a full-scale peak. That differential is the
whole point of the feature.

And this is what the chain actually measures, rendered offline through
`OfflineAudioContext` with a 300 Hz test signal (see
[TESTING.md](TESTING.md#2-automated-end-to-end-in-real-chrome)):

| measured | strength 0 | strength 45 | strength 100 |
| --- | --- | --- | --- |
| quiet passage (−48.0 dBFS in) | −48.01 | −41.10 | −26.55 |
| loud passage (−3.0 dBFS in) | −3.01 | −3.15 | −4.65 |
| usable range | 45.0 dB | 38.0 dB | 21.9 dB |
| worst peak, incl. a full-scale burst | −3.01 | −0.18 | −0.28 |
| added latency | 0 | 12.00 ms | 12.00 ms |

Choices worth explaining:

- **Ratio stops at 4:1 and release *lengthens* with strength.** Aggressive
  ratios with short releases are what make compression audible as pumping. The
  slider gets stronger by lowering the threshold and adding make-up gain, not by
  squashing faster.
- **Threshold and knee move together.** Chromium's soft knee spans
  `threshold .. threshold + knee`, and inside it the effective ratio is far below
  the nominal one. An early threshold plus a wide knee therefore leaves loud
  material almost untouched — the offline render measured 0.05 dB of reduction on
  a 0 dBFS passage before this was corrected. From the mid range up, the knee's
  upper edge now sits below full scale.
- **Chromium's compressor has its own make-up gain.** Its kernel adds roughly
  0.6× the full-range reduction automatically, so any make-up we add stacks on
  top. `chromiumInternalMakeupDb()` subtracts it. Without that correction the
  same render measured +32 dB on quiet material and peaks at +3.3 dBFS, i.e.
  hard clipping.
- **A soft clipper ends the chain.** Every gain stage has a finite attack time,
  so an abrupt full-scale transient after a quiet passage outruns both the
  compressor and the limiter; measured overshoot was +0.5 dBFS. Web Audio has no
  look-ahead limiter, but a `WaveShaperNode` is instantaneous: identity below
  0.9, then a smooth bend towards a 0.99 ceiling, with 6 dB of working headroom
  above full scale. Peaks are now bounded at −0.2 dBFS.
- **Bypass at 0 is real:** ratio 1, unity gains, 0 dB thresholds. The mapping is
  continuous (smoothstep), so nudging the slider off 0 produces a gentle change,
  not a jump.
- **Site controls keep working.** `volume` and `muted` are applied by the element
  *before* the Web Audio graph, so volume sliders, mute buttons, keyboard
  shortcuts and the tab audio indicator behave normally.
- **Graphs are built only when the context is running.** Connecting a media
  element to a suspended `AudioContext` silences it, so the source node is
  created only after `resume()` succeeds. Under autoplay restrictions the
  extension waits for the first user gesture and leaves playback untouched
  meanwhile.
- **Cross-origin safety net.** Media served cross-origin without CORS produces a
  *silent* Web Audio graph. Such elements are classified as risky
  (`core/media-origin.ts`) and verified with a 2.5 s silence probe on an
  `AnalyserNode` tap; if nothing comes through, the context is closed, which hands
  playback straight back to the element. MSE/blob sources (YouTube, Vimeo) and
  same-origin or `crossorigin`-attributed media skip the probe entirely.

---

## Video processing

The effect is a per-pixel transfer function, not a brightness reduction:

1. **exposure** — `v = x · exposure`, only ever below 1, and only for scenes
   that measure bright.
2. **shadow opening** — `v = v^(1/γ)` plus a small absolute black lift, so
   near-black detail separates instead of staying crushed.
3. **highlight shoulder** — above a knee `k`, `v = k + a·(1 − e^−((v−k)/a))`.
   Slope is exactly 1 at the knee and decreases from there, so mid-tone contrast
   survives while highlights compress instead of clipping. `a` is solved by
   bisection so input 1.0 lands exactly on the requested white point.
4. **saturation compensation** — a per-channel curve desaturates slightly; a
   final `feColorMatrix type="saturate"` puts it back.

Sampled into a 33-entry LUT and applied by the compositor through an SVG filter:

```html
<filter id="nn-tone-curve" color-interpolation-filters="sRGB">
  <feComponentTransfer>
    <feFuncR type="table" tableValues="0.055 0.13 0.19 …"/>  <!-- G, B identical -->
  </feComponentTransfer>
  <feColorMatrix type="saturate" values="1.14"/>
</filter>
```

```css
video[data-nn-tone="1"] { filter: url("#nn-tone-curve") !important; }
```

Curve output for a given input level:

| input | 0.00 | 0.05 | 0.25 | 0.50 | 0.90 | 1.00 |
| --- | --- | --- | --- | --- | --- | --- |
| strength 45, dark scene | 0.028 | 0.134 | 0.376 | 0.610 | 0.844 | 0.871 |
| strength 45, bright scene | 0.019 | 0.107 | 0.341 | 0.581 | 0.868 | 0.911 |
| strength 100, full | 0.075 | 0.274 | 0.509 | 0.598 | 0.644 | 0.650 |

At the default, deep shadows gain roughly 2.7×, mid-tones move moderately, and
white is pulled back to 0.87 — the "painful whites" problem. Note the two
strength-45 rows: the same setting opens shadows harder on a dark scene and
holds highlights back harder on a bright one. That is the adaptation working.

Verified against *rendered pixels*, not just the maths: the smoke test
screenshots a static grey-ramp video through the compositor.

| measured on the screenshot | strength 0 | strength 45 (default) | strength 100 |
| --- | --- | --- | --- |
| absolute black | 0.000 | 0.027 | 0.071 |
| shadow detail (5th–20th percentile) | 0.010 | 0.052 | 0.117 |
| brightest decile | 1.000 | 0.816 | 0.639 |
| overall mean | 0.409 | 0.422 | 0.430 |

Shadows come up, highlights come down, and the average stays put — the image is
range-compressed rather than dimmed or washed out.

### Why not canvas or WebGL?

All the realistic options were considered before picking this one:

| approach | per-pixel curve | scene-adaptive | works on DRM | keeps player UI intact | cost |
| --- | --- | --- | --- | --- | --- |
| CSS `brightness()`/`contrast()` | affine only | no | yes | yes | free (GPU) |
| **SVG `feComponentTransfer` via CSS `filter`** | **yes** | **yes, with a separate measurement** | **yes** | **yes** | **free (GPU)** |
| Canvas 2D overlay, redraw each frame | yes | yes | **no** — `drawImage` of protected video yields black; `getImageData` throws for cross-origin | **no** — must hide the real video, breaking controls, captions, fullscreen, aspect ratio | high CPU, full-resolution copy per frame |
| WebGL shader overlay | yes | yes | **no** — `texImage2D` throws on a tainted video | no (same as above) | GPU upload per frame |
| `captureStream()` / WebCodecs re-encode | yes | yes | no (same restrictions) | no | very high |
| `requestVideoFrameCallback` | n/a (timing hook only) | n/a | n/a | n/a | — |

The decisive insight: **reading frames is restricted, painting a filter over
them is not.** So rendering is done by the compositor (works everywhere,
including protected content, at zero CPU cost and without touching the page's
DOM), and only the *measurement* uses a canvas read-back — of a 48×27
thumbnail, 8 times per second. When that measurement is blocked, the extension
loses adaptivity but keeps the effect.

An overlay pipeline would also have broken most of the requirements: subtitle
layers, native controls, fullscreen and aspect-ratio handling all stay correct
precisely *because* nothing is inserted between the site and its video element.

### What "adaptive" means here

Measurement runs **once per presented video frame**, via
`requestVideoFrameCallback` on the primary video (largest visible playing one).
Each measurement:

- draws the frame into a 48×27 canvas and reads it back,
- builds a 64-bin luminance histogram (Rec. 709 weights) and extracts mean,
  10th percentile (shadow depth), 90th percentile and 99.5th percentile,
- advances the state with **asymmetric time constants**: dimming uses τ = 0.3 s
  (react quickly to protect the viewer), recovery uses τ = 1.6 s (no visible
  breathing). Shadow lift and highlight roll-off follow the measured shadow and
  highlight levels, so dark scenes get opened up and bright scenes get held
  back, rather than everything being flattened equally,
- rebuilds the LUT and writes it to the filter, but only if it changed.

A 250 ms timer handles upkeep only (our nodes, the primary choice, fullscreen).
Frame skipping keeps the cost bounded: if a read-back measures above 1.2 ms the
engine samples every 2nd, 4th or 8th frame. Where `requestVideoFrameCallback` is
unavailable it falls back to measuring on an 8 Hz timer. Analysis stops entirely
while the tab is hidden.

**Flash guard.** The mean luminance must rise both *fast* and *far*: the
threshold is a rate (1.2–4.0 luma/second depending on strength), not a
per-sample delta, so it means the same thing whether we are sampling at 60 Hz or
8 Hz. A qualifying jump instantly dips exposure (up to 45%) *and* pulls the
white point down (a further 0.45 × the flash amount), then decays with τ =
0.55 s. Both parts matter: exposure alone gets damped by the shoulder exactly
where the glare is. Measured on a controlled white flash at the default
strength, the encoded white level goes 0.819 → 0.741 and back.

Its honest limit: this is a *reactive* guard. It measures a frame that has
already been presented, so the dim lands on the following frame (~16 ms at
60 fps) and the first frame of a flash is not attenuated. There is no frame
lookahead available to an extension, so pre-emption is not possible. What it can
do — and does — is stop a bright cut or a multi-frame strobe from staying
painful.

The popup reports `adaptive` only when frames are really being measured. If they
cannot be read, it says **fixed night curve** and the applied curve is a static,
non-adaptive one (`staticAdaptState`) sitting in the upper part of the adaptive
range — 0.8 of the lift and 0.85 of the roll-off, since one fixed curve has to
serve both dark and bright scenes. The extension does not describe a static
filter as adaptive.

---

## Performance

- **The effect itself costs no per-frame JavaScript.** The LUT is applied by the
  compositor. A curve update is one attribute write, throttled to ~33/s and
  skipped when the curve is unchanged (a rising flash bypasses the throttle so
  it lands on the next frame).
- **Measurement** is one 48×27 `drawImage` + `getImageData` per sampled frame,
  measured at **0.013 ms per sample** on the synthetic 640×360 test clip in
  headless Chrome. End to end, running the analysis at frame rate cost
  **2.8% of one core** in the smoke test (0.109 s → 0.249 s of script time over
  a 5 s window). A 4K source costs more because of the GPU→CPU read-back, so the
  engine measures its own cost and skips frames (2×, 4×, 8×) to stay inside the
  budget.
- **Idle pages cost nothing.** No video element means no filter, no timers. No
  playback means no audio context.
- **Audio latency: 12.00 ms**, measured by rendering an impulse through the
  chain (576 samples at 48 kHz — the two compressor stages' internal look-ahead;
  the soft clipper is instantaneous and adds none). It is constant, so audio and
  video stay in sync.
- **Hidden tabs** stop frame analysis entirely.
- At most **4 simultaneous audio graphs** per frame (Chromium limits concurrent
  `AudioContext`s); extra players are reported as skipped rather than broken.

---

## Limitations (read this)

**DRM / protected content (Netflix, Prime Video, Disney+, Max, Spotify web,
and similar).** Encrypted media (EME/Widevine) cannot be read back — by design,
and the extension makes no attempt to work around it. Detection is via
`video.mediaKeys` and, as a backstop, frames that read back black while playing.
Consequences:

- Audio compression works normally on these sites (the audio graph does not need
  frame access).
- Video gets the **static** night curve, not scene-adaptive tone mapping.
- On desktop Chrome (software/L3 decryption) the CSS filter is applied by the
  compositor and you will see the effect. If your system uses a **protected
  hardware video overlay** (some Windows and ChromeOS configurations with L1
  decryption), the video surface bypasses CSS effects entirely and you may see no
  change at all. There is no legitimate way for an extension to change that.

**Other known limits:**

- **Picture-in-Picture** and casting (Chromecast/AirPlay) render on a separate
  surface: no filter.
- **Cross-origin audio without CORS** cannot be processed. The extension detects
  it, restores native playback, and says so in the popup.
- **Muted autoplay** video gets audio processing only after your first click or
  key press on the page (browser autoplay policy).
- **Native `<track>` captions** are drawn inside the video by the browser, so
  they are tone-mapped too (slightly less blinding white — usually desirable).
  Site-rendered subtitle layers, such as YouTube's, are outside the video element
  and untouched.
- **Very high-resolution video with a filter** can push some GPU/driver
  combinations onto a slower compositing path. If a 4K stream stutters, lower the
  strength or turn video processing off for that session.
- **`file://` pages** are not covered unless you enable *Allow access to file
  URLs* for the extension on `chrome://extensions`.
- **A hidden/background tab** shows `fixed night curve` until it becomes visible
  again, because analysis is paused to save CPU.
- **The flash guard is reactive, not predictive.** It dims the frames *after* the
  one that triggered it (~16 ms at 60 fps). A single-frame flash is therefore
  shortened, not removed. Frame lookahead is not available to an extension.
- **Very low frame-rate video** (a few fps) gives the guard little to work with:
  consecutive frames are far apart in time, so a bright cut looks like a gradual
  ramp and is handled by the slower scene adaptation instead.
- **Saturation compensation is global** (`saturate()`), not perceptual. At
  maximum strength, extremely saturated highlights can shift slightly.
- **Chrome-owned pages** (`chrome://`, the Web Store, other extensions) cannot be
  modified by any extension.

---

## Privacy

- **No network access at all.** Nothing is fetched at runtime; no remote code, no
  analytics, no accounts, no crash reporting.
- **No page content leaves the frame.** Frame pixels are read into a 48×27
  buffer, reduced to four numbers, and thrown away. They are never stored,
  transmitted, or exposed to the page.
- **What is stored:** your four settings in `chrome.storage.sync`, and short-lived
  per-frame status summaries (counts, states, note strings — no URLs, no titles)
  in `chrome.storage.session`, which is memory-only and cleared when Chrome
  closes. Tab entries are deleted when the tab closes.
- **Production builds log nothing** to the page console.

## Permissions, and how to narrow them

`manifest.json` requests exactly one permission:

- `storage` — saving your settings and the in-memory status snapshot.

The `commands` key (for the keyboard shortcut) is not a permission and shows no
warning. There are **no** `host_permissions`, no `tabs`, no `scripting`, no
`activeTab`, no `webRequest`. The content script is declared statically for
`http://*/*` and `https://*/*` with `all_frames: true`, because the extension
has to be able to see a player on whatever page you are watching, including
players inside iframes.

If you would rather run it only where you need it, edit the `matches` array in
`src/manifest.json` before building, for example:

```json
"matches": ["https://*.youtube.com/*", "https://*.vimeo.com/*"]
```

Chrome will then only inject the content script on those sites.

---

## Testing

Unit tests (`npm test`, 119 tests) cover the strength → parameter mapping,
tone-curve maths and adaptation behaviour (including sampling-rate-independent
flash detection), the safety clipper, media discovery and duplicate prevention,
settings persistence, origin classification, and status aggregation.

The end-to-end suite (`npm run smoke`, 42 checks) drives real headless Chrome
over the DevTools protocol: it installs the built extension, plays generated
media, and asserts that the filter is applied, that the curve *changes across a
scene change*, that **screenshotted pixels** show lifted shadows and compressed
highlights at the default strength, that a controlled white flash is dimmed and
then released, that the analysis cost stays small, that the audio graph engages,
that settings apply live, that nested frames are covered, and that no console
errors are produced.

It also **renders the audio chain offline** and measures the result: bypass
transparency to 0.01 dB, the quiet-vs-loud differential at each strength, that
peaks never reach full scale even on an abrupt full-scale burst, and the exact
latency. Two shipped bugs were found this way — see the audio section. No audio
device is involved, so nothing is ever audible.

Manual test procedures for YouTube, Vimeo, a local HTML5 page and a DRM site,
plus performance and failure-mode checks, are in **[TESTING.md](TESTING.md)**.

---

## Project layout

```
src/
  manifest.json            MV3 manifest (permissions: storage)
  core/                    pure, testable, no DOM
    types.ts               settings + parameter + status shapes
    math.ts                clamp/lerp/smoothstep/approach/dB helpers
    strength.ts            slider -> audio & video parameters
    soft-clip.ts           final safety clipper curve
    tone-curve.ts          scene stats, adaptation loop, curve builder
    settings.ts            validation + storage-backed store
    media-origin.ts        Web Audio cross-origin safety classification
    status.ts              per-frame -> per-tab aggregation
    messages.ts            message contract
    log.ts                 debug logging (stripped in production)
  content/
    index.ts               per-frame bootstrap and wiring
    media-registry.ts      discovery, dedupe, lifecycle
    audio-engine.ts        Web Audio chain, probes, rollback
    video-engine.ts        frame measurement + adaptation loop
    tone-filter.ts         SVG filter + CSS rule management
    status-reporter.ts     throttled status push
  background/
    service-worker.ts      defaults + status relay
  popup/
    popup.html/.css/.ts    the UI
tests/                     Vitest suites
test-page/                 local manual test bench (generated media)
scripts/
  build.mjs                esbuild pipeline
  icons.mjs                PNG generation
  serve-test-page.mjs      static server for the bench
  smoke.mjs                real-Chrome end-to-end checks
  popup-shot.mjs           dev utility: screenshot the popup at a given strength
```

## License

MIT.
