# Chrome Web Store listing copy

## Name

Night Neutralizer

Version 1.0.0. Name, version and the short description below are taken verbatim from `src/manifest.json`; the short description is 119 characters, inside the store's 132 limit. `tests/docs.test.ts` holds all four of those to the manifest, so this paragraph cannot go stale quietly.

## Summary

Softens harsh video, images and audio at night: adaptive tone mapping plus audio dynamic-range compression. 100% local.

## Category

Accessibility. Well-being is the reasonable alternative if the dashboard's list differs — the extension is about eye and ear comfort, not media playback features.

## Single purpose

Night Neutralizer reduces the dynamic range of the video, still images and audio in a tab — lifting shadow detail, rolling highlights off, and bringing quiet dialogue up towards loud effects, and optionally darkening the page around them — so that using a screen in a dark room does not require a bright screen or a loud volume.

## Detailed description

Watching something at midnight means choosing between a screen bright enough to see the dark scenes and a screen dim enough not to hurt, and between a volume high enough to hear the dialogue and one low enough not to wake the house. Night Neutralizer removes the choice by compressing the range instead of turning everything up.

Night Neutralizer includes:

- Video tone mapping: a per-pixel transfer function that lifts shadows, rolls highlights off before they clip, and compensates the resulting desaturation. It is applied by the compositor through an SVG filter, so it costs no per-frame JavaScript and nothing is inserted between the site and its `<video>` — player controls, native captions, aspect ratio and fullscreen keep working.
- Scene adaptation: the current frame is measured, at 48×27 pixels, once per presented frame — in linear light, so what is measured is the light actually coming off the screen rather than how dark the frame happens to look. Dark scenes get opened up; anything above a comfortable light level is dimmed by exactly the amount that brings it back down, with its blacks left at black and its contrast redistributed towards the levels the scene actually occupies rather than shaved off the top; a scene already below that level passes through untouched; and a sudden rise in brightness dips exposure and pulls the white point down before decaying back.
- Still images: the same compositor path over `<img>`, with one fixed curve — exposure down a little and highlights rolled off, blacks left exactly where they are. Pictures are usually served from another origin, which means their pixels cannot be read at all, so the curve is deliberately built so that never knowing what a picture contains can only ever leave it slightly darker rather than washed out. A toggle of its own, on by default.
- Audio dynamic-range compression per media element: compressor, make-up gain, limiter and an instantaneous safety clipper, arranged so that peaks stay below full scale even when a full-scale burst lands straight after a quiet passage. The site's own volume slider, mute button and keyboard shortcuts keep working, because they act before the graph does.
- One strength slider each for sound and picture, 0 to 100, default 45. They are separate numbers because "compress the soundtrack hard but barely touch the picture" is an ordinary thing to want. 0 is a real bypass, not a small effect.
- Dark mode for the page behind the media, off by default. It asks the site for its own dark presentation first and only inverts the pages that stay light, which is most of them; the popup says which of the two happened. Media is counter-inverted exactly, so a photograph on an inverted page is not a negative.
- Two live graphs of the actual curves, with a caption under each stating the change in numbers — at the default, "dark scenes 2.9× brighter / whites 28% softer" and "quiet parts +9 dB / loud-to-quiet gap −9 dB". They are drawn from the same functions the engines run, so the panel cannot describe an effect the extension is not applying.
- Only at night, on by default. If the browser exposes an ambient light sensor the room decides; otherwise a clock window does, 21:00 to 07:00 by default, and the popup says which of the two is in charge.
- Night EQ, off by default: takes the low end down and lifts dialogue presence, because bass is what travels through walls.
- Leave music alone, on by default. Dynamic range is the point of a record and a nuisance in a film, so audio-only playback and known music services keep their dynamics. Video is still tone mapped.
- Skip this site, one click, by hostname — subdomains and embedded players from that host included. The list is capped at 200 hostnames and shown with a count and a Clear button, so a full list is something you are told about rather than something that silently ignores the click.
- `Alt+Shift+N` toggles the whole extension without opening the popup, remappable at `chrome://extensions/shortcuts`. The toolbar badge reads `off`, `site` or `day` so that "deliberately doing nothing" and "broken" do not look the same.
- A status block that says what is actually happening in the tab: how many players are being compressed, whether video is running scene analysis or a fixed night curve, how many pictures the image curve is on, and — when dark mode is on — whether the page answered the polite request or is being inverted.

Free. There is no paid tier, no account, no trial and no payment processor anywhere in the source.

No network requests of any kind. The extension declares no host permissions for network access, loads no remote code, and contains no `fetch`, `XMLHttpRequest`, `sendBeacon` or `WebSocket` call — searching the source for them returns nothing. Nothing about your browsing is recorded or transmitted.

Changes apply to open tabs immediately, with no reload. Requires Chrome 111 or later, on Chrome or another Chromium-based browser.

