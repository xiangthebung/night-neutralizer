# Changelog

Notable changes per release. Dates are release dates; the format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely and versions
follow [semver](https://semver.org/).

## [Unreleased]

### Added

- **Dark mode: the page around the media.** A new switch in the picture panel,
  off by default and gated by night like everything else. The rest of this
  extension treats *content* and takes care not to change what the author
  intended; this deliberately changes how a site looks, which is why it is not
  implied by the master switch and does not arrive switched on with an update.

  It asks the site first and measures whether it answered. The polite
  request is `color-scheme: dark`, which is worth making because it is free and
  fixes precisely what inversion handles worst — form controls, scrollbars, and
  the canvas behind a page that paints no background of its own.

  What it does *not* do is flip `prefers-color-scheme`. That query reports the
  user's preference, not the property, and an extension with no `debugger`
  permission cannot change it — so the large majority of sites, which put their
  dark theme behind `@media (prefers-color-scheme: dark)`, will not answer at
  all. This was measured in Chrome rather than assumed, and it is why the
  fallback is the path most pages actually take: `invert(1) hue-rotate(180deg)`
  on the root, undone on media.

  That pair is an involution rather than an approximation. Writing `I(x) = 1 − x`
  and `M` for the hue-rotation matrix, `f(x) = M(1 − x) = 1 − Mx` because `M`
  fixes white, so `f(f(x)) = x` exactly — a photograph inside an inverted page
  comes back out exactly as it went in.

  **Neither end of the inverted range goes all the way.** A straight inversion
  sends a white page to `#000000` and its black text to `#ffffff`, which is more
  contrast than anyone wants at 1 a.m. The output is squeezed into
  `#121212 … #dbdbdb` instead, by a `contrast()`/`brightness()` pair composing to
  `out = in·(ceiling − floor) + floor`. It costs much less legibility than it
  sounds like it should, because the squeeze is *relational* — text and
  background move together — so black-on-white goes from 21:1 to 13.5:1 (WCAG
  AAA wants 7:1) and `#666`-on-white from 5.74:1 to 5.48:1. Both are pinned by
  unit tests; the endpoints are measured off real screenshots in the smoke run.

  Media rides the same squeeze and is deliberately not compensated for it, which
  is a property of filters rather than a decision: an element filter cannot emit
  values outside 0..1, so nothing inside the filtered root can land outside
  `[floor, ceiling]`. Compensating would demand that impossible expansion and
  clamp, flattening everything above 85% of a photograph's range into one value.
  Riding the squeeze is a linear scale that loses no detail at all.

  **Fullscreen needed two rules of its own, and finding out why was the reason
  this took a second pass.** A fullscreen element is in the top layer, and the
  top layer is *not* painted through its ancestors' filters — but it **is**
  painted through its own. Verified in Chrome. So the first cut of this feature
  would have rendered a fullscreen video as a photographic negative: the
  counter-inversion stayed on the element with no root inversion left to cancel
  it. Media in the top layer now drops the compensation while keeping its tone
  curve, and a non-media element in the top layer takes over the root filter's
  job so fullscreening a slideshow does not flash the page back to white.

  Three decisions worth recording. The applied scheme is `light`, not `dark`,
  once a page is being inverted: the UA widgets are about to be flipped, so they
  have to be drawn light in order to end up dark, and asking for a dark scheme
  there is the one thing that makes a form control glow on a black page. The
  counter-inversion is appended to the image and video engines' own rules rather
  than written as a rule of its own, because `filter` is a single property and
  two rules cannot merge — only one can win, so the zero-specificity
  `:where(img,video,iframe,embed,object)` fallback covers exactly the media
  those engines have not claimed. And `iframe` is in that list because every
  frame runs its own copy of the engine: a nested document inverts itself if it
  needs to, so inverting it again from the parent would cancel it back to white.

  Cost to the popup: one row plus a readout line that is only rendered while the
  switch is on. `scripts/popup-shot.mjs` measures that state by default instead
  of flattering the layout.

- **Still images are tone mapped too.** A bright photograph at 1 a.m. is exactly
  as unpleasant as a bright frame of video, and until now the extension dimmed
  one and not the other. `<img>` now goes through the same compositor path — a
  second `feComponentTransfer` filter, referenced by one `img { filter: … }`
  rule — with a new **Images** toggle beside Video, on by default and driven by
  the picture slider (0 is a bypass there too).

  The popup pays nothing for it. Chrome caps a popup at 600 px and the layout
  had 6 px of slack in its tallest state, so Video and Images share one row (they
  are the two halves of the same path, and the tone-curve graph above explains
  both), and the status card reports the picture in one line covering both
  halves — `Picture: adaptive tone mapping · 42 images toned` — instead of
  repeating the master switch, the exclusion list and the night gate on a second
  line. Measured before and after: identical height in both the linked and the
  split state.

  The curve is deliberately *not* the video one. Stills are toned blind, and
  that is a constraint rather than a preference: drawing a cross-origin image
  into a canvas taints it, most pictures on a page are served from a CDN without
  CORS headers, and the extension has no host permissions and fetches nothing,
  so their pixels cannot be read at all. Measuring only the minority that can be
  read would tone two photographs sitting side by side differently depending on
  which host happened to serve them — a worse artefact than treating both the
  same.

  So the image curve is the half of the tone map that is safe without knowing
  what it is looking at: a fixed exposure reduction (half way from unity to the
  exposure servo's floor, so it still scales with the slider) plus the highlight
  shoulder, with the shadow lift and its gamma held at zero. The lift is the
  part that must not run blind — it brightens everything below the knee, so on a
  page of photographs it would *increase* the light coming off the screen, which
  is the opposite of the point. The shoulder has no such failure mode: it only
  darkens, and only above the knee, so on a dark picture it does nothing at all.
  The property is pinned by test rather than by argument: no input level, at any
  strength, may come out brighter than it went in — in the unit suite, and again
  on the LUT the smoke test reads out of real Chrome (black 0.000, white 0.810
  at the default strength).

  There is no element discovery either, and that is what keeps it cheap: the
  rule is a bare `img` selector rather than a marked attribute, so pictures added
  by infinite scroll, lazy loading or an SPA route change are covered by the CSS
  engine with no MutationObserver, no per-element bookkeeping and no layout
  reads. A 2 s timer does the same upkeep the video engine does, and switching
  the toggle off removes the stylesheet and the filter definition entirely.

  Two consequences worth knowing, both in the README's limitations: the rule is
  `!important`, so a site that dims or greys its own pictures in CSS has that
  overridden while the toggle is on; and only `<img>` is covered — CSS
  `background-image`, SVG artwork and canvas drawings have no element to attach
  a filter to without restyling the page's own boxes.

### Fixed

- **Dark mode's white flash is shorter.** The page engine could only measure a
  site's background once `<body>` existed, and until now the first attempt to
  find that out was `DOMContentLoaded` — which waits for the *whole* document
  to finish parsing, not just the part that decides the canvas colour. On a
  page with a lot of markup below the fold, that gap was long enough to see: the
  polite `color-scheme: dark` request went in at `document_start`, then nothing
  happened until parsing caught up. A `MutationObserver` now fires the
  measurement the instant `<body>` is inserted, which on most pages lands at or
  before first paint, because a render-blocking stylesheet in `<head>` — the
  thing that actually sets the background — has already run by then. Pages
  whose colour genuinely arrives later (an async stylesheet, a theme switcher)
  still fall through to the `DOMContentLoaded`/upkeep-loop correction, same as
  before.

- **Dark-mode content is no longer brightened.** A screencast of a dark-mode
  editor is half flat dark background, so its encoded mean reads as a night
  scene — but the light arrives through the text, and the frame is already
  emitting 0.33 against a comfort budget of 0.36. The shadow lift engaged
  anyway, at 0.62 of full strength, and bought nothing for it: there is no
  detail in a flat fill to open up, so the entire effect was the background
  going from 30/255 to 46/255 at the default strength and 75/255 at the top of
  the slider, and the frame leaving 19% brighter than it arrived. A night
  extension that makes the screen brighter has inverted its one job.

  The cause was the veto band, which sat *above* the budget rather than below
  it: the lift ran at full strength on a frame already delivering its budget and
  did not release until the frame was a quarter over. It is now measured against
  `COMFORT_LIGHT` — the same budget the exposure servo steers to, and the mirror
  of the `brightNeed` gate — so the lift is allowed in proportion to the room
  the frame has left, and a frame with none gets none. The two hand-tuned
  constants it replaces are gone.

  Turning up contrast instead was the obvious alternative and is the wrong
  trade: measured on the same frame, `contrast(1.3)` restores the black level
  but pushes peak white from 0.773 to 0.854 — above the *source's* 0.804, and
  through both the stated white point and the new ceiling — while emitted light
  barely moves. It swaps the wash for glare. The wash was the lift; not lifting
  is the contrast.

  Scenes that were not the bug are untouched **to the bit**: the tone curve for
  a night scene, a very dark night scene, the dashcam clip, a normal scene and a
  daylight scene is identical entry for entry, at every strength. The
  dark-mode background now moves by at most 7 codes across the whole slider.
  Two scenes do change beyond the reported one, both correctly — a night scene
  with a street lamp in it and a dim interior, each already at or over budget,
  now keep their blacks instead of being partly opened.

- **A cut out of a dark scene no longer flashes you before the curve responds.**
  Every correction in the tone curve was reactive — it looked at a frame and
  answered it — and reaction is the wrong shape for a cut, because the bright
  frame is on screen before anything has measured it. Detection costs a frame at
  best, `frameStride` frames once the sampler has backed off on 4K content, and a
  cut that only partly registers as one earns only partial snap credit, so there
  was no worst case at all. Measured at the default strength: a settled night
  scene sat at a white point of 0.93 while the daylight scene it cut to settled
  at 0.71, and for however long detection took, that gap was the flash.

  The fix is a **white-point ceiling**: a standing cap on the curve's output,
  armed *before* the cut rather than in response to it. Nothing reacts, so
  nothing is late. Peak output across a cut is now monotonically non-increasing
  regardless of whether the cut was detected, how much snap credit it earned, or
  how many frames the sampler skipped — pinned by a test that walks the stride-8
  worst case frame by frame.

  Three things make it not the washed-out regression this project already fixed
  once:

  - **It is set to the bright-scene white point**, not to a tuned constant. That
    is the brightest output the extension already holds sustained content to, so
    a cut is simply not allowed to exceed what a blazing daylight frame is given
    once the servo has finished with it. There is nothing left to tune, and it
    scales with the slider for free: 18% less emitted light on an unmeasured
    white frame at strength 25, 43% at 45, 60% at 60, 79% at 100.
  - **It is gated on how dark-adapted the viewer is**, not on the current frame.
    A normally exposed scene arms it not at all and gets a bit-for-bit unchanged
    curve. A dark scene arms it fully, which costs that scene almost nothing —
    a night frame has very few pixels above the knee, and the ones it has are
    lamps and speculars, which is exactly the light worth holding down.
  - **It spends the whole correction above the knee.** Lowering exposure or
    raising the shoulder instead would have reached into the mid-tones. The knee
    is re-solved against the lower white point, so everything below it is
    untouched and the shoulder stays C1-continuous.

  The arming level is the one piece of state deliberately *exempt* from the cut
  snap. A cut out of a night scene is precisely the moment the incoming frame
  stops reading as dark, so snapping would release the ceiling on the very frame
  it exists to cover. It eases in over 2.5 s and out over 5 s instead, which
  makes the protection a property of where the viewer has been rather than of
  what just arrived. The slow release costs nothing on genuinely bright content
  (the exposure servo puts the white point below the ceiling within about a
  second, so the cap stops binding long before it lifts) and was measured not to
  pump on the case that could have: leaving a dark scene for a normal one moves
  the curve by at most 9.5 8-bit levels per frame, against 9.4 with the ceiling
  pinned off — 0.1 levels attributable to the ceiling, all of it in the first
  half second where the exposure and lift easing already dominates.

  Two knock-on changes, both narrowing what was asserted to what is actually
  guaranteed:

  - `adaptBounds()`' two ends now meet at the top, since the dark bound carries
    the ceiling armed and the ceiling *is* the bright bound's white. The popup's
    shaded band is a band in the shadows and a single point at the white end,
    which is the guarantee drawn rather than described. The caption is unchanged:
    it already quoted the bright bound.
  - The slope-allocation bound is now asserted in its scale-invariant form. A
    histogram concentrated enough to pin every interval against a bound — which
    an armed ceiling makes more likely, by flattening the top of the range —
    leaves the bounded allocation unable to sum to the curve's stated range, and
    `redistribute()` closes the gap by scaling all of them uniformly. That is the
    documented trade (the endpoint wins over the bounds) and it moves the
    individual ratios by a common factor while leaving the spread between them
    exactly where the bounds put it, so the spread is what the test now checks.

- **The tone curve now reaches the compositor on every presented frame.** Two
  independent frame-droppers meant the LUT often updated at a fraction of the
  video's rate, which reads as judder regardless of how good the adaptation
  behind it is — a stale curve is a stale curve. Measured on the smoke clip:
  30.3 LUT updates/s against 30.3 fps, median gap 33.3 ms against 33.3 ms per
  frame. Main-thread cost is unchanged at 1.9–2.3% of one core.

  - The 30 ms minimum gap between LUT writes is gone (now a 5 ms backstop that
    cannot bite below 200 Hz). It was invisible at 30 fps, where frames arrive
    33.3 ms apart, and dropped every other frame at 60 fps, where they arrive
    16.7 ms apart — so the curve was one frame stale half the time on exactly
    the content most likely to show it. Confirmed by scaling the throttle to
    60 ms on the 30 fps clip: updates halved to 15.4 Hz with gaps of exactly two
    frame intervals. `requestVideoFrameCallback` already caps writes at one per
    presented frame, and `ToneFilter.setCurve` already skips unchanged tables,
    so the throttle was only ever able to remove useful updates.

  - The frame-skip budget is now a duty cycle (cost per presented frame) rather
    than the raw per-sample cost. Skipping frames does not make an individual
    read-back cheaper, so the old test had no fixed point: one sample over the
    line ratcheted the stride 1 → 2 → 4 → 8 and nothing could bring it back,
    because the number being tested never changed. Any read-back above 1.2 ms —
    ordinary for a 4K source — therefore pinned the analysis at ⅛ rate, 7.5 Hz
    on 60 fps content, where a 2.4 ms read-back should skip one frame in two.
    Confirmed by dropping the budget below the measured cost: gaps of exactly
    eight frame intervals, with no recovery over four seconds.

    The hysteresis band is `(budget/2, budget]`. Half-open matters: with both
    ends open, a cost landing on a boundary is stable at two strides at once, so
    the settled rate depends on the order it got there and a video can sit a
    step coarser than it needs to indefinitely. The decision is extracted as a
    pure `nextFrameStride` and unit-tested, because in a browser its only
    observable is the update rate and `performance.now()` is clamped to 100 µs
    without cross-origin isolation — for a cheap read-back the measured cost is
    mostly quantisation noise.

- **Skipping a frame now skips the measurement, not the curve update.** The
  adaptation state only advanced on frames the engine chose to *analyse*, so
  whenever a read-back was too expensive to run every frame, the curve was also
  only rewritten every `stride`-th frame — delivering a smooth ramp as a
  staircase at `fps / stride`. Measured in Chrome with the stride pinned to 4:
  7.8 LUT updates/s against 30.2 fps, each one moving the curve 3.4 8-bit levels
  (95th percentile), which is plainly visible on any flat area.

  Deciding where the curve should head needs pixels and is the expensive half;
  moving it there is a few `exp` calls. They are now separate functions —
  `updateAdaptState` re-aims the targets, `advanceAdaptState` integrates towards
  them — and every presented frame runs the second one. At stride 4 the largest
  smooth update is now 1.45 8-bit levels at 29.9 updates/s: the same figures as
  at stride 1, so the analysis rate no longer costs anything in smoothness. It
  still costs detection latency, which is what it was always meant to trade.

  The rate gates that detect cuts and flashes now take the interval since the
  last *analysed* frame rather than since the last update. Dividing a
  four-frame change by one frame would read an ordinary pan as four times as
  fast as it is and snap on it.

- `npm run smoke` gained two checks: LUT writes keeping pace with presented
  frames, and no single update moving the curve far enough to read as a step
  (cut snaps excluded — those are meant to arrive whole, and are masked by the
  cut itself). Between them they cover the observable all three of the above
  govern and none was covered by.

### Changed

- **The popup opens on three controls instead of fifteen.** Panels were the
  right grouping and the wrong altitude: every switch, both graphs, both
  captions and the per-tab report were on screen at once the moment you clicked
  the icon, and a control you touch twice a year was competing for attention
  with the slider you came in for.

  What the popup opens on now is what you would reach for while watching
  something: the master switch, a switch and a slider for **Sound**, the same
  for **Picture**, the night window, and one sentence saying what is happening
  on this tab — *Softening the sound and picture*, *Waiting for 09:00 PM*,
  *Paused*. Everything else moved behind **More options**, grouped by the panel
  it belongs to, and nothing was removed: the graphs and their decibel captions,
  Night EQ, the music exemption, the Video/Images split, dark mode, the two
  detailed status lines, the per-site skip, the shortcut hint and reset are all
  one click down. The disclosure remembers whether you left it open, in
  `localStorage` rather than in settings — it describes this popup on this
  machine, not how anything is processed.

  **Picture gained a front switch standing for both halves of its path.** Off
  means both off; on means both on, rather than whichever pair happened to be
  set last, because one switch producing two different results from the same
  visible state is worse than the granularity it would buy. Turning one half off
  downstairs leaves the front switch on, since the other half is still running.

  **The strength readout is the word, not the number.** "45 · balanced" asked
  the reader to translate twice — digit to word, word to consequence — and only
  the second translation was ever useful. The digit is still on the slider and
  in what a screen reader announces.

  The height budget stopped being tight as a result: the state the popup opens
  at is 472 px against Chrome's 600 px cap, from 591 px, and the per-site button
  and dark mode's readout no longer move that number at all. Expanded it runs to
  966 px and scrolls, which is the consequence of a deliberate click rather than
  the state you are handed. `popup-shot.mjs` now reports both, and `MORE=1`
  screenshots the expanded state.

- **The popup is reorganised into panels, one per thing being treated.** It had
  grown into a strength card followed by one flat list of six switches, in which
  **Images** and **Dark mode** sat two and three rows below **Audio** and read
  as though they belonged to it. They never did.

  There are now two panels, **Sound** and **Picture**, and everything that
  belongs to one lives inside it: its strength slider, the graph of what that
  slider does, and its own switches. Sound holds Night EQ and the music
  exemption — both sound-only, which is why compressing a music video was never
  what "leave music alone" meant. Picture holds Video, Images and Dark mode.
  Sound's panel heading carries the group's master switch, because with it off
  nothing else in that panel can do anything; Picture's does not, because moving
  pictures and stills are genuinely separate switches and there is no single
  thing for one there to mean.

  `Settings` is grouped the same way, in the same order, for the same reason: a
  setting whose neighbours in the type are not its neighbours on screen is one
  that gets filed in the wrong place twice.

- **One strength slider per panel; the link toggle is gone.** The old model was
  one slider with a "set audio and video separately" button that split it into
  two. With each panel owning a slider that distinction has nothing left to
  express, so `strength` and `linked` are gone from storage: what you were
  running at carries over to both sliders, and an install that had already
  separated them keeps both values.

  Two sliders always visible is also what let the graphs move beside their
  captions rather than above them, which is where the height came from. The
  worst-case popup is 591 px against Chrome's 600 px cap, from 639 px — the old
  split state was 39 px over and had been scrolling quietly.

  Dragging both sliders inside the write debounce used to persist only the
  second one; patches now accumulate.

- **The tone curve now snaps at a scene change instead of easing into it.** The
  measurement was never the slow part — frames are analysed on
  `requestVideoFrameCallback`, one frame after presentation — but the adaptation
  then eased onto the new scene with time constants of 0.3 s (dimming), 0.8 s
  (highlight shoulder), 1.2 s (shadow lift), 1.6 s (recovery) and 0.5 s
  (histogram). Two tenths of a second after a cut, the exposure servo was under
  halfway there and the shadow lift about 15% of the way, which is what the lag
  was: the new scene arrived and the correction visibly followed it in.

  Easing exists to hide a correction inside content that is already moving. A
  cut both masks anything changed on the same frame and leaves nothing to hide a
  slow correction in, so it is the one moment where easing is all cost. The
  state is now eased and snapped in the same expression, blended by a 0..1 `cut`
  amount, and the resulting curve bypasses the LUT push throttle. The first
  analysed frame is a full cut by definition, which is where the old first-frame
  special case went.

- **Cut detection is the earth-mover distance between successive frame
  histograms**, which the measurement already produces, so it costs 64 adds per
  analysed frame — nothing next to the 48×27 read-back that produced them.
  Measured cost is unchanged: 0.011 ms per sample, 2.6–2.9% of one core over a
  5 s window, both before and after.

  Distance travelled rather than bin-by-bin difference, because a low-contrast
  frame keeps nearly all of its mass in one bin and a slow dissolve relocates
  all of it on every bin crossing — a difference metric reads that as "the whole
  frame changed" and snaps repeatedly through a two-second fade. The gates
  mirror the flash guard's: a magnitude floor (0.08–0.22 luma) and a rate gate
  (1.5–4.0 luma/s), both smoothstepped, so the behaviour does not depend on
  whether we are sampling at 60 Hz or on the 8 Hz timer fallback. Frames without
  a histogram fall back to |Δmean|, a strict lower bound on the transport
  distance, so that path can only under-detect a cut and never invent one.

- **The flash guard is scaled back on a cut by however much the snap actually
  covered**, rather than by the bare presence of one. It had been doing two jobs
  — covering the exposure servo's lag and blunting the transient — and snapping
  only does the first, so stacking the whole guard on an already-correct
  exposure over-dims. But on content already pinned at `minExposure` the servo
  has no room to move, the snap contributes nothing, and the guard is the only
  transient protection there is. Damping on the cut alone measured the white
  flash at 0.533 → 0.639, weakening the response in exactly the case the guard
  exists for; scaling by the servo's actual contribution holds it at 0.533.

  Measured on the animated smoke clip, the largest single-step white-point drop
  over one scene cycle goes 0.2022 → 0.2863, and the controlled white flash is
  unchanged at 0.714 → 0.533.

### Removed

- **Page colour.** It pulled the whole document towards grey on a `saturate()`
  riding the picture slider. Dark mode already does what it was for, more
  thoroughly, and a desaturated-but-still-white page is neither the site's
  design nor a comfort win worth a permanent switch in a popup with a 600 px
  height budget. Stored settings carrying `pageColor` drop it on the next write.
  `pageDark` is now `darkMode`, migrated in place.

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
