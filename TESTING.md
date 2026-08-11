# Testing Night Neutralizer

Three layers: unit tests for the maths and the DOM plumbing, an automated
end-to-end run in real Chrome, and a manual pass on real sites.

```bash
npm run verify   # typecheck + unit tests + production build
npm test         # unit tests only
npm run smoke    # end-to-end in headless Chrome
```

---

## 1. Automated: unit tests

`npm test` — 360 tests, no browser required.

| file | covers |
| --- | --- |
| `tests/strength.test.ts` | strength → processing parameters: true bypass at 0, clamping and non-finite input, monotonicity across all 101 values, release lengthening with strength, **make-up gain that accounts for Chromium's own internal make-up** and keeps the modelled peak below full scale at every strength, **a bounded safety stage always present**, quiet boosted more than loud with the range never inverting, every value inside the Web Audio legal range, no discontinuity next to bypass |
| `tests/soft-clip.test.ts` | safety clipper: exact identity below the knee, never exceeding the ceiling for input up to 50× full scale, monotonic and symmetric, less than 1 dB cost to a full-scale signal, decreasing slope, curve sampling (odd length, exact zero, identity samples on the identity line), identity params producing a straight line |
| `tests/tone-curve.test.ts` | luminance statistics (Rec. 709 weights, percentiles), soft-knee solver, curve monotonicity and bounds for every strength, shadow lift without crushing black, **a visible effect at the default strength**, **the shoulder never being scaled away while a scene is dark**, highlight compression, decreasing slope towards white, mid-tones not washed out, **scene gating: a scene inside the light budget converges on the identity, a normally exposed scene over it is dimmed by a clean scale (blacks stay black, saturation untouched, every ratio below the shoulder preserved), ordinary true blacks do not count as crushed shadows, and a bright scene is dimmed without being lifted**, **linear-light measurement reading emitted light rather than how dark a frame looks, and percentiles surviving histogram normalisation**, **a bright scene inside a dark frame: not mistaken for a night scene, and its light output really coming down rather than only its top decile**, **slope allocation: more contrast where the scene lives, endpoints unmoved, monotonic and bounded on every scene and strength, capped so a flat region cannot claim slope for its own noise, disengaged entirely when the curve is giving nothing up, and time-smoothed so the LUT cannot pump**, **flash detection at 60/30/8 Hz sampling with a fade tripping none of them**, **dim scaling with jump size**, **the white level dropping more than mid-tones when a flash fires**, **scene-change snapping: the whole state landing on its target on the frame of the cut in both directions, the response reaching its dimmest at the cut and only recovering from there, no snap on motion within a scene, no snap on a flat-frame fade (where every pixel changes bin), a hard cut snapping at 60/30/8 Hz, the mean-only fallback never over-triggering, and the flash guard left at full strength when the servo is already pinned at minExposure**, adaptation: bright scenes dim / dark scenes are lifted instead, dims faster than it recovers on continuous change, bounded under NaN/out-of-range input, static state is genuinely fixed and **does not apply strength twice**, **adaptive bounds bracketing the range and collapsing onto the identity when bypassed**, **the still-image state: never brightening any input level at any strength (the property the whole blind curve rests on), black staying at black while white comes down, a true bypass at strength 0, dimming monotonically with the slider, sitting exactly half way to the exposure floor, no saturation change because it flattens nothing, no history to depend on, and the CSS fallback not brightening either**, CSS fallback shape |
| `tests/media-registry.test.ts` | discovery before and after start, dynamic insertion, **duplicate prevention** (re-attach, rescan, DOM move), open shadow roots (and closed ones ignored), removal only after the grace period, re-parented elements surviving, subtree removal, element swap, mutation-storm rescan, throwing handlers, `stop()`/`release()`, idempotent `start()` |
| `tests/settings.test.ts` | sanitisation of missing/garbage/hostile values, clamping and rounding, unknown keys dropped, save→load round-trip through a fresh store, storage failure falling back to defaults, `ensureDefaults` writing only once, reset, change notifications, ignoring other areas/keys, unsubscribe not leaking listeners, **migration of pre-split settings** (the old single `strength` mirrored into both channels), exclusion-list cleaning, **the default exclusion array never being shared with stored settings**, effective strength with the link on and off |
| `tests/site.test.ts` | hostname normalisation (case, `www.`, ports, credentials, trailing dots, IPv6 literals, full URLs, opaque origins), **site keys derived from `location.ancestorOrigins`** so an embedded player is governed by the page it is embedded in, subdomain coverage without matching lookalike hosts (`example.com` covers `news.example.com` but not `notexample.com`), a stray empty entry not disabling the whole web, add/remove including collapsing subdomains under a newly added parent and removing a covering parent when a subdomain is re-enabled, list capping |
| `tests/readings.test.ts` | the popup's plain-language captions: **the figures agree with the very curves and transfer function the engines use**, each is taken from the adaptation bound where it is actually strongest (reading both video numbers off one bound understates the effect), they match the documented figures at the default strength, they grow monotonically with strength, they **never overstate what the chain delivers** (figures are floored), they avoid meaningless output at the bottom of the range ("1.0× brighter", "0% softer"), and they stay under 30 characters so they cannot wrap and push the popup past Chrome's height cap |
| `tests/video-engine.test.ts` | (jsdom) the frame-skip control law: every frame while the read-back is cheap, **settling on the finest stride that fits the budget instead of ratcheting to the maximum**, **converging to the same stride from any starting point including costs that land exactly on a band edge**, never oscillating once settled, capped at 8, coming back to every frame when sampling gets cheap again, and surviving a nonsense stride or cost |
| `tests/image-engine.test.ts` | (jsdom) the still-image path: one `img { filter: … }` rule with its own filter id so video and stills can never share a curve, a real 33-entry LUT that ends below full scale, **strength 0 treated as off rather than as an identity curve on every picture on the page**, **self-repair after the page removes the injected nodes**, the timer stopping when switched off, fullscreen re-parenting, a live picture count that needs no per-element bookkeeping, and teardown/`destroy()` leaving no rule behind |
| `tests/tone-filter.test.ts` | (jsdom) filter and stylesheet installation, idempotency, **self-repair after the page removes the injected nodes**, the CSS-filter fallback, **the `<base href>` workaround writing an absolute URL**, table/saturation writes skipped when unchanged, marking/unmarking, **fullscreen re-parenting of the filter host and back**, teardown leaving no trace but staying rebuildable, `destroy()` refusing to rebuild |
| `tests/status-reporter.test.ts` | a burst of `schedule()` calls coalescing into one message, unchanged status not resent (ignoring the timestamp), resending once something really changes, ~1 message/second rate limiting, a throwing snapshot builder swallowed, permanent stop once the extension context is gone, `stop()` cancelling a pending report, a rejected `sendMessage` not throwing |
| `tests/media-origin.test.ts` | Web Audio safety classification: MSE/blob (YouTube, Vimeo), `data:`, `srcObject`, same-origin, `file:`, plain cross-origin flagged risky, CORS-attributed accepted, empty source deferred, unparseable URLs and opaque origins treated conservatively |
| `tests/status.test.ts` | multi-frame aggregation, state precedence, note deduplication, staleness, pruning, **gate reasons across frames** (one working frame speaks for the tab, a sensor verdict outranks a clock one, the lux value comes from the top frame), music skips summed and a music host noticed in any frame |
| `tests/schedule.test.ts` | night-window arithmetic: `"HH:MM"` parsing and rejection (an empty time input must not become midnight), format round-trip across the whole day, stored values wrapped rather than rejected, **the window that wraps midnight** with an inclusive start and exclusive end, a same-day window, **a collapsed window reading as *always* rather than never**, time-to-next-boundary in both directions including across midnight and to the second, locale-aware display matching what a time input renders |
| `tests/ambient.test.ts` | lux → dark/bright with a **deliberate gap between the thresholds** so a reading at the boundary cannot flip the extension once a second, the midpoint decision with no prior verdict, nonsense values refused rather than guessed, a reading old enough to be from another day discarded so the clock takes over, **the publishing throttle** (verdict changes go out at once, a steady room publishes nothing, a real change waits out the gap), and the shared store: round-trip, a failed write reported rather than thrown (the normal case before the service worker widens session access), other storage areas ignored, unsubscribe not leaking |
| `tests/music.test.ts` | the music heuristics: listed services and their subdomains, **any `music.*` host** so regional variants need no entry, general video hosts left alone (`music.youtube.com` matches and `youtube.com` does not), lookalike hosts not fooling it, an embedded player on an unrelated page still counting, **every list entry already in normalised form** or it could never match, element classification waiting for metadata (every `<video>` is 0x0 until then), audio-only playback anywhere counting as music, and film not being assumed to be music while it loads |
| `tests/gate.test.ts` | the single processing decision and its **order of precedence**: master switch, then the exclusion list, then the sensor, then the clock. The sensor overriding the clock in both directions, the clock used when there is no reading, the sensor ignored once the night restriction is off, custom and collapsed windows, and the re-check delay (no timer when nothing is time-dependent, capped so a DST change cannot go unnoticed for an hour, never short enough to spin) |

