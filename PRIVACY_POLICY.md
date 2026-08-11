# Night Neutralizer Privacy Policy

Effective: July 28, 2026

Night Neutralizer softens harsh video, images and audio for night-time viewing. It runs entirely inside your browser. It has no server, no account, no analytics and no payment processor, and it makes no network requests of any kind.

## What is stored, and where

Your settings live in `chrome.storage.sync`, falling back to `chrome.storage.local` when sync is unavailable:

- whether the extension is on, and the strength values for audio and video
- whether audio processing, video processing, still-image processing and night EQ are enabled
- the night window (start and end minutes) and whether processing is limited to it
- whether music is left alone
- **the list of hostnames you have excluded**, capped at 200 entries

Worth being plain about the last one: because settings use `chrome.storage.sync`, that exclusion list is synchronised through your Google account like any other Chrome setting, if you have Chrome Sync switched on. It is a list of bare hostnames you chose to add. Nothing else about your browsing is recorded. If you would rather it did not sync, turn off extension syncing in Chrome's settings.

Separately, `chrome.storage.session` holds a short-lived status record per tab so the popup and the toolbar badge can describe what is happening: the normalised hostname of the top-level page, how many media elements were found, whether processing is active and why not when it is not, and the last ambient light reading. `chrome.storage.session` is memory-only — it is never written to disk and it is discarded when the tab closes or Chrome exits. It holds a hostname, never a URL, a page title, a query string or a history.

## Why it runs on every page

The extension declares a content script on `http://*/*` and `https://*/*`, in all frames. Video is embedded from everywhere, so the extension has to already be present wherever a `<video>` or `<audio>` element might appear. Being present is the whole of what it does with that access: it looks for media elements and attaches an SVG filter and a Web Audio graph to them.

To choose a tone curve it draws the current video frame into a 48×27 offscreen canvas and reads the pixels back. Those measurements exist for the length of one frame, are reduced to a handful of numbers, and are then discarded. They never leave the tab. On DRM-protected video, where frames cannot be read at all, the extension applies a fixed curve instead.

## Ambient light

If you have enabled `chrome://flags/#enable-generic-sensor-extra-classes` and your device has a light sensor, Night Neutralizer reads `AmbientLightSensor` in the top-level frame at one sample per second and uses the illuminance to decide whether the room is dark. On a stock Chrome install the API is not exposed, and the extension falls back to the clock.

The reading is a single number in lux. It is used to make one decision and shown in the popup so you can see what the extension is reacting to. It is not stored beyond the session record described above, and it is not sent anywhere.

## No network activity

Night Neutralizer declares no host permissions for network access, contacts no analytics service, has no remote configuration, and loads no remote code. You can check this rather than take it on trust: the extension's whole source is in this repository, and searching it for `fetch`, `XMLHttpRequest`, `sendBeacon` or `WebSocket` turns up nothing.

## Retention and deletion

Settings stay until you change them or uninstall the extension. Session status is gone when the tab or the browser closes. Uninstalling removes everything; clearing the exclusion list in the popup removes it immediately.

## Limited Use

Night Neutralizer's use of information received from Chrome APIs complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. That is a low bar to clear here, because no user data is transferred off the device at all.

## Changes

Material changes to this policy will be disclosed before they take effect, and the effective date above will be updated.

## Contact

Questions or privacy concerns: **xiangli3625@gmail.com**.