Some things cannot be done, and are not attempted. Protected (DRM) video cannot be read back, so it gets a fixed night curve rather than scene adaptation, and on systems that decode it into a protected hardware overlay you may see no change at all. Picture-in-Picture and cast output render on a separate surface. Players that paint into a `<canvas>` instead of a `<video>` are invisible to the video half. Cross-origin audio served without CORS cannot be processed, and the extension detects that, hands playback straight back to the element, and says so. `chrome://` pages, the Web Store and other extensions cannot be modified by any extension.

## Permission justifications

- **storage** (the only entry in `permissions`): stores your settings in `chrome.storage.sync`, falling back to `chrome.storage.local` — `src/core/settings.ts`, read by the popup and by every content script through `chrome.storage.onChanged`. It also backs two memory-only uses of `chrome.storage.session`: the per-tab status record the popup and the toolbar badge display (`src/background/service-worker.ts`, `src/content/status-reporter.ts`) and the single shared ambient light reading that lets one frame's sensor answer for every frame in every tab (`src/core/ambient.ts`). The service worker widens that area's access level to `TRUSTED_AND_UNTRUSTED_CONTEXTS` for the same reason (`openSessionToContentScripts`), which is what avoids broadcasting messages across your tabs.
- **Content script access to `http://*/*` and `https://*/*`, in all frames**: declared under `content_scripts`, not as `host_permissions`. A video can be on any page and, just as often, inside an iframe from another origin, so the extension has to already be present wherever a `<video>` or `<audio>` element might appear — `src/content/index.ts` and `src/content/media-registry.ts`. Being present is the whole of what it does with that access: find media elements, attach an SVG filter and a Web Audio graph, measure the frame it is already displaying. It fetches nothing from those hosts, reads no page text, forms and cookies, and derives exactly one thing from the URL — the bare hostname, so the popup can offer "skip this site" (`src/core/site.ts`).
- **`commands`** — not a permission and shows no install warning. Registers the `Alt+Shift+N` toggle, handled in `src/background/service-worker.ts` (`chrome.commands.onCommand`) and read back by the popup with `chrome.commands.getAll()` so the hint shows whatever the key is actually bound to.
- **`action`** — not a permission. Used for badge text, the dimmed "off" icon and the tooltip, in `src/background/service-worker.ts` (`paintAction`, `paintTab`).

Every declared permission is used, so there is nothing here to remove before submitting. For completeness, the following are deliberately **not** declared and not needed: `tabs`, `activeTab`, `scripting`, `webRequest`, `unlimitedStorage`, `cookies`, `notifications`, `alarms`, and any `host_permissions`. Three `chrome.tabs` calls do appear in the source — `tabs.query` for tab ids in the popup and the service worker, `tabs.sendMessage` to the extension's own content script, and `tabs.create` to open `chrome://extensions/shortcuts` — and all three work without the `tabs` permission, which withholds urls and titles. Each is wrapped so that a refusal degrades to the last pushed status rather than an error.

## Published policy URLs

Paste these into the Developer Dashboard. They are live now — check them before
you submit rather than after, because a reviewer following a dead privacy link is
a rejection, and this collection has already shipped one extension whose in-product
legal links pointed at a host that did not exist.

```
Privacy policy   https://personal-website.xiangli3625.workers.dev/legal/night-neutralizer/privacy
```

The copy in this repository is the original. The portfolio site keeps a vendored
copy and its test suite diffs the two, so edit the file here and re-copy — never
the published page on its own.

## Privacy disclosures for the Developer Dashboard

**Does this extension collect or use user data? No.** Nothing is transmitted off the device, to the developer or to anyone else. Leave every category unchecked:

- Personally identifiable information — no.
- Health information — no.
- Financial and payment information — no.
- Authentication information — no.
- Personal communications — no.
- Location — no. The ambient light reading is an illuminance value in lux, is used to answer one yes-or-no question, is never stored on disk and never leaves the browser.
- Web history — no. No URL, path, query string, page title or visit is recorded.
- User activity — no. No clicks, keystrokes or mouse movement are recorded.
- Website content — no. Two things are read from a page and neither is kept. To choose a tone curve the extension draws the frame the page is already showing into a 48×27 offscreen canvas, reduces it to four numbers, and discards it; the pixels are not stored, not transmitted and not exposed to the page. With dark mode switched on it also reads the computed background colour of the root element and of `<body>` through `getComputedStyle`, turns the pair into one luminance figure, and keeps only the verdict `scheme` or `invert`. No text, markup, form field, cookie or URL is read anywhere in the source.

Certify all three: the data is not sold or transferred to third parties outside approved use cases, is not used or transferred for any purpose unrelated to the item's single purpose, and is not used or transferred to determine creditworthiness or for lending purposes. Link the published `PRIVACY_POLICY.md` as the privacy policy URL.

Two nuances worth stating rather than being asked about. First, settings live in `chrome.storage.sync`, so if the user has Chrome Sync switched on, Chrome itself synchronises them through their Google account like any other browser setting — including the list of hostnames they chose to skip. That is Chrome's mechanism, not a developer server, and it is disclosed in the privacy policy. Second, a reviewer will see a broad content-script match and may ask why: the answer is the paragraph above, and it is worth pasting into the review notes along with the fact that the extension declares no `host_permissions` and makes no network requests.