## 2. Automated: end-to-end in real Chrome

```bash
npm run smoke
```

Installs the built extension into a throwaway Chrome profile over the DevTools
protocol (`Extensions.loadUnpacked`; Chrome 137+ ignores `--load-extension`),
serves the test bench, and asserts 78 checks.

Note that the suite writes `nightOnly: false` and `skipMusic: false` into its
baseline settings. The shipped defaults only process between 21:00 and 07:00 and
leave audio-only players alone, so a run at three in the afternoon would otherwise
be measuring an extension that is correctly doing nothing. Both are then exercised
explicitly, against a window shifted relative to the machine's real clock.

The checks:

- extension installs, service worker registers;
- the content script injects and creates its filter definition;
- `<video>` elements get marked and the computed `filter` references the LUT;
- the filter is a 33-entry per-channel table in sRGB;
- the curve lifts black and rolls off white;
- **the curve changes across a dark → bright → flash cycle** (proof of
  adaptivity, not a static filter);
- **screenshotted pixels** of a static grey ramp at strength 0 / 45 / 100.
  Shadow detail 0.010 → 0.052 → 0.117, brightest decile 1.000 → 0.816 → 0.639,
  mean 0.409 → 0.422 → 0.430 (range compressed, not dimmed). The screenshot is
  decoded with a small PNG reader in the test, so this measures what the
  compositor actually painted, and the **default** strength is asserted, not just
  the maximum;
