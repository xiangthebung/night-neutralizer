# Night Neutralizer

A Chrome extension for watching and listening in a dark room. It reduces the
**dynamic range** of both video and audio so you can keep the screen dim and the
volume low without losing dark scenes or quiet dialogue — and without being
ambushed by a bright cut or an explosion.

- **Audio:** Web Audio compressor + make-up gain + limiter per media element,
  with an optional night EQ that takes the bass down and dialogue up.
- **Video:** adaptive tone mapping (shadow lift, highlight roll-off, flash
  guard) driven by real per-frame luminance measurements.
- **Still images:** the same compositor path over `<img>`, with one fixed curve
  that can only ever darken — a picture's pixels are usually cross-origin and
  cannot be measured, so it is never guessed at in the direction that would make
  the screen brighter.
- **Only when it is actually night.** If the browser exposes an ambient light
  sensor, the room decides; otherwise a configurable window on the clock does.
  Default 21:00–07:00.
- **Music is left alone.** Dynamic range is the point of a record and a nuisance
  in a film, so YouTube Music, Spotify and anything else playing audio-only keep
  their dynamics.
- **Per-site and per-channel:** one slider by default, two when you want the
  audio squashed and the picture left alone, and a one-click "skip this site".
- **Local only:** one permission (`storage`), no network access, no accounts,
  no telemetry, no remote code.

---

## Table of contents

