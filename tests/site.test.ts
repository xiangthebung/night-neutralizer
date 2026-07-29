import { describe, expect, it } from 'vitest';
import {
  isSiteDisabled,
  normalizeSite,
  primarySite,
  sanitizeDisabledSites,
  siteKeys,
  toggleSite,
  type LocationLike,
} from '../src/core/site';
import { MAX_DISABLED_SITES } from '../src/core/types';

/** Build a `location`-like object, optionally inside a frame hierarchy. */
function loc(hostname: string, ancestors: string[] = []): LocationLike {
  return {
    hostname,
    ancestorOrigins: {
      length: ancestors.length,
      item: (index: number) => ancestors[index] ?? null,
    },
  };
}

describe('normalizeSite', () => {
  it('lower-cases and strips www', () => {
    expect(normalizeSite('WWW.Example.COM')).toBe('example.com');
    expect(normalizeSite('news.example.com')).toBe('news.example.com');
  });

  it('accepts full URLs and origins', () => {
    expect(normalizeSite('https://www.example.com/watch?v=1')).toBe('example.com');
    expect(normalizeSite('http://example.com:8080')).toBe('example.com');
  });

  it('strips ports, credentials and trailing dots', () => {
    expect(normalizeSite('localhost:5173')).toBe('localhost');
    expect(normalizeSite('https://user:pass@example.com')).toBe('example.com');
    expect(normalizeSite('example.com.')).toBe('example.com');
  });

  it('keeps IPv6 literals intact', () => {
    expect(normalizeSite('http://[::1]:8080/')).toBe('[::1]');
  });

  it('returns an empty key for anything unusable', () => {
    for (const input of ['', '   ', 'null', undefined, null, 42 as unknown as string]) {
      expect(normalizeSite(input)).toBe('');
    }
  });

  // `www.` is only a prefix to strip, never a whole hostname.
  it('does not strip www out of an unrelated label', () => {
    expect(normalizeSite('wwwexample.com')).toBe('wwwexample.com');
  });
});

describe('siteKeys', () => {
  it('uses the frame host for a top-level document', () => {
    expect(siteKeys(loc('www.example.com'))).toEqual(['example.com']);
  });

  it('puts the top-level page first for an embedded player', () => {
    // ancestorOrigins runs parent -> top, so the last entry is the real page.
    const frame = loc('www.youtube.com', ['https://widgets.blog.test', 'https://www.blog.test']);
    expect(siteKeys(frame)).toEqual(['blog.test', 'youtube.com']);
  });

  it('deduplicates when the frame is same-site as the page', () => {
    expect(siteKeys(loc('www.example.com', ['https://example.com']))).toEqual(['example.com']);
  });

  it('survives an opaque ancestor origin', () => {
    expect(siteKeys(loc('example.com', ['null']))).toEqual(['example.com']);
  });

  it('tolerates a missing or empty location', () => {
    expect(siteKeys(null)).toEqual([]);
    expect(siteKeys(undefined)).toEqual([]);
    expect(siteKeys({})).toEqual([]);
  });

  it('reports the top-level page as the primary site', () => {
    expect(primarySite(loc('player.test', ['https://news.test']))).toBe('news.test');
    expect(primarySite(loc('news.test'))).toBe('news.test');
    expect(primarySite({})).toBe('');
  });
});

describe('isSiteDisabled', () => {
  it('matches an exact host', () => {
    expect(isSiteDisabled(['example.com'], ['example.com'])).toBe(true);
    expect(isSiteDisabled(['example.com'], ['other.test'])).toBe(false);
  });

  it('covers subdomains of a listed host', () => {
    expect(isSiteDisabled(['example.com'], ['news.example.com'])).toBe(true);
    // ...but not a host that merely ends with the same characters.
    expect(isSiteDisabled(['example.com'], ['notexample.com'])).toBe(false);
  });

  it('does not treat a subdomain entry as covering its parent', () => {
    expect(isSiteDisabled(['news.example.com'], ['example.com'])).toBe(false);
  });

  it('matches on either the page or the embedded frame', () => {
    const keys = ['blog.test', 'youtube.com'];
    expect(isSiteDisabled(['youtube.com'], keys)).toBe(true);
    expect(isSiteDisabled(['blog.test'], keys)).toBe(true);
    expect(isSiteDisabled(['unrelated.test'], keys)).toBe(false);
  });

  it('is false for empty input on either side', () => {
    expect(isSiteDisabled([], ['example.com'])).toBe(false);
    expect(isSiteDisabled(undefined, ['example.com'])).toBe(false);
    expect(isSiteDisabled(['example.com'], [])).toBe(false);
    // A stray empty entry must not disable the entire web.
    expect(isSiteDisabled([''], ['example.com'])).toBe(false);
  });
});

describe('toggleSite', () => {
  it('adds a site, normalised and sorted', () => {
    expect(toggleSite([], 'WWW.Example.COM', true)).toEqual(['example.com']);
    expect(toggleSite(['z.test'], 'a.test', true)).toEqual(['a.test', 'z.test']);
  });

  it('is idempotent', () => {
    const once = toggleSite([], 'example.com', true);
    expect(toggleSite(once, 'example.com', true)).toEqual(once);
  });

  it('does not add a subdomain already covered by a listed parent', () => {
    expect(toggleSite(['example.com'], 'news.example.com', true)).toEqual(['example.com']);
  });

  it('collapses subdomains when their parent is added', () => {
    expect(toggleSite(['a.example.com', 'b.example.com', 'other.test'], 'example.com', true)).toEqual(
      ['example.com', 'other.test'],
    );
  });

  it('removes a site', () => {
    expect(toggleSite(['example.com', 'other.test'], 'example.com', false)).toEqual(['other.test']);
  });

  it('removes the covering parent when re-enabling a subdomain', () => {
    // Otherwise "turn back on for news.example.com" would appear to do nothing.
    expect(toggleSite(['example.com'], 'news.example.com', false)).toEqual([]);
  });

  it('ignores an unusable site key', () => {
    expect(toggleSite(['example.com'], '', true)).toEqual(['example.com']);
    expect(toggleSite(['example.com'], 'null', false)).toEqual(['example.com']);
  });

  it('caps the list so storage quota cannot be exhausted', () => {
    const many = Array.from({ length: MAX_DISABLED_SITES }, (_, i) => `s${i}.test`);
    const result = toggleSite(many, 'zzz-last.test', true);
    expect(result.length).toBe(MAX_DISABLED_SITES);
  });
});

describe('sanitizeDisabledSites', () => {
  it('rejects non-arrays', () => {
    expect(sanitizeDisabledSites(undefined)).toEqual([]);
    expect(sanitizeDisabledSites('example.com')).toEqual([]);
    expect(sanitizeDisabledSites({ 0: 'example.com' })).toEqual([]);
  });

  it('drops junk entries and duplicates', () => {
    expect(sanitizeDisabledSites(['a.test', 'A.TEST', null, 7, '', 'b.test'])).toEqual([
      'a.test',
      'b.test',
    ]);
  });

  it('caps the stored list', () => {
    const many = Array.from({ length: MAX_DISABLED_SITES + 50 }, (_, i) => `s${i}.test`);
    expect(sanitizeDisabledSites(many).length).toBe(MAX_DISABLED_SITES);
  });
});