- **the flash guard and the cut snap**: a hard scene cut moves the white point
  in a single step (0.286, up from 0.202 before the adaptation snapped at a
  cut), and a controlled 250 ms white flash on the static pattern takes the
  encoded white level 0.714 → 0.533 and then releases back to 0.714. The flash
  figure is the one that pins the guard's damping: the servo is already at
  `minExposure` on that pattern, so the snap contributes nothing there and the
  guard must not be scaled back;
- **still images get a curve of their own**: an `img { filter: … }` rule
  referencing a *separate* filter definition (so a page's pictures cannot end up
  breathing with whatever the video on it is doing), a computed `filter` on the
  `<img>` itself, and a LUT that is read back and checked to be **incapable of
  brightening any level** — black 0.000, white 0.810 at the default strength.
  Turning the toggle off removes the rule live and turning it back on restores
  it, as does strength 0;
- **LUT writes keep pace with presented frames** (30.2 updates/s against
  30.2 fps, median gap 33.4 ms against 33.3 ms per frame), measured with a
  `MutationObserver` on `tableValues` against `requestVideoFrameCallback` on the
  primary video. This is the observable that the push throttle and the
  frame-skip budget both govern, and a curve arriving late is judder whatever
  the adaptation behind it does;
- **no single update moves the curve far enough to read as a step** (largest
  smooth update 1.45 of one 8-bit level, median 0.08), from the same
  `MutationObserver`. Rate alone does not bound how far each write moves the
  picture, and it is the size of the increment that gets noticed; 1/255 is the
  finest step the compositor can render at all, so a couple of levels is the
  floor worth aiming at rather than a slack budget. Cut snaps are excluded and
  counted separately — they are meant to arrive whole and are masked by the cut
  itself. Pinning the stride to 4 reproduces the pre-fix behaviour (3.4 levels
  a jump at 7.8 Hz) and, with the fix, returns the same 1.45 levels as stride 1;
