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

`npm test` — 119 tests, no browser required.

| file | covers |
| --- | --- |
| `tests/strength.test.ts` | strength → processing parameters: true bypass at 0, clamping and non-finite input, monotonicity across all 101 values, release lengthening with strength, **make-up gain that accounts for Chromium's own internal make-up** and keeps the modelled peak below full scale at every strength, **a bounded safety stage always present**, quiet boosted more than loud with the range never inverting, every value inside the Web Audio legal range, no discontinuity next to bypass |
| `tests/soft-clip.test.ts` | safety clipper: exact identity below the knee, never exceeding the ceiling for input up to 50× full scale, monotonic and symmetric, less than 1 dB cost to a full-scale signal, decreasing slope, curve sampling (odd length, exact zero, identity samples on the identity line), identity params producing a straight line |
| `tests/tone-curve.test.ts` | luminance statistics (Rec. 709 weights, percentiles), soft-knee solver, curve monotonicity and bounds for every strength, shadow lift without crushing black, **a visible effect at the default strength**, **the shoulder never being scaled away while a scene is dark**, highlight compression, decreasing slope towards white, mid-tones not washed out, **flash detection at 60/30/8 Hz sampling with a fade tripping none of them**, **dim scaling with jump size**, **the white level dropping more than mid-tones when a flash fires**, adaptation: bright scenes dim / dark scenes are lifted instead, dims faster than it recovers, bounded under NaN/out-of-range input, static state is genuinely fixed and **does not apply strength twice**, **adaptive bounds bracketing the range and collapsing onto the identity when bypassed**, CSS fallback shape |
| `tests/media-registry.test.ts` | discovery before and after start, dynamic insertion, **duplicate prevention** (re-attach, rescan, DOM move), open shadow roots (and closed ones ignored), removal only after the grace period, re-parented elements surviving, subtree removal, element swap, mutation-storm rescan, throwing handlers, `stop()`/`release()`, idempotent `start()` |
| `tests/settings.test.ts` | sanitisation of missing/garbage/hostile values, clamping and rounding, unknown keys dropped, save→load round-trip through a fresh store, storage failure falling back to defaults, `ensureDefaults` writing only once, reset, change notifications, ignoring other areas/keys, unsubscribe not leaking listeners |
| `tests/media-origin.test.ts` | Web Audio safety classification: MSE/blob (YouTube, Vimeo), `data:`, `srcObject`, same-origin, `file:`, plain cross-origin flagged risky, CORS-attributed accepted, empty source deferred, unparseable URLs and opaque origins treated conservatively |
| `tests/status.test.ts` | multi-frame aggregation, state precedence, note deduplication, staleness, pruning |

## 2. Automated: end-to-end in real Chrome

```bash
npm run smoke
```

Installs the built extension into a throwaway Chrome profile over the DevTools
protocol (`Extensions.loadUnpacked`; Chrome 137+ ignores `--load-extension`),
serves the test bench, and asserts 42 checks:

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
- **the flash guard**: a hard scene cut moves the white point in a single step
  (~0.12), and a controlled 250 ms white flash on the static pattern takes the
  encoded white level 0.819 → 0.741 and then releases back to 0.819;
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
- strength 0 removes the video filter and bypasses audio, live;
- master off removes processing; re-enabling restores it, live;
- a dynamically inserted video is picked up;
- a nested iframe gets its own content script and filter;
- the popup renders stored settings, its tone-curve thumbnail draws and tracks
  the slider, and its status query returns a live aggregate;
- the keyboard shortcut is registered and actually bound to a key;
- no console errors in the page, the service worker, or the popup.

Set `CHROME_PATH` if Chrome is not at the macOS default location.

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
2. Wait for the cut to *bright snow*. The video's sky should be noticeably less
   glaring, and it should settle within roughly half a second (fast dimming).
3. Watch the fade back to night: brightness should recover slowly and smoothly,
   with no visible pumping or stepping.
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

**Static test pattern, section 4.** Toggle the extension while looking at the
ramp: the eight very dark steps should separate from black, the white patch
should visibly pull back from pure white, and the middle of the ramp should stay
roughly where it was. If the whole ramp just gets darker or lighter, something is
wrong.

To test the flash guard by hand, run `nnFlashWedge()` in the page console (or
`nnFlashWedge(600)` for a longer one) while watching the white patch: it should
dip briefly and settle back within about a second. Repeat with the extension off
to compare.

**Nested frame, section 5.** The iframe's player must be processed too.

## 4. Manual: YouTube

1. Open any video, ideally something with dark scenes.
2. Popup should report `Audio: compressing 1 player` and
   `Video: adaptive tone mapping (scene analysis on)`.
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
   - `Video: fixed night curve (frames not readable)`;
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

## 9. Keyboard shortcut

1. With a video playing, press `Alt+Shift+N`. Processing should stop
   immediately, in every open tab, without the popup being opened.
2. Press it again to restore. Open the popup and confirm the master toggle
   reflects the current state.
3. Visit `chrome://extensions/shortcuts`, remap it, and confirm the new binding
   works.

## 10. Accessibility pass

1. Open the popup and drive it with the keyboard only: `Tab` through master
   toggle → slider → audio → video → reset. Every control must show a visible
   focus ring.
2. Toggle with `Space`, move the slider with arrows and `Home`/`End`.
3. With VoiceOver (`Cmd+F5`), confirm the slider announces value and label
   ("70 of 100, Strong") and that the status region is announced when it changes.
4. Enable *Reduce motion* in macOS settings and confirm the toggles no longer
   animate.

Full WCAG conformance cannot be established by these checks alone — it requires
manual testing with assistive technologies across platforms and expert
accessibility review.