## Required visual assets

All produced from `dist/` — the directory `npm run zip` packages — by `node scripts/store-shots.mjs`, which loads the built extension into a real Chromium and rejects its own output if any file is off by a pixel.

- Store icon: `dist/icons/icon-128.png` (generated at build time by `scripts/icons.mjs`).
- Screenshots, all exactly 1280×800:
  - `store-assets/01-tone-1280x800.png` — a page with the effect applied, popup open, reporting what it is doing.
  - `store-assets/02-picture-1280x800.png` — the same frame with video processing off and on at the default strength.
  - `store-assets/03-panel-1280x800.png` — the panel at 1.7×: controls, both graphs, the night window, and a skipped site.
- Small promotional tile: `store-assets/promo-440x280.png`, exactly 440×280.

The page and the footage in the screenshots are invented and say so on the image. Nothing in them depicts, names or imitates a real service, and every pixel of extension interface in them was rendered by the shipped build.

## Claims to avoid

Everything below is something the code cannot support. Keeping it out of the listing is not modesty; each one is a refund request or a rejection waiting to happen.

- **Do not claim it fixes DRM video.** Encrypted media (Netflix, Prime Video, Disney+, Max and similar) cannot be read back, so it gets a fixed night curve, never scene adaptation. On systems that decode it into a protected hardware video overlay, CSS effects are bypassed entirely and the user may see no change at all. Say "a fixed night curve on protected video, where the system allows any filter at all", not "works everywhere".
- **Do not claim it prevents bright flashes.** The flash guard is reactive: it measures a frame that has already been shown, so the dim lands on the next one, roughly 16 ms later at 60 fps. It shortens a flash; it does not remove one. Frame lookahead is not available to an extension.
- **Do not claim Picture-in-Picture, casting or AirPlay output is processed.** Those render on a separate surface and get nothing.
- **Do not claim it works on every player.** A site that decodes into a `<canvas>` or a WebGL surface gets no video processing at all; the CSS rule targets `<video>` elements. The audio half still works.
- **Do not claim per-video or per-URL control.** Skipping is by hostname only, and the extension deliberately never sees the path. The list is capped at 200 hostnames; past that the popup says so rather than making room by deleting one of the user's entries.
- **Do not describe dark mode as a reading-mode or a theme.** It asks for `color-scheme: dark` and, failing that, inverts and squeezes the page. It cannot flip `prefers-color-scheme`, which is where most sites keep their real dark theme, so most pages take the inversion path — and inversion is a filter over whatever the site drew, not a redesign of it. It is off by default for that reason.
- **Do not claim it uses your room's light level.** Chrome keeps `AmbientLightSensor` behind `chrome://flags/#enable-generic-sensor-extra-classes` and most desktops have no sensor, so in practice the clock decides. Phrase it as "the room decides if your browser exposes a light sensor, otherwise the clock does" — which is what the popup itself says.
- **Do not claim all audio is compressed.** Cross-origin audio without CORS headers cannot be processed; the extension detects it and restores native playback. It runs at most four Web Audio graphs per frame — its own cap, chosen to stay well inside Chromium's limit on concurrent audio contexts — and reports extra players as skipped. Muted autoplay gets audio processing only after the first click or key press, per browser autoplay policy.
- **Do not claim music detection is accurate.** It is a heuristic over the host and the element. A podcast or audiobook in an `<audio>` element is treated as music and left uncompressed; a music service not on the list that ships a real video track is compressed like a film. The toggle exists because of that.
- **Do not claim zero added audio latency.** The chain adds a constant 12 ms, measured. It is constant, so lip sync holds — but it is not zero.
- **Do not claim each video gets its own curve.** Adaptation follows the largest visible playing video and the resulting curve is shared by every marked video in that document.
- **Do not claim it runs on `chrome://` pages, the Web Store, other extensions, or local files.** The content script matches `http` and `https` only, so `file://` URLs are not covered even with "Allow access to file URLs" enabled.
- **Do not claim Firefox or Safari support.** Chromium only; a Firefox build would need its own manifest key and `browser`-namespace handling, which has not been done.
- **Do not claim "nothing ever leaves your device" without qualification.** The extension transmits nothing, but `chrome.storage.sync` means Chrome's own sync carries the settings and the skip list between the user's signed-in Chrome installs. Say "no network requests, nothing sent to us", and let the policy cover sync.
- **Do not make health, medical or sleep claims.** No melatonin, eye-health, migraine, photosensitive-epilepsy or hearing-protection benefit is measured or implied anywhere in the code, and the flash guard in particular must not be described as a safety feature.
- **Do not describe the fixed curve as adaptive, or the graphs as measurements.** The popup reports `adaptive` only when frames are really being measured, and the audio graph is an analytical model of the chain that agrees with a real offline render to within 1.7 dB, in the conservative direction.