- one luminance sample costs well under a millisecond, and running the analysis
  at frame rate costs a few percent of one core (measured via
  `Performance.getMetrics` with processing off vs on);
- status reaches the service worker; audio reports `active`; video reports
  `adaptive` with the SVG technique;
- element `volume`/`muted` stay writable while processed;
- **the audio chain, rendered through an `OfflineAudioContext`** with a 300 Hz
  signal that steps from −45 dBFS to an abrupt full-scale burst and then a steady
  full-scale tone. The production `mapAudioStrength()` is bundled into the page
  so the measurement uses shipping code, not a copy of the numbers:
  - bypass is transparent to 0.01 dB;
  - the quiet passage rises +6.9 dB at strength 45 and +21.5 dB at 100, while the
    loud passage only ever falls (−3.01 → −3.15 → −4.65 dBFS);
  - usable range 45.0 → 38.0 → 21.9 dB, monotonic and never inverted;
  - the default strength removes at least 6 dB of range, so it cannot silently
    regress into a cosmetic setting;
  - the worst peak, burst included, is −0.18 dBFS: nothing reaches the sink at
    full scale;
  - latency is 12.00 ms (measured with an impulse, 576 samples at 48 kHz).

  This is what caught the two audio bugs described in the README: Chromium's
  undocumented internal make-up gain, and a knee wide enough to leave loud
  material uncompressed at the default strength. No audio device is used —
  offline rendering is silent by construction;
- **the night EQ**, measured through the two filters on their own: −5.15 dB at
  60 Hz, +0.25 dB at 700 Hz, +2.74 dB at 2.6 kHz at strength 70, and flat to
  within 0.001 dB at strength 0. The full chain is re-rendered with the EQ engaged
  to confirm the burst still never clips (worst peak −2.16 dBFS);
- **the popup's audio graph describes the real chain.** `audioTransferDb()` is an
  analytical steady-state model of the chain, and the popup plots it, so the suite
  renders the actual chain at −45/−30/−18/−6/0 dBFS and compares. Worst
  disagreement 1.7 dB, in the conservative direction. This is the check that stops
  the picture in the popup drifting away from what you hear;
- strength 0 removes the video filter and bypasses audio, live;
- master off removes processing; re-enabling restores it, live;
- **the toolbar badge** reads `off` when the extension is switched off, clears
  when it is switched back on, reads `site` on a tab whose host is excluded, and
  reads `day` while it is standing down until night;
- **the night window**, against a window shifted relative to the machine's actual
  clock: outside it no video is marked, audio reports `off` and the frame reports
  `gate=daytime/clock`; the reported source is `clock` with **no lux value**, which
  is also the documented behaviour of a browser that does not expose
  `AmbientLightSensor` (i.e. every stock Chrome); moving the window over the
  current time resumes processing with no reload;
- **leaving music alone**: with the exemption on, the bench's `<audio>` element is
  reported as `music` with `processed = 0` while video still reports `adaptive`,
  so the two halves really are independent; turning it off compresses it again;
- **separated sliders really separate**: video strength 0 with audio at 70 leaves
  no marked videos while audio still reports `active`, and the reverse bypasses
  audio while the tone curve keeps running;
- **per-site exclusion**: the frame reports a bare hostname (`localhost`), listing
  it stops both halves and sets `siteDisabled`, and listing an unrelated host
  leaves the page alone;
- a dynamically inserted video is picked up;
- a nested iframe gets its own content script and filter;
- the popup renders stored settings, **both** thumbnails draw and track the
  slider, the link toggle swaps the sliders over and persists the choice, the
  per-site button names the real host and writes the exclusion, and the status
  query returns a live aggregate;
