import { describe, expect, it } from 'vitest';
import { MUSIC_HOSTS, classifyMedia, isMusicHost, isMusicMedia } from '../src/core/music';
import { normalizeSite, siteKeys } from '../src/core/site';

/** Media element stand-in; only the four properties the classifier reads. */
const media = (
  tagName: string,
  readyState = 1,
  videoWidth = 0,
  videoHeight = 0,
): { tagName: string; readyState: number; videoWidth: number; videoHeight: number } => ({
  tagName,
  readyState,
  videoWidth,
  videoHeight,
});

describe('isMusicHost', () => {
  it('recognises the listed services', () => {
    expect(isMusicHost(['open.spotify.com'])).toBe(true);
    expect(isMusicHost(['soundcloud.com'])).toBe(true);
    expect(isMusicHost(['bandcamp.com'])).toBe(true);
  });

  it('covers subdomains of a listed service', () => {
    expect(isMusicHost(['artist.bandcamp.com'])).toBe(true);
    expect(isMusicHost(['listen.tidal.com'])).toBe(true);
  });

  it('recognises any music.* subdomain', () => {
    // One rule instead of an entry per platform and per country.
    expect(isMusicHost(['music.youtube.com'])).toBe(true);
    expect(isMusicHost(['music.apple.com'])).toBe(true);
    expect(isMusicHost(['music.amazon.co.uk'])).toBe(true);
    expect(isMusicHost(['music.yandex.ru'])).toBe(true);
  });

  it('leaves general video hosts alone', () => {
    // The whole point of listing music.youtube.com rather than youtube.com.
    expect(isMusicHost(['youtube.com'])).toBe(false);
    expect(isMusicHost(['www.youtube.com'.replace('www.', '')])).toBe(false);
    expect(isMusicHost(['netflix.com'])).toBe(false);
    expect(isMusicHost(['twitch.tv'])).toBe(false);
    expect(isMusicHost(['vimeo.com'])).toBe(false);
    expect(isMusicHost([])).toBe(false);
  });

  it('is not fooled by a lookalike host', () => {
    expect(isMusicHost(['notbandcamp.com'])).toBe(false);
    expect(isMusicHost(['bandcamp.com.evil.test'])).toBe(false);
    expect(isMusicHost(['musical.example'])).toBe(false);
  });

  it('catches an embedded player on an unrelated page', () => {
    // siteKeys reports the top-level page first and the frame's own host second;
    // an embedded Spotify player is still music.
    const keys = siteKeys({
      hostname: 'open.spotify.com',
      ancestorOrigins: { length: 1, item: () => 'https://blog.example.com' },
    });
    expect(keys).toEqual(['blog.example.com', 'open.spotify.com']);
    expect(isMusicHost(keys)).toBe(true);
  });

  it('matches the list against normalised hostnames', () => {
    // The list is only ever compared with output from normalizeSite, so every
    // entry has to already be in that form or it can never match.
    for (const host of MUSIC_HOSTS) {
      expect(normalizeSite(host)).toBe(host);
    }
  });
});

describe('classifyMedia', () => {
  it('treats an <audio> element as audio-only whatever its state', () => {
    expect(classifyMedia(media('AUDIO', 0))).toBe('audio-only');
    expect(classifyMedia(media('AUDIO', 4))).toBe('audio-only');
  });

  it('waits for metadata before judging a <video>', () => {
    // Every <video> is 0x0 until metadata arrives, so trusting dimensions early
    // would classify all film as music.
    expect(classifyMedia(media('VIDEO', 0))).toBe('unknown');
    expect(classifyMedia(media('VIDEO', 0, 1920, 1080))).toBe('unknown');
  });

  it('calls a <video> with dimensions video', () => {
    expect(classifyMedia(media('VIDEO', 1, 1920, 1080))).toBe('video');
    expect(classifyMedia(media('VIDEO', 4, 640, 360))).toBe('video');
  });

  it('calls a loaded <video> with no picture audio-only', () => {
    expect(classifyMedia(media('VIDEO', 1, 0, 0))).toBe('audio-only');
    expect(classifyMedia(media('VIDEO', 2, 1920, 0))).toBe('audio-only');
  });

  it('has no opinion about other elements', () => {
    expect(classifyMedia(media('DIV', 1))).toBe('unknown');
    expect(classifyMedia(media('', 1))).toBe('unknown');
  });

  it('is case-insensitive about the tag name', () => {
    expect(classifyMedia(media('audio'))).toBe('audio-only');
    expect(classifyMedia(media('video', 1, 100, 100))).toBe('video');
  });
});

describe('isMusicMedia', () => {
  it('leaves everything on a music service alone, picture or not', () => {
    expect(isMusicMedia(media('VIDEO', 1, 1920, 1080), true)).toBe(true);
    expect(isMusicMedia(media('AUDIO'), true)).toBe(true);
    expect(isMusicMedia(media('VIDEO', 0), true)).toBe(true);
  });

  it('treats audio-only playback anywhere as music', () => {
    expect(isMusicMedia(media('AUDIO'), false)).toBe(true);
    expect(isMusicMedia(media('VIDEO', 2, 0, 0), false)).toBe(true);
  });

  it('processes film and television', () => {
    expect(isMusicMedia(media('VIDEO', 1, 1920, 1080), false)).toBe(false);
  });

  it('does not assume music while a video is still loading', () => {
    // Otherwise a film would play its first moments uncompressed and then jump.
    expect(isMusicMedia(media('VIDEO', 0), false)).toBe(false);
  });
});