- [Install and build](#install-and-build)
- [Using it](#using-it)
- [Architecture](#architecture)
- [When it runs](#when-it-runs)
- [Leaving music alone](#leaving-music-alone)
- [Audio processing](#audio-processing)
- [Video processing](#video-processing)
  - [Why not canvas or WebGL?](#why-not-canvas-or-webgl)
  - [What "adaptive" means here](#what-adaptive-means-here)
  - [Still images](#still-images)
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
npm run build          # -> dist/ and the repository root
```

`npm run build` also copies the production build into the repository root. This
keeps the GitHub source download directly loadable for users who do not have
Node.js.

To load a GitHub download:

1. open `chrome://extensions`
2. turn on **Developer mode** (top right)
3. click **Load unpacked**
4. extract the GitHub ZIP and select the extracted repository folder — the one
   containing `manifest.json`

For local development, `dist/` remains the production build output. The
repository root is a synced copy intended for direct loading from GitHub.

Other commands:

| command | what it does |
| --- | --- |
| `npm run build` | production build into `dist/` and the repository root (minified) |
| `npm run build:dev` | unminified build with inline sourcemaps and debug logging |
| `npm run watch` | rebuild TS on change (re-run for `manifest.json`/`popup.html` edits) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | unit tests (Vitest) |
| `npm run verify` | typecheck + unit tests + production build |
| `npm run smoke` | end-to-end checks in real headless Chrome |
| `npm run testpage` | serves the manual test bench on `http://localhost:8791` |
| `npm run zip` | build, package `artifacts/night-neutralizer-<version>.zip`, and verify the archive |
| `npm run clean` | remove `dist/` and `artifacts/` |

There are no runtime dependencies. The build is esbuild only, and the icons are
generated at build time by `scripts/icons.mjs`, so the repository contains no
binary assets. Packaging is pure Node too (`scripts/zip.mjs`) rather than a call
out to a `zip` binary, so it behaves the same on Windows, macOS and Linux; the
archive is written with fixed timestamps, then read back and CRC-checked entry by
entry, so a malformed package fails the build instead of the store upload.

The headless dev tools (`npm run smoke`, `scripts/popup-shot.mjs`) find Chrome
themselves on all three platforms. `CHROME_PATH` overrides the search if you want
a specific build.

---

## Using it

Click the toolbar icon:

- **On/off** — master switch. Off means nothing is processed anywhere.
- **Neutralization strength (0–100)** — higher strength means stronger
  correction *where a scene needs it*: quiet gets louder, loud gets quieter,
  dark scenes get opened up further and bright scenes get pulled down harder. A
  scene already inside the light budget passes through untouched at any
  strength; one over it is dimmed, but by a clean scale rather than by having
  its blacks greyed and its highlights flattened. Lower strength keeps more of
  the original contrast and punch. **0 is a complete bypass.** Default is 45.
- **Set audio and video separately** — splits the slider in two. One number
  cannot express "compress the soundtrack hard but barely touch the picture",
  which is an ordinary thing to want. Re-linking takes the midpoint of the two.
- **The caption under each graph says what the setting does**, in numbers: at the
  default, "dark scenes 2.9× brighter / whites 28% softer" and "quiet parts
  +9 dB / loud-to-quiet gap −9 dB". Those come from `core/readings.ts`, which
  derives them from the same curve and transfer functions the engines use, so a
  caption cannot describe an effect the extension is not applying. Figures are
  rounded *down*, because the transfer model reads slightly optimistic against a
  rendered measurement.
- **The two graphs** are the actual effect at the chosen setting, not decoration,
  and they are the detail behind those captions rather than the only explanation
  of them. The left one is the video tone curve, drawn with the same
  `buildToneCurve()` the content script uses; its shaded band is the range the
  curve moves within as scenes get darker or brighter, so the band's width shows
  how much adaptation headroom the setting has. The right one is the audio
  transfer curve: settled input level against output level in dB, from the same
  `mapAudioStrength()` the engine uses. In both, the dotted diagonal is
  "unchanged", so the shaded area is exactly how much is being done to the signal.
  Hovering either one describes its axes.
- **Only at night** — on by default, and the reason the extension can be left
  installed and forgotten. See [When it runs](#when-it-runs). The line under the
  switch says which signal is in charge: a light-sensor reading in lux if the
  browser gives one, otherwise "no light sensor here, so the clock decides". The
  two clock fields below it set the window and only appear while the switch is on.
- **Audio** / **Video** / **Images** — process each independently. Video and
  Images share a row because they are the two halves of the picture path, and
  because the popup has a height budget. They are a different bargain from each
  other: a video is measured frame by frame and corrected for what it contains,
  while a still cannot be measured at all and gets one fixed curve that only
  ever darkens — see [Still images](#still-images). Both on by default, both
  driven by the picture slider, and 0 is a bypass for both.
- **Leave music alone** — on by default. See
  [Leaving music alone](#leaving-music-alone).
- **Night EQ** — off by default. Compression fixes "I can't hear the dialogue",
  but the reason you reach for the volume knob at night is low frequency: bass
  travels through walls and floors where midrange does not. This shelves the low
  end down (up to −7 dB below 120 Hz) and lifts a wide bell at 2.6 kHz (up to
  +3.5 dB) to buy back the consonants that go down with it.
- **Skip *hostname*** — in the status card, leaves that site completely alone,
  audio and video. Useful for a site that already tone-maps its own video, a work
  tool you never watch at night, or anything that misbehaves. Listing a domain
  also covers its subdomains, and it matches both the page you are on and the
  origin of an embedded player, so skipping `youtube.com` also silences YouTube
  embeds elsewhere.
- **Right now on this tab** — shows what is actually happening: one line for
  sound (how many players are being compressed) and one for the picture, which
  reports both halves at once — whether video is running *adaptive tone mapping*
  (frames are being measured) or a *fixed night curve* (frames cannot be read,
  e.g. DRM), and how many stills the image curve is on.

Changes apply immediately to open tabs; no reload. Settings live in
`chrome.storage.sync`, so they follow your Chrome profile.

**Keyboard shortcut:** `Alt+Shift+N` toggles the extension on and off without
opening the popup — handy when a scene is already too bright and you just want it
gone. Remap it at `chrome://extensions/shortcuts`; the popup shows whatever it is
currently bound to, and shows nothing if you have unbound it.

**The toolbar icon reports state**, because the shortcut has no other feedback:
on a tab with no video, or with video processing already off, pressing it would
otherwise be completely invisible. Switched off, the icon dims and the badge reads
`off`; on a site you have skipped, that tab's badge reads `site`; and while it is
standing down until night, that tab's badge reads `day` — without which "correctly
doing nothing until 21:00" and "broken" look identical from the toolbar.

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
  │                                    │  paints the toolbar badge/icon
  ▼                                    ▲
chrome.storage.sync  ──onChanged──►  content script (one per frame)
                                       │
chrome.storage.session ──onChanged──►  │   ambient light reading (shared)
the local clock ───────────────────►   │
                                       ▼
                                  core/gate.ts
                        "should this frame do anything, and why not"
                                       │
                        ┌──────────┬────┴─────┬───────────────┐
                        ▼          ▼          ▼               ▼
                 MediaRegistry AudioEngine VideoEngine    ImageEngine
                 (discovery,   (Web Audio  (measure       (one fixed
                  dedupe,       DRC chain)  frames, push    curve for
                  lifecycle)                tone curve)     every <img>)
                                                 │               │
                                                 ▼               ▼
                                            ToneFilter      ToneFilter
                                         (SVG LUT + CSS rule, one each)
```

Design notes:

- **Settings flow through storage, not messages.** The popup only writes a key;
  every content script reacts to `chrome.storage.onChanged`. That is why applying
  a change needs no tab permissions and no page reload. The ambient light reading
  travels the same way, through `chrome.storage.session`.
- **One gate, one reason.** `core/gate.ts` is the only place that decides whether
  a frame processes anything, and it returns *why* along with the answer. The
  engines, the popup's status lines and the toolbar badge all display what it
  returned rather than each deriving it again. Before it existed the decision was
  an inline `enabled && !siteDisabled`; adding "and it has to be dark" and "and
  the clock has to agree" to that would have meant three copies of the same
  reasoning drifting apart.
- **Pure core, impure edges.** All parameter maths (`core/strength.ts`,
  `core/tone-curve.ts`), settings validation and status aggregation are pure
  modules with no DOM or Chrome dependency, which is what makes them unit
  testable. Everything that touches the DOM or Web Audio lives in `content/`.
- **The service worker holds no page data beyond a hostname.** It stores per-frame
  status summaries — counts, engine states, and the bare hostname the per-site
  switch needs — in `chrome.storage.session`, which never hits disk, and drops
  them when a tab closes. No paths, no queries, no titles. See
  [Privacy](#privacy).
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

## When it runs

With **Only at night** on (the default), the order of precedence is:

1. the master switch;
2. the per-site exclusion list;
3. an **ambient light sensor** reading, if one is available;
4. otherwise the **clock**, against the configured window.

The sensor outranks the clock because it is a better answer to the actual
question. A room with the blinds down at 4 p.m. is exactly when this extension
helps, and a brightly lit room at 11 p.m. is exactly when it does not.

**The honest position on the sensor: you will probably never see it.**
`AmbientLightSensor` is implemented in Chromium but is not exposed to pages unless
`chrome://flags/#enable-generic-sensor-extra-classes` is switched on and the
browser relaunched, and even then the machine needs a light sensor — common on
laptops and phones, rare on desktops. So on a stock install the clock is what
runs, and the popup says so rather than implying a sensor is in use. If you do
enable the flag, it is picked up with no further configuration.

Details that matter in practice:

- **Thresholds with a gap.** At or below 30 lux counts as dark, at or above 60 as
  lit, and in between the previous verdict stands. Without that gap a reading
  hovering at the boundary would switch the whole extension on and off once a
  second. For scale: an office is 300–500 lux, a living room with lamps on is
  50–150, and a room lit only by the screen is single digits.
- **One reading, shared.** Only a top-level frame can read a sensor (the
  `ambient-light-sensor` permission policy defaults to `self`), so the frame that
  can publishes to `chrome.storage.session` and every other frame in every tab
  picks it up through `onChanged`. Otherwise a cross-origin embedded player would
  fall back to the clock and disagree with the page hosting it. Publishing is
  throttled to verdict changes plus real movement, so a steady room costs nothing.
- **The clock window may wrap midnight**, which is the normal case. `21:00` to
  `07:00` means what you expect; the start is inclusive and the end exclusive.
  Setting both fields to the same time reads as *always*, and the popup says so —
  "never" would switch the extension off with nothing on screen to explain it.
- **Boundaries are a timer, not a poll.** Each frame sleeps until the window next
  opens or closes, capped at ten minutes so a DST change or a corrected system
  clock cannot go unnoticed for an hour, and re-checks when a hidden tab becomes
  visible again.
- **Times are local wall-clock time**, stored as minutes since midnight. The popup
  renders them in your locale's convention, so the caption and the clock fields
  agree.

---

## Leaving music alone

Compression is a fix for a specific problem: dialogue mixed 30 dB below the
explosions. On a record the range *is* the performance, so with **Leave music
alone** on (the default) the audio half stands down for music. Two signals are
combined:

1. **The host.** A frame served by a music service is playing music, whether it is
   the page you are looking at or a player embedded in someone's blog. That is any
   `music.*` subdomain — `music.youtube.com`, `music.apple.com`,
   `music.amazon.co.uk`, `music.yandex.ru`, so one rule covers the regional
   variants too — plus an explicit list in `core/music.ts` (Spotify, SoundCloud,
   Bandcamp, Deezer, Tidal, Mixcloud, Pandora, Qobuz and similar). Note that
   `music.youtube.com` is listed and `youtube.com` is not: matching one does not
   match the other.
2. **The element.** Audio-only playback is not a film. An `<audio>` element, or a
   `<video>` whose stream carries no picture once metadata has loaded, counts as
   music. This catches services that are not on the list, and short interface
   sounds, which are no loss.

Both signals err in the same direction — towards leaving audio exactly as the site
sent it, which is the pre-extension status quo. The obvious false positive is a
**podcast or audiobook in an `<audio>` element**, which would benefit from
compression and will not get it; turn the toggle off if that is most of what you
listen to.

**Video is unaffected.** Tone mapping a music video at 1 a.m. is still worth
doing, and it has nothing to do with what you are listening to. So on
`music.youtube.com` the picture is still processed and only the sound is left
alone. The popup's status line says which.

---

## Audio processing

Per element, created lazily on first playback:

```
MediaElementSource → preGain → lowShelf → presence → DynamicsCompressor
                   → makeupGain → limiter → safety soft clipper → destination
```

| stage | role |
| --- | --- |
| `preGain` | pushes quiet material into the compressor knee |
| `lowShelf` / `presence` | night EQ; flat unless it is switched on |
| compressor | the actual range reduction, soft knee, release grows with strength |
| `makeupGain` | computed so a 0 dBFS peak lands at or below −4 dBFS |
| limiter | ratio 20, 2 ms attack, threshold tightening from −0.5 dB to −2 dB with strength: catches transients only |
| safety clipper | instantaneous `WaveShaper`, bounded at 0.99, so nothing can reach the sink above full scale |

The EQ sits *before* the compressor so the compressor sees and controls the
boosted presence band rather than being surprised by it, and the presence gain is
subtracted from the make-up gain so the headroom guarantee below still holds with
the EQ engaged. Both filters stay in the graph permanently and go flat when the
toggle is off: rebuilding a live Web Audio graph is what risks silencing an
element, so no code path does it.

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

And the night EQ, measured the same way (single tones through the two filters,
strength 70):

| frequency | 60 Hz | 700 Hz | 2600 Hz |
| --- | --- | --- | --- |
| change with night EQ on | −5.15 dB | +0.25 dB | +2.74 dB |

Low end down, mid-range essentially untouched, consonants up. At strength 0 both
filters measure flat to within 0.001 dB, so bypass stays bypass whatever else is
switched on.

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

The effect is a per-pixel transfer function, not a brightness reduction — and
it is **scene-gated**: dark scenes engage the shadow machinery, scenes over the
light budget engage the exposure dim and the highlight shoulder, and a scene
that needs neither renders through an identity curve. Applying night
corrections to content that needs none is precisely what washes an image out.

Note the shape of that gate. "Washed out" and "untouched" are not the same
requirement, and conflating them is how the effect ended up doing nothing useful
to a bright scene: dimming by a scale is not washing out, and a night extension
that refuses to dim anything it considers normally exposed has given up on its
one job. What must never happen to a scene that did not ask for it is a lifted
black point, a gamma-brightened mid-tone or a flattened top.

1. **exposure** — `v = x · exposure`, only ever below 1. The multiplier is
   whatever lands the frame's *emitted light* on a fixed comfort budget:
   `exposure = comfortLight / light`, floored by what the strength slider
   allows. Below the budget nothing happens, so there is a genuine dead band;
   above it the dim is proportional to how far over the frame is.
2. **shadow opening** — `v = v^(1/γ)` plus a small absolute black lift, so
   near-black detail separates instead of staying crushed. Engages only as the
   scene as a whole reads dark, and is vetoed outright once the frame is
   emitting real light: a well-exposed frame legitimately contains true blacks,
   and those stay black.
3. **highlight shoulder** — above a knee `k`, `v = k + a·(1 − e^−((v−k)/a))`.
   Slope is exactly 1 at the knee and decreases from there, so mid-tone contrast
   survives while highlights compress instead of clipping. `a` is solved by
   bisection so full-scale input lands exactly on the requested white point.
   Both `k` and the white point are fractions of the range exposure has left,
   not of full scale, so the two stages cannot dim the same highlights twice.
   Engages for actual glare (a hot top decile, or a bright scene), and stays
   armed at a reduced level during dark scenes so a hard cut to white is already
   caught on its first frame.
4. **slope allocation** — a curve that dims has less output range than input
   range, so some contrast is going to be lost; the only question is where from.
   A fixed shoulder always spends it at the top, which on a bright scene is
   exactly where the pixels are densest. Given the frame histogram the LUT's
   per-interval slopes are instead rescaled towards the levels the scene
   actually occupies and away from the empty ones — clipped at 3× a level's fair
   share so a large flat region cannot claim slope for its own noise, bounded to
   0.55–1.8× per interval, and engaged in proportion to the range the dimming
   just gave up, so a scene being left alone is left alone by this stage too.
5. **saturation compensation** — the shadow gamma flattens colour slightly; a
   final `feColorMatrix type="saturate"` puts it back, scaled by how engaged
   the lift is, so an untouched scene also keeps untouched colour.

The measurement driving all of this is **linear light**, not encoded luma. The
mean of a frame's gamma-encoded luma says how dark it *looks*, and is dominated
by however much of the frame happens to be dark; a dashcam shot that is half
black dashboard and half overcast sky reads as a perfectly ordinary scene by
that measure while the sky goes on glaring. `computeSceneStats` therefore also
averages in linear light and re-encodes the result, which answers the question
that actually matters — how much light is coming off the screen — and it is that
figure the exposure servo and the shadow-lift veto both run off. It costs 64
`pow` calls per analysed frame, one per histogram bin, rather than one per pixel.

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

Curve output for a given input level, after settling on each scene type. The
last column is the frame's emitted light before and after, which is the number
the effect is actually for:

| input | 0.00 | 0.05 | 0.25 | 0.50 | 0.90 | 1.00 | light |
| --- | --- | --- | --- | --- | --- | --- | --- |
| strength 45, dark scene | 0.028 | 0.203 | 0.510 | 0.700 | 0.903 | 0.925 | 0.19 → 0.36 |
| strength 45, normal scene | 0.000 | 0.021 | 0.189 | 0.410 | 0.700 | 0.717 | 0.49 → 0.39 |
| strength 45, dashcam clip | 0.000 | 0.053 | 0.191 | 0.461 | 0.705 | 0.726 | 0.46 → 0.38 |
| strength 45, bright scene | 0.000 | 0.021 | 0.196 | 0.392 | 0.697 | 0.714 | 0.61 → 0.48 |
| strength 100, bright scene | 0.000 | 0.016 | 0.144 | 0.287 | 0.453 | 0.459 | 0.61 → 0.34 |

At the default, a dark scene has its deep shadows opened roughly 2.9× and is the
one case that ends up emitting *more* light — that is what the shadow lift is
for, and its ceiling is the comfort budget the other rows are being pulled down
to. Everything over that budget loses about a fifth of its light output with its
blacks left at zero, its colour untouched and every ratio below the shoulder
intact: it reads as "the brightness came down", not "the contrast went".

The "dashcam clip" row is the case that motivated the light-based drive. Its
encoded mean is 0.34 — squarely normal, and under the old mean-driven
classifier it got no exposure dim at all, only a shoulder that shaved ~10% off
the top decile while leaving the frame's total light output unchanged. Measured
in linear light it is a 0.46, well over budget, and it now comes down as a
bright scene should.

Verified against *rendered pixels*, not just the maths: the smoke test
screenshots two static grey-ramp videos — one full-range (a normal scene) and
one scaled into the shadows (a dark scene) — through the compositor.

| measured on the screenshot, strength 45 | normal ramp | dark ramp |
| --- | --- | --- |
| absolute black | 0.000 → 0.000 | 0.000 → 0.027 |
| shadow detail (5th–20th percentile) | 0.010 → 0.014 | 0.003 → 0.038 |
| brightest decile | 1.000 → 0.710 | 0.302 → 0.584 |
| overall mean | 0.409 → 0.335 | 0.123 → 0.294 |

The normal ramp keeps its blacks and its shadow band to within a single 8-bit
code while its glare and its overall level come down; the dark ramp is the one
that gets opened up. That split is the scene gating working, and the smoke test
fails if either side leaks into the other — including if the "bright" side
stops actually getting darker, which is a check of its own.

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
  breathing). Shadow lift and highlight roll-off are gated on the measured
  scene: dark scenes get opened up, scenes over the light budget get held back,
  and a scene inside it converges on the identity curve instead of being
  flattened,
- **snaps instead of easing at a scene change**, see below,
- rebuilds the LUT and writes it to the filter, but only if it changed.

**Cuts snap.** Those time constants are right for continuous footage and wrong
at a cut. Easing exists to hide a correction inside content that is already
moving; a cut both masks anything changed on the same frame *and* leaves nothing
to hide a slow correction in, so easing there is visible as the picture drifting
for up to 1.6 s after the new scene arrives. The state is therefore eased and
snapped in the same expression: a 0..1 `cut` amount blends between the eased
value and the target, and the resulting curve bypasses the push throttle.

`cut` comes from how far the frame's luminance distribution *travelled* since
the last analysed frame — the 1-D earth-mover distance between the two 64-bin
histograms, which the measurement already computes, so the detector costs 64
adds. Distance travelled rather than bin-by-bin difference, because a
low-contrast frame (fog, a title card, a night interior) holds nearly all of its
mass in one bin, and a slow dissolve relocates *all* of it every time the level
crosses a bin boundary: a difference metric reads that as "the whole frame
changed" and would snap several times a second through a two-second fade.
Transport distance reads the same event as one bin width, 0.016.

The gates mirror the flash guard's: a magnitude floor (0.08–0.22 luma, below
which the curve's target barely moves and snapping is indistinguishable from
easing) and a rate gate (1.5–4.0 luma/second, so a deliberate fade is judged by
how fast the content moves rather than by how often we sample). Both are
smoothstepped, so no two near-identical frames land either side of a cliff. At
60 Hz the magnitude floor binds; the rate gate is what keeps the 8 Hz timer
fallback honest, where a cut and a fast pan genuinely are not distinguishable.
Where frames carry no histogram the detector falls back to |Δmean|, which is a
strict lower bound on the transport distance — it can only under-detect a cut,
never invent one.

A 250 ms timer handles upkeep only (our nodes, the primary choice, fullscreen).
Where `requestVideoFrameCallback` is unavailable it falls back to measuring on
an 8 Hz timer. Analysis stops entirely while the tab is hidden.

**Frame skipping keeps the cost bounded**, and the budget is 1.2 ms of main
thread per *presented frame* — a duty cycle, not a per-sample cost. That
distinction is the whole control law: skipping frames does not make an
individual read-back any cheaper, so a budget compared against the raw sample
cost has no fixed point. One read-back over the line ratcheted the stride
1 → 2 → 4 → 8 and nothing could bring it back, because the number being tested
never changed. Anything more expensive than the budget therefore ran at ⅛ rate —
7.5 Hz on 60 fps content — where a 2.4 ms read-back should skip one frame in two.
The hysteresis band is `(budget/2, budget]`: half-open, so every cost has a
single fixed point (the finest stride that fits) rather than being stable at two
strides at once, and exactly one stride step wide, so a correction cannot
overshoot and oscillate.

**Skipping a frame skips the measurement, not the update.** Deciding *where* the
curve should be heading needs a pixel read-back and is the expensive half;
*moving* it there is a few `exp` calls. Fusing the two let the skip rate govern
both, so a video that could only afford analysis every fourth frame also only
had its curve rewritten every fourth frame — and a ramp delivered in
quarter-second jumps is a visible staircase however correct each jump is.
Measured in Chrome at stride 4: 3.4 8-bit levels per jump, eight times a second.
The two halves are now separate functions (`updateAdaptState` re-aims the
targets, `advanceAdaptState` integrates towards them), and every presented frame
runs the second one. At stride 4 the largest smooth update is now 1.45 8-bit
levels — the same figure as at stride 1, so the analysis rate no longer costs
anything in smoothness. What it does cost is detection latency: the targets a
skipped frame is easing towards are up to `stride` frames stale.

Because the two halves now run on different clocks, the rate gates take the
interval since the last *analysed* frame rather than since the last update.
Dividing a four-frame change by one frame would read every ordinary pan as four
times as fast as it is, and fire the cut snap and the flash guard on motion.

**Flash guard.** The mean luminance must rise both *fast* and *far*: the
threshold is a rate (1.2–4.0 luma/second depending on strength), not a
per-sample delta, so it means the same thing whether we are sampling at 60 Hz or
8 Hz. A qualifying jump instantly dips exposure (up to 45%) *and* pulls the
white point down (a further 0.45 × the flash amount), then decays with τ =
0.55 s. Both parts matter: exposure alone gets damped by the shoulder exactly
where the glare is. Measured on a controlled white flash at the default
strength, the encoded white level goes 0.714 → 0.533 and back.

The guard was doing two jobs: covering the exposure servo's lag, and blunting
the transient. Snapping does the first one, so where a cut has been detected the
guard is scaled back to avoid double-counting — but only in proportion to how
much dimming the snap actually delivered. On content already pinned at
`minExposure` the servo has no room left to move, so the guard stays at full
strength, because it is then the only transient protection the frame has. That
is not a hypothetical: damping on the bare presence of a cut measured 0.533 →
0.639 on the white-flash test, which is precisely the case the guard exists for.

Its honest limit — shared with the cut snapping — is that this is *reactive*. It
measures a frame that has already been presented, so the response lands on the
following frame (~16 ms at 60 fps) and the first frame of a cut or a flash wears
the old curve. There is no frame lookahead available to an extension, so
pre-emption is not possible, and where the engine has backed off to every 4th or
8th frame to stay inside its CPU budget the detection latency scales with it.
What it can do — and does — is stop a bright cut or a multi-frame strobe from
staying painful.

The popup reports `adaptive` only when frames are really being measured. If they
cannot be read, it says **fixed night curve** and the applied curve is a static,
non-adaptive one (`staticAdaptState`) sitting in the upper part of the adaptive
range — 0.8 of the lift and 0.85 of the roll-off, since one fixed curve has to
serve both dark and bright scenes. The extension does not describe a static
filter as adaptive.

### Still images

A bright photograph at 1 a.m. is exactly as unpleasant as a bright frame of
video, so `<img>` gets the same machinery: a second, independent
`feComponentTransfer` filter, referenced by one CSS rule.

```css
img { filter: url("#nn-image-tone-curve") !important; }
```

**Stills are toned blind, and that is a hard constraint rather than a choice.**
Drawing a cross-origin image into a canvas taints it, and most pictures on a
page come from a CDN without CORS headers, so their pixels cannot be read at
all. The extension has no host permissions and never fetches anything, so there
is no second route to them either. Measuring only the minority that *are*
readable would tone two photographs sitting side by side differently depending
on which host happened to serve them, which is a worse artefact than treating
both the same.

So the image curve is the half of the tone map that is safe without knowing what
it is looking at:

| stage | video | stills |
| --- | --- | --- |
| exposure | measured: `comfortLight / light`, floored at `minExposure` | fixed, half way from 1 to `minExposure` |
| shadow lift + gamma | engaged on dark scenes | **never** |
| highlight shoulder | engaged on glare | always armed |
| saturation compensation | scales with the lift | none, because nothing is flattened |
| slope allocation | from the frame histogram | none, there is no histogram |

The lift is the part that must not run blind. It exists to open up a night scene
and it brightens everything below the knee to do it, so on a page of
photographs it would *increase* the light coming off the screen — the opposite
of the point. The shoulder has no such failure mode: it only ever darkens, only
above the knee, so on a dark picture it does nothing at all. Hence one armed and
the other not. The unit tests pin the resulting property directly: no input
level, at any strength, may come out brighter than it went in.

The exposure constant is the one judgement call. `minExposure` is the servo's
answer to a frame *measured* to be over the light budget; applying it to every
picture on the page would dim the dark ones exactly as hard as the bright ones,
and unity would dim none of them. Half way is the honest constant when the
brightness is unknown, and it still scales with the slider.

| input | 0.00 | 0.05 | 0.25 | 0.50 | 0.90 | 1.00 | light |
| --- | --- | --- | --- | --- | --- | --- | --- |
| strength 20 | 0.000 | 0.049 | 0.243 | 0.487 | 0.875 | 0.952 | 0.59 → 0.58 |
| strength 45 | 0.000 | 0.045 | 0.223 | 0.447 | 0.774 | 0.810 | 0.59 → 0.52 |
| strength 100 | 0.000 | 0.038 | 0.188 | 0.375 | 0.570 | 0.585 | 0.59 → 0.40 |

(`light` is the emitted light of a full 0–255 ramp, before and after.) Black
stays at black in every row, which is the whole difference from the video static
curve.

**There is no element discovery either**, and that is what keeps this cheap. The
rule is a bare `img` selector rather than a marked attribute, so pictures added
later — infinite scroll, lazy loading, an SPA route change — are covered by the
CSS engine at no cost: no MutationObserver, no per-element bookkeeping, no
layout reads. The video path cannot do that because it has to pick a primary
element to measure; here there is nothing to measure. A 2 s timer handles the
same upkeep the video engine does (repair our nodes if the page removes them,
follow the fullscreen subtree), and switching the toggle off removes the
stylesheet and the filter definition entirely.

---

## Performance

- **The effect itself costs no per-frame JavaScript.** The LUT is applied by the
  compositor. A curve update is one attribute write, skipped when the curve is
  unchanged. It runs **once per presented frame** — measured at 30.3 LUT updates
  per second against a 30.3 fps source, a median gap of 33.3 ms against 33.3 ms
  per frame. It used to carry a 30 ms minimum gap, which is invisible below
  33 fps and silently drops every other frame above it: on 60 fps content the
  curve was one frame stale half the time, which reads as judder no amount of
  adaptation quality can fix. The real rate limiter is `requestVideoFrameCallback`,
  which cannot fire more than once per presented frame anyway.
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
- **The curve is global, not local.** `feComponentTransfer` is genuinely
  per-pixel, but it is one lookup table for the whole frame: the same input
  level maps to the same output level wherever it appears, with no knowledge of
  what a pixel's neighbours are doing. So a frame containing both a blown
  window and a face in shadow can only be traded off, not solved — dimming the
  window necessarily dims everything at that level. The histogram-driven slope
  allocation is what buys back most of the difference; genuinely local tone
  mapping would need a spatial filter graph (`feGaussianBlur` plus arithmetic
  `feComposite`), which is possible on the same compositor path and is not done
  here.
- **Very high-resolution video with a filter** can push some GPU/driver
  combinations onto a slower compositing path. If a 4K stream stutters, lower the
  strength or turn video processing off for that session.
- **`file://` pages are not supported at all.** The content script in
  `src/manifest.json` matches `http://*/*` and `https://*/*`, and nothing else, so
  it never runs on a local file. Enabling *Allow access to file URLs* on
  `chrome://extensions` does not change that — that toggle grants a permission to
  extensions whose match patterns already include `file:///*`, and this one's do
  not. This entry used to claim the opposite.
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
- **Still images are never measured**, for the reason in
  [Still images](#still-images): their pixels are usually cross-origin and
  cannot be read. One fixed curve serves the whole page, so a dark photograph is
  dimmed by the same amount as a blazing white one — less than that photograph
  deserves, and the curve is deliberately built so that being wrong about a
  picture can only ever leave it slightly darker.
- **The image rule wins over the page's own `filter` on `<img>`.** It is
  `!important`, like the video rule, so a site that dims, blurs or greys its own
  pictures with CSS has that overridden while the toggle is on. Turning **Images**
  off is the escape hatch, and it takes effect without a reload.
- **Only `<img>` is covered.** CSS `background-image`, `<svg>` artwork, canvas
  drawings and video posters painted by the page are not: there is no element to
  attach a filter to without restyling the page's own boxes, which would break
  layouts. Images inside a shadow root are also missed, because a document
  stylesheet does not reach into one.
- **Players that paint into a `<canvas>` get nothing.** The CSS rule targets
  `video[data-nn-tone="1"]`, so a site that decodes into a canvas or a WebGL
  surface instead of presenting a `<video>` is invisible to the video half. The
  audio half still works.
- **One curve serves every video in a document.** Adaptation is driven by the
  primary video (the largest visible playing one) and the resulting LUT is shared
  by all marked videos in that frame. On a page with a main player *and* a second
  smaller clip playing at once, the second one is tone-mapped with the first one's
  curve. Separate filters per element would mean a filter definition and a
  measurement loop per element, which is a real cost for a rare case.
- **The ambient light sensor is usually not available.** Chrome hides
  `AmbientLightSensor` behind `chrome://flags/#enable-generic-sensor-extra-classes`
  and most desktops have no sensor anyway, so in practice the clock decides. This
  is stated in the popup rather than left to be discovered. A cross-origin iframe
  can never read one (permission policy), which is why the reading is shared from
  the top frame.
- **The night window is local wall-clock time.** A DST change or a corrected
  system clock shifts it, and the re-check is capped at ten minutes, so the
  boundary can land up to ten minutes late in that situation.
- **Music detection is a heuristic.** A podcast or audiobook played through an
  `<audio>` element is treated as music and left uncompressed, and a music service
  not on the list that streams a real video track is compressed like a film. There
  is no reliable metadata for this; the toggle exists because of that.
- **Per-site skipping is by hostname, not by URL.** There is no "skip this one
  video" or "skip this path", and the extension deliberately never sees the path.
- **Chrome-owned pages** (`chrome://`, the Web Store, other extensions) cannot be
  modified by any extension.
- **Chrome only.** It runs on Chromium-based browsers (Chrome, Edge). Firefox
  would need its own manifest key and `browser`-namespace handling; that has not
  been done.

---

## Privacy

- **No network access at all.** Nothing is fetched at runtime; no remote code, no
  analytics, no accounts, no crash reporting.
- **No page content leaves the frame.** Frame pixels are read into a 48×27
  buffer, reduced to four numbers, and thrown away. They are never stored,
  transmitted, or exposed to the page.
- **What is stored on disk:** your settings, in `chrome.storage.sync` — the master
  switch, the strength values, the audio/video/image/night-EQ/music toggles, the night
  window, and the list of hostnames you have chosen to skip. Nothing else.
- **What is held in memory:** short-lived per-frame status summaries and the latest
  ambient light reading, in `chrome.storage.session`, which is memory-only, dropped
  when the tab closes and cleared when Chrome exits. Each summary carries counts,
  engine states, note strings, and **the bare hostname of the page** — no path, no
  query string, no title, no history.
- **The light reading is a single number** (illuminance in lux) with a timestamp.
  It never reaches disk and is not combined with anything else. Nothing reads the
  sensor unless **Only at night** is on.
- **Content scripts can read that session area.** The service worker widens the
  access level (`setAccessLevel`) so one frame's light reading can be shared with
  every other frame without a broadcast loop over your tabs. Content scripts run
  in an isolated world, so page JavaScript cannot reach any of it, and the widest
  thing exposed is the set of hostnames the extension already knows about.
- **Why the hostname is there at all:** the popup cannot read the active tab's URL,
  because the extension holds no `tabs` or host permission and is not going to ask
  for one just to label a button. So each frame works out its own hostname and
  reports it alongside its status, which is what lets the popup offer "skip
  *hostname*". It is the minimum needed for that feature and it never reaches
  disk. If you would rather it did not exist, the feature is the only thing that
  uses it: `site` in `core/types.ts`.
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

Unit tests (`npm test`, 340 tests) cover the strength → parameter mapping
(including the night EQ and the transfer model the popup plots), tone-curve maths
and adaptation behaviour (including sampling-rate-independent flash and
scene-change detection), the frame-skip control law, the safety clipper, media
discovery and duplicate prevention, settings
persistence and migration, hostname normalisation and per-site matching, origin
classification, the night window's midnight wrap and boundary arithmetic, the lux
classifier's hysteresis and publishing throttle, the music host and element
heuristics, the gate's order of precedence, status aggregation, the popup's
plain-language captions
(that they agree with the real curves, never overstate the effect, and stay short
enough not to wrap), the SVG filter's DOM handling under jsdom (including the
`<base href>` workaround and fullscreen re-parenting), and the status reporter's
throttling.

The end-to-end suite (`npm run smoke`, 70 checks) drives real headless Chrome
over the DevTools protocol: it installs the built extension, plays generated
media, and asserts that the filter is applied, that the curve *changes across a
scene change*, that **screenshotted pixels** show lifted shadows and compressed
highlights at the default strength, that a controlled white flash is dimmed and
then released, that the analysis cost stays small, that the audio graph engages,
that settings apply live, that nested frames are covered, and that no console
errors are produced.

It also checks the newer behaviour end to end: that the night EQ moves the bands
it claims to and stays flat at strength 0, that separating the sliders really does
bypass one half while the other keeps working, that a skipped site is left
completely alone, that the toolbar badge distinguishes "off" from "skipped", and
that the popup's per-site button names the real host and writes the exclusion.

The night and music gates are checked the same way, against a window shifted
relative to the machine's actual clock: outside it nothing is marked or
compressed, the badge reads `day`, the reported source is `clock` with no lux
value (which is also the documented behaviour of a browser with no sensor), and
moving the window over the current time resumes processing with no reload. With
the music exemption on, the bench's `<audio>` element is reported as left alone
while the video keeps being tone mapped; turning it off compresses it again.

It also **renders the audio chain offline** and measures the result: bypass
transparency to 0.01 dB, the quiet-vs-loud differential at each strength, that
peaks never reach full scale even on an abrupt full-scale burst (with or without
the night EQ), and the exact latency. Two shipped bugs were found this way — see
the audio section. No audio device is involved, so nothing is ever audible.

One more measurement exists purely to keep the UI honest: the popup's audio graph
is drawn from `audioTransferDb()`, an analytical model of the chain, so the smoke
test renders the real chain at five input levels and compares. Worst disagreement
is **1.7 dB**, in the conservative direction. If the model and the chain ever
drift apart, the picture in the popup stops describing what you are hearing, and
that check fails.

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
    site.ts                hostname normalisation + per-site exclusions
    gate.ts                the single "should this frame do anything" decision
    schedule.ts            night-window clock arithmetic
    ambient.ts             lux -> dark/bright, plus the shared reading store
    music.ts               music host + audio-only element heuristics
    readings.ts            plain-language descriptions of the current effect
    media-origin.ts        Web Audio cross-origin safety classification
    status.ts              per-frame -> per-tab aggregation
    messages.ts            message contract
    log.ts                 debug logging (stripped in production)
  content/
    index.ts               per-frame bootstrap and wiring
    media-registry.ts      discovery, dedupe, lifecycle
    light-sensor.ts        AmbientLightSensor wrapper (absence is normal)
    audio-engine.ts        Web Audio chain, probes, rollback
    video-engine.ts        frame measurement + adaptation loop
    image-engine.ts        the fixed <img> curve (no measurement, no discovery)
    tone-filter.ts         SVG filter + CSS rule management
    status-reporter.ts     throttled status push
  background/
    service-worker.ts      defaults + status relay + toolbar badge
  popup/
    popup.html/.css/.ts    the UI
tests/                     Vitest suites
test-page/                 local manual test bench (generated media)
scripts/
  build.mjs                esbuild pipeline
  icons.mjs                PNG generation (normal + dimmed "off" variants)
  zip.mjs                  deterministic ZIP writer + verifier
  crc32.mjs                shared checksum for PNG and ZIP
  find-chrome.mjs          cross-platform Chrome discovery for the dev tools
  serve-test-page.mjs      static server for the bench
  smoke.mjs                real-Chrome end-to-end checks
  popup-shot.mjs           dev utility: screenshot the popup and check its height
```

## License

MIT — see [LICENSE](LICENSE). Release history is in
[CHANGELOG.md](CHANGELOG.md).