- the popup's night controls: the clock fields stay hidden while the night
  restriction is off, switching it on reveals them and persists the choice, and the
  line under the switch **says which signal is deciding** rather than implying a
  sensor is in use when there is none;
- the keyboard-shortcut command is declared and described, and the popup's hint
  matches whatever `chrome.commands.getAll()` reports — including staying hidden
  when nothing is bound. (An extension side-loaded over CDP into a throwaway
  profile does not get its suggested accelerator assigned, so the binding itself
  is verified by hand: see section 9.);
- no console errors in the page, the service worker, or the popup.

Chrome is located automatically on macOS, Windows and Linux. Set `CHROME_PATH` to
override the search:

```bash
CHROME_PATH=/path/to/chrome npm run smoke          # macOS / Linux
$env:CHROME_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

## 3. Manual: the local test bench

```bash
npm run build && npm run testpage
# open http://localhost:8791
```

Media is generated in the browser (canvas → `captureStream`, and a WAV built in
JavaScript), so there are no test assets to download. Content scripts do not run
on `file://` URLs unless you allow it, hence the local server.

**Video, section 1.** The `<video>` is fed from the `<canvas>` beside it. The
extension only processes `<video>`, so the canvas is your unprocessed reference.

1. Strength 45, video on. Compare the two during the *night interior* phase: the
   dark bars and the low end of the step wedge should be visibly separated in the
   video and still crushed in the canvas.
2. Wait for the cut to *bright snow*. The video's sky should be less glaring
   **on the first frame you can see**, not half a second later: the adaptation
   snaps at a detected cut rather than easing in. What you are looking for is
   the absence of a visible settle, which is easiest to catch by watching the
   canvas and the video side by side across the cut.
3. Watch the fade back to night: this one is a *fade*, not a cut, so it must not
   snap. Brightness should recover slowly and smoothly, with no pumping, no
   stepping, and no sudden jump partway through the fade — a snap here would
   mean the cut detector is reading a gradual change as a scene change.
4. Watch the single-frame **FLASH**. It should be clearly softer in the video
   than in the canvas. The guard is reactive, so a one-frame flash is shortened
   rather than removed; the cut into the snow scene at t=3 s shows the effect
   much more clearly because it lasts longer than one frame.
5. Move the slider from 0 to 100 while playing. At 0 the video must be pixel
   identical to the canvas. There should be no jump at the bottom of the range.
6. Click **Request fullscreen** and confirm the effect still applies, then exit.
7. Check the colour bar strip: hues should stay recognisable, not muddy or
   washed out.

**Audio, section 2.** Use headphones at a low, comfortable volume.

1. Extension off: the −42 dBFS section is barely audible and the blast at 8 s is
   startling.
2. Extension on at 45, then 100: the quiet section should be clearly audible and
   the blast should stop being painful. It should sound like level riding, not
   like distortion or a tremolo.
3. While it plays, drag the element's volume slider, hit mute/unmute, pause and
   seek. All must behave exactly as normal.
4. Listen specifically to the 8 s burst at high strength: it should sound loud
   but clean. Any crackle or fizz there means the safety clipper is engaging too
   hard, or something upstream is exceeding full scale.
5. Listen for pumping on the 3 Hz amplitude modulation — there should be none at
   45, and at most a gentle breathing at 100.

**Lifecycle, section 3.**

1. **Insert a new video** → the popup's element count rises within about a
   second and the new video is processed.
2. **Replace the source** → playback changes, and processing continues without a
   glitch (the element is reused, not re-attached).
3. **Move it to another container** → it must *not* be torn down; audio must not
   click or drop.
4. **Remove it** → cleanup happens after the 4 s grace period; the popup count
   drops.

**Static test patterns, section 4.** The curve adapts to the *primary* video —
the largest playing one — so pause the other videos while judging a ramp. The
full-range ramp is well over the light budget, so with the extension toggled the
whole ramp should come down in level while its blacks stay pinned at black and
its steps stay clearly separated. Two different failures to watch for: if the
dark steps *lift* off black or the ramp goes grey, the washed-out regression is
back; if only the white patch moves and the rest of the ramp sits exactly where
it was, the exposure servo has stopped engaging. The dark ramp reads as a night
scene instead: its very dark steps should clearly separate from black.

