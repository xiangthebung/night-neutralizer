import { describe, expect, it } from 'vitest';
import { classifyMediaOrigin } from '../src/core/media-origin';

const page = 'https://example.com';

describe('classifyMediaOrigin', () => {
  it('treats MSE/blob sources as safe (this is what YouTube and Vimeo use)', () => {
    expect(
      classifyMediaOrigin({
        src: 'blob:https://www.youtube.com/2f8e-4a1b',
        crossOrigin: null,
        pageOrigin: 'https://www.youtube.com',
      }),
    ).toBe('safe');
  });

  it('treats data:, mediastream: and srcObject as safe', () => {
    expect(classifyMediaOrigin({ src: 'data:audio/wav;base64,AA', crossOrigin: null, pageOrigin: page })).toBe(
      'safe',
    );
    expect(classifyMediaOrigin({ src: 'mediastream:abc', crossOrigin: null, pageOrigin: page })).toBe('safe');
    expect(
      classifyMediaOrigin({ src: '', crossOrigin: null, pageOrigin: page, hasSrcObject: true }),
    ).toBe('safe');
  });

  it('treats same-origin files as safe', () => {
    expect(classifyMediaOrigin({ src: `${page}/movie.mp4`, crossOrigin: null, pageOrigin: page })).toBe('safe');
    expect(classifyMediaOrigin({ src: '/movie.mp4', crossOrigin: null, pageOrigin: page })).toBe('safe');
    expect(classifyMediaOrigin({ src: 'movie.mp4', crossOrigin: null, pageOrigin: page })).toBe('safe');
  });

  it('treats local files as safe', () => {
    expect(
      classifyMediaOrigin({ src: 'file:///Users/me/clip.mp4', crossOrigin: null, pageOrigin: 'null' }),
    ).toBe('safe');
  });

  it('flags plain cross-origin media as risky', () => {
    expect(
      classifyMediaOrigin({ src: 'https://cdn.other.com/movie.mp4', crossOrigin: null, pageOrigin: page }),
    ).toBe('risky');
    expect(
      classifyMediaOrigin({ src: 'http://example.com/movie.mp4', crossOrigin: null, pageOrigin: page }),
    ).toBe('risky'); // different scheme, different origin
  });

  it('accepts cross-origin media that opted into CORS', () => {
    for (const crossOrigin of ['anonymous', 'use-credentials']) {
      expect(
        classifyMediaOrigin({
          src: 'https://cdn.other.com/movie.mp4',
          crossOrigin,
          pageOrigin: page,
        }),
      ).toBe('safe');
    }
  });

  it('reports an empty source so the caller can retry after loadedmetadata', () => {
    expect(classifyMediaOrigin({ src: '', crossOrigin: null, pageOrigin: page })).toBe('empty');
    expect(classifyMediaOrigin({ src: '   ', crossOrigin: null, pageOrigin: page })).toBe('empty');
  });

  it('is conservative about unparseable URLs and opaque origins', () => {
    expect(classifyMediaOrigin({ src: 'http://', crossOrigin: null, pageOrigin: page })).toBe('risky');
    expect(
      classifyMediaOrigin({ src: 'https://cdn.other.com/a.mp4', crossOrigin: null, pageOrigin: 'null' }),
    ).toBe('risky');
  });
});
