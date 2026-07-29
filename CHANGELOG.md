# Changelog

Notable changes per release. Dates are release dates; the format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely and versions
follow [semver](https://semver.org/).

## [Unreleased]

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
  effect in numbers — at the default, "dark scenes 2.9× brighter / whites 14%
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
  element while video keeps being tone mapped. Unit tests total 298, up from 119;
  smoke checks 69, up from 42.

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

Existing stored settings load unchanged. `sanitizeSettings()` mirrors the old
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

## [1.0.0]

First release: adaptive video tone mapping via an SVG LUT applied by the
compositor, per-element Web Audio dynamic-range compression with a soft-clip
safety stage, media discovery across shadow roots and iframes, cross-origin audio
rollback, and a popup reporting what is actually happening per tab.