To test the flash guard by hand, run `nnFlashWedge()` in the page console (or
`nnFlashWedge(600)` for a longer one) while watching the white patch: it should
dip briefly and settle back within about a second. Repeat with the extension off
to compare.

**Still images, section 5.** The `<img>` carries the same pattern as the canvas
beside it, and only the `<img>` is processed.

1. With the extension on, the white block in the picture should be clearly
   darker than the canvas's, and the black block should be *identical* — no
   lift. A lifted black here would mean the shadow half of the curve has leaked
   into the image path, which is the one thing it must never do.
2. The shadow steps should stay as far apart as they are on the right: stills
   get exposure and a shoulder, never a gamma change.
3. Turn **Images** off in the popup: the picture must snap back to matching the
   canvas exactly, with no reload. Turn it back on and it must return.
4. Set the picture slider to 0: same thing. At 0 the two must be pixel identical.
5. Scroll a real image-heavy page (a news front page, an image search) at
   strength 45 and check it reads as "the pictures came down a little", not as
   "the pictures went grey". Note that a site applying its own CSS `filter` to
   its images has that overridden while the toggle is on.

**Nested frame, section 6.** The iframe's player must be processed too.

## 4. Manual: YouTube

1. Open any video, ideally something with dark scenes.
2. Popup should report `Audio: compressing 1 player` and a picture line that
   starts `Picture: adaptive tone mapping`, with the image half after the dot
   counting whatever thumbnails the page is showing.
3. Toggle video off and on: the change should be immediately visible, no reload.
4. Toggle the strength slider during a bright scene and confirm it responds live.
5. **Navigate to another video from the sidebar** (SPA navigation, no page load):
   processing must continue, and the popup must not accumulate stale element
   counts.
6. Turn on subtitles: YouTube draws them outside the video element, so they must
   stay unaffected while the picture is tone-mapped.
7. Use fullscreen, theatre mode, and the miniplayer. The effect should follow the
   video in all three.
8. Open Picture-in-Picture: the PiP window is a separate surface, so the effect
   will *not* apply there. Expected, documented.
9. Skip through an ad break (the player swaps sources): no console errors, audio
   stays processed.
10. Open DevTools → Console and confirm the extension logs nothing in a
    production build.

## 5. Manual: Vimeo

1. Open any Vimeo video (Vimeo uses MSE, so audio is fully processable).
2. Confirm `adaptive` mode and audio compression in the popup.
3. Test the embedded-player case: open any page with a Vimeo embed
   (`player.vimeo.com` in an iframe). The extension injects into all frames, so
   the embed must be processed too.
4. Change quality mid-playback; processing must survive the source switch.

## 6. Manual: a DRM site (expected partial support)

Use Netflix, Prime Video, Disney+, or Spotify's web player.

1. Start playback and open the popup. Expect:
   - `Audio: compressing 1 player` — audio compression **does** work;
   - a picture line reading `Picture: fixed night curve · …`;
   - a note explaining that protected video cannot be analysed.
2. Confirm the video effect is still visible (shadows lifted, highlights
   softer) but does **not** react to scene changes.
3. If you see *no* video change at all, your system is using a protected
   hardware overlay (L1 decryption). That surface bypasses CSS effects; there is
   no legitimate workaround, and the extension does not attempt one.
4. Confirm playback is never blocked, and that no DRM error appears. The
   extension must never interfere with license acquisition.

## 7. Performance checks

1. Chrome Task Manager (`Window → Task Manager`): compare a 1080p YouTube tab
   with the extension on and off. Expect a difference in the low single-digit
   percent, mostly from the compositor.
2. DevTools → Performance, record 10 s of playback:
   - no long tasks attributable to the extension;
   - the 125 ms timer's work should be well under a millisecond per tick;
   - no layout thrash (the tone update is a single attribute write).
3. Scroll and interact with the page during playback: input must stay responsive.
4. Try a 4K stream. If it stutters, the GPU is on a slower path for filtered
   video — lower the strength or disable video processing (documented
   limitation).
