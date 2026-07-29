/**
 * Telling music apart from film and television.
 *
 * Why it matters: dynamic range compression is a fix for a specific problem —
 * dialogue mixed 30 dB below the explosions — and it is the opposite of what you
 * want on a record, where the range *is* the performance. So the audio half of
 * this extension should stay out of the way when what is playing is music.
 *
 * There is no reliable metadata for this, so two signals are combined, both
 * cheap and both wrong occasionally:
 *
 *  1. The host. A frame served by a music service is playing music, whether it
 *     is the page you are looking at or a player embedded in someone's blog.
 *  2. The element. Audio-only playback — an `<audio>` element, or a `<video>`
 *     whose stream carries no picture — is not a film. This also catches music
 *     services that are not on the list, and short interface sounds, which are
 *     no loss.
 *
 * Both are deliberately conservative in the same direction: they suppress
 * processing rather than apply it. Getting it wrong means audio is left exactly
 * as the site sent it, which is the pre-extension status quo, and the toggle in
 * the popup turns the whole heuristic off.
 *
 * Video is not affected. Tone mapping a music video at 1 a.m. is still worth
 * doing; it has nothing to do with what you are listening to.
 */
import { hostCovers } from './site';

/**
 * Known music services, normalised the same way `core/site.ts` normalises
 * hostnames (lower case, no `www.`). Each entry also covers its subdomains.
 *
 * Kept to services whose whole purpose is music, so no entry can accidentally
 * cover a general video host: `music.youtube.com` is listed, `youtube.com` is
 * not, and matching one does not match the other.
 */
export const MUSIC_HOSTS: readonly string[] = Object.freeze([
  'open.spotify.com',
  'soundcloud.com',
  'bandcamp.com',
  'deezer.com',
  'tidal.com',
  'mixcloud.com',
  'audiomack.com',
  'pandora.com',
  'last.fm',
  'qobuz.com',
  'napster.com',
  'jamendo.com',
  'beatport.com',
  'idagio.com',
  'primephonic.com',
  'nts.live',
  'radio.garden',
  'accuradio.com',
  'di.fm',
  'bandlab.com',
]);

/**
 * `music.*` as a host prefix.
 *
 * Every large platform that runs a separate music product puts it on this
 * subdomain — `music.youtube.com`, `music.apple.com`, `music.amazon.co.uk`,
 * `music.yandex.ru` — so one rule covers them all, including the regional
 * variants that would otherwise need an entry per country.
 */
const MUSIC_SUBDOMAIN = 'music.';

/** True when any of a frame's site keys belongs to a music service. */
export function isMusicHost(keys: readonly string[]): boolean {
  return keys.some(
    (key) =>
      key.startsWith(MUSIC_SUBDOMAIN) || MUSIC_HOSTS.some((host) => hostCovers(host, key)),
  );
}

/**
 * The part of a media element this module reads. A plain object rather than
 * `HTMLMediaElement` so the classification can be tested without a DOM.
 */
export interface MediaShape {
  tagName: string;
  /** `HTMLMediaElement.readyState`. */
  readyState: number;
  videoWidth?: number;
  videoHeight?: number;
}

export type MediaKind =
  /** Carries a picture. */
  | 'video'
  /** No picture: an `<audio>` element, or a video stream with no video track. */
  | 'audio-only'
  /** Not enough loaded yet to say. */
  | 'unknown';

export function classifyMedia(media: MediaShape): MediaKind {
  const tag = (media.tagName || '').toUpperCase();
  if (tag === 'AUDIO') return 'audio-only';
  if (tag !== 'VIDEO') return 'unknown';
  // Dimensions are meaningless before metadata arrives: every <video> starts at
  // 0x0, so trusting them early would classify all video as audio.
  if (!(media.readyState >= 1)) return 'unknown';
  return media.videoWidth && media.videoHeight ? 'video' : 'audio-only';
}

/**
 * Should this element's audio be left alone?
 *
 * `musicSite` comes from `isMusicHost()` for the frame. On a music service every
 * element counts, including a music video with a picture; elsewhere only
 * audio-only playback does. An element that has not loaded metadata yet is not
 * assumed to be music unless the host already says so, so a film does not get a
 * moment of uncompressed audio while it starts up.
 */
export function isMusicMedia(media: MediaShape, musicSite: boolean): boolean {
  if (musicSite) return true;
  return classifyMedia(media) === 'audio-only';
}
