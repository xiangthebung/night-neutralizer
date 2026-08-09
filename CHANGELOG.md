# Changelog

Notable changes per release. Dates are release dates; the format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely and versions
follow [semver](https://semver.org/).

## [1.0.0] - 2026-08-09

First public release: adaptive video tone mapping via an SVG LUT applied by the
compositor, per-element Web Audio dynamic-range compression with a soft-clip
safety stage, media discovery across shadow roots and iframes, cross-origin audio
rollback, and a popup reporting what is actually happening per tab.

The sections below are the detail behind that summary. They read as deltas
because they are: the version number never moved during development, so they
describe what changed against the builds people loaded unpacked from GitHub
before this went to the store.

### Added

- **It only runs at night now** (on by default). If the browser exposes an
  ambient light sensor the room decides; otherwise a configurable window on the
  local clock does, defaulting to 21:00–07:00. The sensor outranks the clock
  because it answers the actual question: a room with the blinds down at 4 p.m.
  is exactly when this helps, and a lit room at 11 p.m. is exactly when it is
  not needed.

  Being straight about the sensor: `AmbientLightSensor` is implemented in
  Chromium but not exposed to pages unless
  `chrome://flags/#enable-generic-sensor-extra-classes` is on and the browser
  relaunched, and the machine needs the hardware. **So on a stock install the
  clock is what runs**, and the popup says which signal is in charge rather than
  implying a sensor is in use. Enable the flag and it is picked up with no further
  configuration.

  Implementation notes: dark is ≤30 lux and lit is ≥60, with the gap between them
  keeping the previous verdict so a reading hovering at the boundary cannot switch
  the extension on and off once a second. Only a top-level frame can read a sensor
  (the `ambient-light-sensor` permission policy defaults to `self`), so one frame
  publishes to `chrome.storage.session` and every other frame in every tab picks it
  up through `onChanged` — otherwise a cross-origin embedded player would fall back
  to the clock and disagree with the page hosting it. Publishing is throttled to
  verdict changes plus real movement, so a steady room costs nothing. Clock
  boundaries are a timer that sleeps until the next one, capped at ten minutes so a
  DST change or a corrected system clock cannot go unnoticed for an hour.
- **Music is left alone** (on by default). Dynamic range compression fixes
  dialogue mixed 30 dB below the explosions; on a record the range *is* the
  performance. Two signals decide: the host (any `music.*` subdomain, so
  `music.youtube.com`, `music.apple.com` and `music.amazon.co.uk` are covered by
  one rule, plus an explicit list of Spotify, SoundCloud, Bandcamp, Deezer, Tidal
  and similar), and the element (an `<audio>`, or a `<video>` carrying no picture
  once its metadata has loaded). Note that `music.youtube.com` is listed and
  `youtube.com` is not.

  Only the audio half stands down. Tone mapping a music video at 1 a.m. is still
  worth doing and has nothing to do with what you are listening to. The known
  false positive is a podcast or audiobook in an `<audio>` element, which would
  benefit from compression and will not get it; that is why there is a toggle.
- **One gate, one reason** (`core/gate.ts`). Whether a frame processes anything
  was an inline `enabled && !siteDisabled` in the content script. Adding "and it
  has to be dark" and "and the clock has to agree" to that would have left the
  engines, the popup and the badge each deriving the same answer separately, so
  the decision now happens in one pure, tested module that returns *why* along
  with the answer, and everything else displays what it returned.
- **A `day` badge** on tabs where the extension is standing down until night.
  Without it, "correctly doing nothing until 21:00" and "broken" look identical
  from the toolbar — the same reasoning that produced the `off` and `site` badges.
- **Night EQ** (off by default): a low shelf down to −7 dB below 120 Hz and a
  wide +3.5 dB bell at 2.6 kHz. Compression makes quiet dialogue audible, but
  bass is what carries through walls, so this is what actually lets the volume
  come down. Measured at strength 70: −5.15 dB at 60 Hz, +0.25 dB at 700 Hz,
  +2.74 dB at 2.6 kHz. The presence lift is paid for out of make-up gain, so the
  existing headroom guarantee still holds with it engaged.
- **Separate audio and video strength.** One slider by default; a link toggle
  splits it in two for "compress the soundtrack hard, leave the picture nearly
  alone". Re-linking takes the midpoint.
- **Per-site exclusions.** A "skip *hostname*" switch in the popup leaves a site
  completely alone. Matching covers subdomains and applies to both the page and
  the origin of an embedded player. This needed no new permission: each frame
  resolves its own top-level hostname via `location.ancestorOrigins` and reports
  it with its status, in memory-only session storage.
- **Toolbar state feedback.** The icon dims and the badge reads `off` when the
  extension is switched off, and `site` on a tab you have skipped. Previously the
  `Alt+Shift+N` shortcut was completely silent on a tab with no video, so there
  was no way to tell whether the key press had registered.
- **An audio graph in the popup**, alongside the existing tone curve: settled
  input level against output level in dB, drawn from the same mapping the engine
  uses. The slider used to have no visual for the audio half at all.
- **Plain-language captions under both graphs** (`core/readings.ts`), stating the
  effect in numbers — at the default, "dark scenes 2.9× brighter / whites 19%
  softer" and "quiet parts +9 dB / loud-to-quiet gap −9 dB". A curve with
  unlabelled axes and "in → out" underneath it is legible to whoever wrote it and
  opaque to whoever is trying to decide where to put the slider. The figures are
  derived from the same curve and transfer functions the engines use and are
  rounded down, so a caption cannot promise more than the chain delivers. Each
  graph also describes its axes on hover.
- **The popup shows the keyboard shortcut** it is actually bound to, with a link
  to remap it, and shows nothing if it has been unbound.
- **`LICENSE`** (MIT, as both the README and `package.json` already claimed) and
  this changelog.
- **CI** (`.github/workflows/verify.yml`): typecheck, unit tests, production
  build, packaging, and the real-Chrome smoke suite on every push.
- **Unit tests for the content-script edges** that previously had none:
  `tone-filter.ts` under jsdom (including the `<base href>` workaround and
  fullscreen re-parenting) and `status-reporter.ts` throttling.
- **Tests for the new modules**: the midnight-wrapping window and its boundary
  arithmetic, the lux classifier's hysteresis and publishing throttle, the music
  host and element heuristics (including that every list entry is already in
  normalised form, or it could never match), and the gate's order of precedence.
  End to end, the night window is exercised against a window shifted relative to
  the machine's real clock, and the music exemption against the bench's `<audio>`
  element while video keeps being tone mapped. Unit tests total 302, up from 119;
  smoke checks 70, up from 42.

### Changed

- **The popup still fits Chrome's 600 px popup cap**, with three more controls in
  it. It was 627 px before this release; adding the night window and the music
  toggle naively took it to 697 px (743 with the sliders separated). It is now
  **550 px** (556 with the per-site button, 597 with the sliders separated).
  Reclaimed by tightening the card and toggle spacing, moving the "what to
  process" heading to screen readers only, putting the night-EQ and music notes
  inline instead of on their own lines, putting the footer on one row, shortening
  both graph thumbnails from 100 to 80 px of backing store, and dropping the
  tagline — the two graph captions already state the same thing in numbers.
  `scripts/popup-shot.mjs` measures this so it cannot regress unnoticed.
- **The night window is rendered in your locale's format.** A caption reading
  "21:00 to 07:00" next to a time input Chrome renders as "09:00 PM" describes the
  same setting twice in two different languages.
- **`chrome.storage.session` is now readable by content scripts**
  (`setAccessLevel`), which is what lets one frame's light reading reach every
  other frame without a broadcast loop over your tabs. Content scripts run in an
  isolated world, so page JavaScript still cannot reach it, and the widest thing
  exposed is the set of hostnames the extension already knows about.
- **`hostCovers()` is exported from `core/site.ts`** rather than being a private
  helper, because the same subdomain-containment rule governs the music-service
  list. Two implementations of it would eventually disagree.
- **`npm run zip` no longer needs a `zip` binary**, so packaging works on Windows.
  The archive is written by Node with fixed timestamps (byte-identical rebuilds),
  then read back and CRC-checked entry by entry so a malformed package fails the
  build rather than the store upload.
- **The headless dev tools find Chrome on any platform.** `scripts/smoke.mjs` and
  `scripts/popup-shot.mjs` defaulted to the macOS bundle path, so `npm run smoke`
  could not run out of the box on Windows or Linux. `CHROME_PATH` is now an
  override rather than a requirement.
- **"Maximum" is reserved for the top of the strength range.** It used to apply
  from 80 up, so the popup read "80 · maximum" with the slider visibly short of
  the end. 80–94 now reads "very strong".
- `scripts/popup-shot.mjs` reports the popup's height against the 600 px cap
  (including the worst case where the per-site button is showing) and the state of
  the shortcut hint, so layout regressions are visible without opening a browser.

### Fixed

- **Normal videos are no longer washed out.** The adaptive tone curve had
  global floors on its shadow lift and highlight roll-off, so every scene —
  normally exposed ones included — had its blacks greyed, its mid-tones
  gamma-brightened and its whites pulled down: lower contrast everywhere, and
  sometimes a picture brighter than the original. The adaptation is now
  scene-gated. A dark scene keeps exactly the treatment it had (shadow lift,
  gamma, an armed highlight shoulder for cuts); a genuinely bright scene is
  dimmed toward the comfort target with its blacks left at zero, so it reads as
  "brightness came down" rather than "contrast went"; and a normally exposed
  scene converges on the identity curve — untouched picture, untouched colour
  (the saturation compensation now scales with the lift instead of applying
  globally). The exposure dim also gained a dead band, so ordinary footage stops
  being treated as glare — see the next entry for how that band is decided now.
  Pinned by new unit tests and by smoke-test screenshots of a second, dark test
  ramp: the normal ramp must keep its blacks and shadow band while the dark ramp
  must get its shadows lifted.
- **Bright scenes now actually get darker, instead of only getting flatter.**
  The fix above over-corrected. Three things were wrong with it, and a
  half-dashboard/half-sky dashcam clip hit all three at once: the whole frame
  lost contrast at the top and none of its brightness, and a frame or two either
  side of the threshold came out *brighter* than the original.

  - **The scene classifier measured the wrong thing.** It averaged
    gamma-encoded luma, which says how dark a frame looks and is dominated by
    however much of the frame happens to be dark. The dashcam clip's encoded
    mean is 0.34 — squarely "normal" — while its sky throws real light at the
    viewer; measured in linear light and re-encoded, the same frame reads 0.46.
    `computeSceneStats` now reports both, and the exposure and shadow decisions
    run off the linear one. It costs 64 `pow` calls per analysed frame (one per
    histogram bin) rather than one per pixel.
  - **Exposure never engaged.** It began at a mean of 0.45 and was fully
    engaged at 0.70, which almost no real footage reaches once anything dark is
    in shot, and it could only reach 0.85× at the default strength anyway. So
    the only stage that ever fired on a bright scene was the highlight shoulder,
    which took ~10% off the top decile, cost ~20% of the slope across the top
    fifth of the range, and left the frame emitting exactly as much light as
    before. Exposure is now a servo against a fixed light budget —
    `comfortLight / light`, floored by strength — and its floor went from 0.65
    to 0.5. The dashcam clip loses about a fifth of its light output at the
    default; a full daylight scene about half at maximum.
  - **A dark object in a bright frame read as crushed shadows.** A black car
    interior filling the lower half of the frame pushed the mean under the dark
    threshold and the 10th percentile to near zero, which engaged the shadow
    lift: gamma up, black point up, the picture *brighter* and flatter. The lift
    is now vetoed by emitted light, so whatever the mean says, a frame throwing
    that much light is not a night scene. Genuinely dark content is untouched by
    the veto and keeps the full lift.

  On top of that, **the curve stopped spending its contrast in the wrong
  place.** A curve that dims must lose slope somewhere, and a fixed shoulder
  always loses it at the top of the range — which on a bright scene is exactly
  where the pixels are densest. The 33-entry LUT is rebuilt every frame anyway,
  so it is now shaped by the frame's own histogram: per-interval slopes are
  rescaled towards the levels the scene actually occupies and away from the
  empty ones, clipped at 3× a level's fair share so a large flat region cannot
  claim slope for its own noise, bounded to 0.55–1.8× per interval, smoothed
  across bins and over time so the curve cannot pump, and engaged strictly in
  proportion to the range the dimming just gave up — a scene being left alone is
  left alone by this stage too. Mid-tone slope on the dashcam clip goes from
  0.74 to 0.90 at the same white point. Where no histogram is available (DRM,
  tainted canvas, the popup's preview) the curve keeps its plain parametric
  shape.

  Two smaller corrections fell out of this. The highlight shoulder was being
  solved against full scale while exposure had already moved the white point, so
  the top of the range was dimmed twice and flattened twice; both the knee and
  the white point are now fractions of the range exposure leaves behind. And the
  contract in the tests said "a normally exposed scene is untouched", which is
  what stopped the effect doing its job — dimming by a scale is not washing out.
  It now says: no lifted black point, no gamma-brightened mid-tone, no flattened
  top, and every ratio below the shoulder preserved exactly. A scene inside the
  light budget is still bit-for-bit untouched, and there is a test for that too.

- **The popup could render at roughly double its width**, with the 330 px column
  stranded against the left edge and a wide empty panel beside it. `popup.html`
  carried `<meta name="viewport" content="width=device-width">`, copied from
  ordinary web-page boilerplate. A browser-action popup has no viewport to adapt
  to: Chrome auto-sizes it from the renderer's preferred width and clamps that to
  800 px, so `device-width` handed it the *monitor* width and the popup came back
  pinned at the cap. Whether it showed depended on the display, which is why it
  could appear to start happening on its own. The tag is gone, and the width is
  now stated on `html`/`body` as well as on the column — through one
  `--app-width` custom property, so the two cannot drift — leaving Chrome nothing
  to stretch.

  `scripts/popup-shot.mjs` measured `.app.offsetWidth`, a fixed 330 px by
  construction, so it could never have caught this. It now reports the *document*
  width against the column and calls out a mismatch.
- **The shortcut hint could render an empty key pill.** `[hidden]` is only a
  user-agent `display: none` rule, and `.shortcut { display: flex }` silently
  overrode it, so the row appeared even when the code had hidden it. `[hidden]` is
  now enforced once, globally, for the whole popup.
- **Doc/code drift in the audio path.** The chain diagram in `audio-engine.ts`
  omitted the safety stages and quoted a 3 ms attack and −1.5 dB limiter threshold
  where the code sets 2 ms and −0.5…−2 dB; `strength.ts` claimed a −3 dBFS peak
  target where the code targets −4 dBFS; the README presented the limiter's
  maximum-strength threshold as a fixed value.
- **`DEFAULT_SETTINGS` could be mutated through a spread.** `reset()` and the
  storage-failure fallback returned an object aliasing the module-level default
  exclusion array; both now go through `sanitizeSettings()`, which always
  allocates.
- **Windows High Contrast made the switches unreadable.** Every toggle conveyed
  its state through `background` alone, which `forced-colors` discards, so on and
  off looked identical. State is now carried by border and thumb colours mapped
  onto system colour keywords.
- **The content script had two copies of its status snapshot builder**, one for
  pushed reports and one for the popup's direct query. They had to be edited in
  lockstep; there is now one.
- Cleaning up the temporary Chrome profile no longer masks a successful
  screenshot on Windows, where Crashpad holds a file handle briefly after exit.

### Migration

Existing stored settings — from an unpacked install — load unchanged. `sanitizeSettings()` mirrors the old
single `strength` into the new per-channel values, so someone running at 70 who
splits the sliders gets 70/70 rather than a jump to the default; `linked` defaults
to true, `nightEq` to false, and `disabledSites` to empty.

**Two behaviour changes on update, both deliberate.** `nightOnly` and `skipMusic`
default to true, so an existing install that previously processed everything at all
hours will, after updating, do nothing between 07:00 and 21:00 and leave audio-only
players alone. That is the point of the release rather than a side effect, and both
are one switch away in the popup, which states which signal is deciding and shows a
`day` badge on tabs where it is standing down. The night window is stored as minutes
since local midnight; `sanitizeClock()` also accepts `"HH:MM"`, so a hand-edited
storage value works too.