5. Leave a tab playing for 30+ minutes, then check memory in the Task Manager:
   it should be flat. Then open and close 20 videos in a row and confirm the
   audio context count does not grow (the popup would report players as skipped
   if contexts leaked).

## 8. Failure modes to verify

| scenario | expected behaviour |
| --- | --- |
| Cross-origin `<video src>` without CORS headers | audio is rolled back to native playback within ~3 s; popup explains why; **audio never goes silent** |
| Autoplay-muted video, no user interaction yet | video processed; audio waits, then engages after the first click |
| More than 4 simultaneous playing players | first four processed, the rest reported as skipped; nothing breaks |
| Page with `<base href>` | the filter reference is written as an absolute URL and the effect still applies |
| Extension reloaded from `chrome://extensions` while a tab plays | the old content script stops quietly; no console errors; the page keeps playing (reload the tab to resume processing) |
| Storage unavailable / settings corrupted | defaults are used; no exception reaches the page |
| A site that clears `document.head` or rewrites attributes | the filter and markers are restored on the next tick |
| `chrome://extensions` or the Web Store in the active tab | popup says processing is not available on this page |
| Hidden/background tab | analysis pauses; popup reports the fixed curve; adaptivity resumes when the tab is shown |

## 9. Keyboard shortcut and toolbar state

1. With a video playing, press `Alt+Shift+N`. Processing should stop
   immediately, in every open tab, without the popup being opened.
2. **Watch the toolbar icon**, not the video: it must dim and show an `off`
   badge. This is the whole point of the badge — on a tab with no video the key
   press would otherwise have no observable effect at all.
3. Press it again to restore. The icon returns to normal and the badge clears.
   Open the popup and confirm the master toggle reflects the current state.
4. Visit `chrome://extensions/shortcuts`, remap it, and confirm the new binding
   works **and that the popup's hint now shows the new keys**. Unbind it entirely
   and confirm the hint disappears rather than showing an empty key.

## 10. Per-site exclusions

1. On a page with a video, open the popup. The status card's title row should
   offer **Skip *hostname***, naming the site you are on.
2. Click it. Processing stops for that tab immediately — the popup says
   `turned off on <host>` for both halves, and that tab's badge reads `site`
   while the master switch stays on.
3. Open a *different* site with video and confirm it is still processed.
4. Return to the skipped site and click the button again; processing resumes
   without a reload.
5. Skip a domain, then visit a subdomain of it (e.g. skip `example.com`, then
   open `news.example.com`): the subdomain must also be skipped, and the button
   must show as pressed there.
6. Find a page with an embedded player from another origin (a YouTube or Vimeo
   embed on a blog). Skipping the *blog* must silence the embed, because a frame
   is governed by the page it is embedded in.

## 11. Split strength and night EQ

1. In the popup, click **Set audio and video separately**. The single slider is
   replaced by two, and the two graphs update independently.
2. Set video strength to 0 and audio to 80: the picture must go back to normal
   while the popup still reports audio compressing. Then reverse it.
3. Click **Use one slider for both**: the master slider reappears at the midpoint
   of the two values.
4. **Night EQ**, with headphones on quiet dialogue-heavy content: switching it on
   should audibly thin out the bass and bring speech forward. It must not change
   the perceived loudness much — if it gets obviously louder or quieter, the
   make-up compensation is wrong.
5. Turn night EQ on and set strength to 0. Everything must be bypassed; the EQ
   must not survive a bypass.
6. With night EQ on at strength 100, listen to a loud bass-heavy passage for
   crackle. Any distortion means the presence lift is not being paid for out of
   make-up gain.

## 12. The night window and the light sensor

