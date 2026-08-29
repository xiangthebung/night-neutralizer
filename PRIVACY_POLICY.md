# Night Neutralizer Privacy Policy

Effective: August 29, 2026

Night Neutralizer softens harsh video, images and audio for night-time viewing. It runs entirely inside your browser. It has no server, no account, no analytics and no payment processor, and it makes no network requests of any kind.

## What is stored, and where

Your settings live in `chrome.storage.sync`, falling back to `chrome.storage.local` when sync is unavailable. That is the whole of what reaches disk, and this is the whole list:

- whether the extension is on, and the strength values for audio and video
- whether audio processing, video processing, still-image processing and night EQ are enabled
- whether music is left alone
- whether the page itself is darkened behind the media
- the night window (start and end minutes) and whether processing is limited to it
- **the list of hostnames you have excluded**, capped at 200 entries

Worth being plain about the last one: because settings use `chrome.storage.sync`, that exclusion list is synchronised through your Google account like any other Chrome setting, if you have Chrome Sync switched on. It is a list of bare hostnames you chose to add. Nothing else about your browsing is recorded. If you would rather it did not sync, turn off extension syncing in Chrome's settings.

Separately, `chrome.storage.session` holds a short-lived status record for each frame of each open tab, so the popup and the toolbar badge can describe what is happening. Each record holds the normalised hostname of the top-level page, how many media elements were found, how many are being compressed or were left alone, which tone-mapping mode the picture path is in, how many pictures the image curve is on, whether the page treatment is asking or inverting, whether processing is active and why not when it is not, any explanatory notes the popup shows you, the last ambient light reading, and a copy of the settings above so the badge can be painted without a second read. `chrome.storage.session` is memory-only — it is never written to disk, the record for a tab is deleted when that tab closes, and the whole area is discarded when Chrome exits. It holds a hostname, never a URL, a page title, a query string or a history.

## Why it runs on every page

The extension declares a content script on `http://*/*` and `https://*/*`, in all frames. Video is embedded from everywhere, so the extension has to already be present wherever a `<video>` or `<audio>` element might appear. Being present is close to the whole of what it does with that access: it finds media elements, attaches a Web Audio graph to them, and installs CSS rules that point `<video>` and `<img>` at an SVG filter it defines. With **dark mode** switched on — off by default — it also sets `color-scheme: dark` on the page and, on pages that stay light anyway, adds a filter that inverts them.

To choose a tone curve it draws the current video frame into a 48×27 offscreen canvas and reads the pixels back. Those measurements exist for the length of one frame, are reduced to a handful of numbers, and are then discarded. They never leave the tab. On DRM-protected video, where frames cannot be read at all, the extension applies a fixed curve instead.

Still images are never read at all. Most pictures on a page come from another origin, which makes their pixels unreadable in any case, so every `<img>` gets the same fixed curve without being measured.

The only other thing read from a page is for dark mode, and only while it is switched on: the computed background colour of the root element and of `<body>`, which answers whether the site already has a dark presentation of its own. Two colours, turned into one number, kept only long enough to decide between asking and inverting. No text, markup, form field, cookie or URL is read anywhere in the extension.

## Ambient light

If you have enabled `chrome://flags/#enable-generic-sensor-extra-classes` and your device has a light sensor, Night Neutralizer reads `AmbientLightSensor` in the top-level frame at one sample per second and uses the illuminance to decide whether the room is dark. On a stock Chrome install the API is not exposed, and the extension falls back to the clock.

The reading is a single number in lux. It is used to make one decision and shown in the popup so you can see what the extension is reacting to. It is not stored beyond the session record described above, and it is not sent anywhere.

## No network activity

Night Neutralizer declares no host permissions for network access, contacts no analytics service, has no remote configuration, and loads no remote code. You can check this rather than take it on trust: the extension's whole source is in this repository, and searching it for `fetch`, `XMLHttpRequest`, `sendBeacon` or `WebSocket` turns up nothing.

## Retention and deletion

Settings stay until you change them or uninstall the extension. Session status is gone when the tab or the browser closes. Uninstalling removes everything. The exclusion list is the only stored item that names anything you visited, and you can empty it at once from the popup: **More options → This tab → Clear**, next to the count of skipped sites. **Reset to defaults**, below it, clears every setting including that list.

## Limited Use

Night Neutralizer's use of information received from Chrome APIs complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. That is a low bar to clear here, because no user data is transferred off the device at all.

## Changes

Material changes to this policy will be disclosed before they take effect, and the effective date above will be updated.

## Contact

Questions or privacy concerns: **xiangli3625@gmail.com**.