1. Open the popup on a page with video. **Only at night** should be on, with the
   window reading 21:00–07:00 (in your locale's format) and the line under the
   switch saying which signal is deciding.
2. If it is currently outside the window, both status lines should read
   `waiting for 09:00 PM` (or your start time), that tab's badge should read
   `day`, and no video should be filtered. That is the feature working, not a
   fault.
3. Set the window to bracket the current time (say, an hour either side).
   Processing must start within a second or two, with no reload, in every open
   tab.
4. Set the *end* of the window to two minutes from now and wait. Processing must
   stop on its own when the boundary passes — this is the timer, not a poll, so a
   failure here looks like "it never stops".
5. Set both fields to the same time. The line under the switch must say the clock
   will never stop it, and processing must run at any hour.
6. Switch **Only at night** off: the clock fields disappear and processing runs
   whenever the master switch is on.
7. **With the sensor** (optional, and most machines cannot do this): enable
   `chrome://flags/#enable-generic-sensor-extra-classes`, relaunch Chrome, and
   open the popup on a device that has a light sensor. The line should now read
   `Light sensor: N lux, …`. Cover the sensor and confirm processing engages even
   during the day; shine a light at it and confirm it stands down even at night.
   Note the deliberate gap between 30 and 60 lux: near the boundary the previous
   verdict is kept, so it should *not* flicker.
8. Without the flag, confirm the popup says `No light sensor here, so the clock
   decides` rather than implying a sensor is in use.

## 13. Leaving music alone

1. With **Leave music alone** on, open `music.youtube.com` and play a track. The
   popup must report `Audio: left alone, this is a music service`. If the track
   has a video, the picture should still be tone-mapped — the two halves are
   independent on purpose.
2. Do the same on `open.spotify.com` and on SoundCloud.
3. Open plain `youtube.com` and play a film trailer: audio **must** be compressed.
   This is the case the list is designed not to break.
4. Find any page with an `<audio>` player (a podcast page will do): it should be
   reported as music and left alone. This is the known false positive — a podcast
   would benefit from compression.
5. Switch the toggle off and confirm the same players are compressed again, live.
6. On a page with both a film and a music player going at once, the status line
   should read `compressing 1 player, 1 left as music`.

## 14. Accessibility pass

1. Open the popup and drive it with the keyboard only: `Tab` through master
   toggle → strength slider → link toggle → only-at-night → the two clock fields
   → audio → video → night EQ → leave-music-alone → skip-site button → reset.
   Every control must show a visible focus ring.
2. Toggle with `Space`, move the slider with arrows and `Home`/`End`, and type or
   arrow through the clock fields. Clearing a clock field and tabbing away must
   restore the stored time rather than writing a broken window.
3. With a screen reader, confirm the slider announces value and label ("70 of
   100, Strong") and that the status region is announced when it changes. Check
   that the skip-site button announces its *pressed* state, since its label does
   not change between on and off.
   - macOS: VoiceOver (`Cmd+F5`).
   - Windows: NVDA or Narrator (`Win+Ctrl+Enter`). Tab to each control and
     confirm the name, role and state are read.
4. Enable *Reduce motion* (macOS System Settings, or Windows Settings →
   Accessibility → Visual effects → Animation effects) and confirm the toggles no
   longer animate.
5. **Windows High Contrast** (Settings → Accessibility → Contrast themes, or
   `Left Alt+Left Shift+PrtScn`): every switch must remain clearly on or off.
   This is worth checking specifically, because the normal styling carries switch
   state in `background` alone, which `forced-colors` discards — before the
   `forced-colors` block was added, on and off looked identical here. Also
   confirm the two graph thumbnails still have visible borders and that the
   status dots remain distinguishable.
6. Zoom the browser to 150% and 200% and confirm nothing in the popup is clipped
   or overlapping.

Full WCAG conformance cannot be established by these checks alone — it requires
manual testing with assistive technologies across platforms and expert
accessibility review.

## 13. Popup layout budget

Chrome caps a popup at 600 CSS px tall and scrolls past that, so the layout has a
height budget. To check it without clicking through a browser:

```bash
npm run build
node scripts/popup-shot.mjs 45 ./popup.png          # linked sliders
SPLIT=1 NIGHT_EQ=1 node scripts/popup-shot.mjs 45   # the taller state
```

It prints the measured height, the height with the per-site button showing (the
worst case), and whether that fits the cap. Current: 547 px linked, 553 px with
the per-site button, 594 px with the sliders separated.
