/**
 * Site identity and the per-site exclusion list.
 *
 * Why this exists: a single global strength is wrong often enough to be
 * annoying. One site already tone-maps its own video, another is a work tool
 * you never watch at night, a third breaks in some way you do not want to debug
 * at 1 a.m. The honest answer is "leave that site alone".
 *
 * How it stays permission-free: the extension holds no `tabs` permission, so
 * the popup cannot read the active tab's URL. Instead each frame works out its
 * own site key and reports the bare hostname alongside its status. That report
 * lives in `chrome.storage.session`, which is memory-only. No history, no URLs,
 * no titles, nothing on disk.
 *
 * How the key is chosen: a frame uses the *top-level* page's hostname, taken
 * from `location.ancestorOrigins`. That is available even when the ancestors
 * are cross-origin, so a YouTube player embedded in a blog is governed by the
 * blog, which is the page the user is actually looking at. The frame's own
 * hostname is matched too, so excluding `youtube.com` also silences YouTube
 * embeds wherever they appear.
 */
import { MAX_DISABLED_SITES } from './types';

/**
 * Normalise a hostname (or a whole origin/URL) to the form stored in settings:
 * lower case, no scheme, no port, no `www.`, no trailing dot. Returns an empty
 * string for anything unusable, which callers treat as "no site key".
 */
export function normalizeSite(input: string | null | undefined): string {
  if (typeof input !== 'string') return '';
  let host = input.trim().toLowerCase();
  if (!host) return '';

  // Accept a full URL or origin as well as a bare hostname.
  const schemeEnd = host.indexOf('://');
  if (schemeEnd !== -1) host = host.slice(schemeEnd + 3);
  host = host.split('/')[0] ?? '';
  // Strip credentials, then the port. IPv6 literals keep their brackets.
  const at = host.lastIndexOf('@');
  if (at !== -1) host = host.slice(at + 1);
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close !== -1) host = host.slice(0, close + 1);
  } else {
    host = host.split(':')[0] ?? '';
  }
  while (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('www.')) host = host.slice(4);

  // Opaque origins (`null`, `about:`, blob URLs without a host) have no key.
  if (!host || host === 'null') return '';
  return host;
}

/** The subset of `Location` this module needs, so it can be tested plainly. */
export interface LocationLike {
  hostname?: string;
  ancestorOrigins?: { length: number; item(index: number): string | null } | null;
}

/**
 * Site keys for a frame, most significant first: the top-level page, then the
 * frame's own host. Both are matched against the exclusion list.
 */
export function siteKeys(loc: LocationLike | null | undefined): string[] {
  const own = normalizeSite(loc?.hostname);
  const keys: string[] = [];

  const ancestors = loc?.ancestorOrigins;
  if (ancestors && typeof ancestors.length === 'number' && ancestors.length > 0) {
    // `ancestorOrigins` runs from the immediate parent up to the top-level
    // document, so the last entry is the page the user sees in the address bar.
    const top = normalizeSite(ancestors.item(ancestors.length - 1));
    if (top) keys.push(top);
  }

  if (own && !keys.includes(own)) keys.push(own);
  return keys;
}

/** The site a frame reports to the popup: the top-level page when known. */
export function primarySite(loc: LocationLike | null | undefined): string {
  return siteKeys(loc)[0] ?? '';
}

/**
 * True when `key` is covered by `listed`, which also covers its subdomains.
 *
 * Exported because the same containment rule governs any list of hostnames, and
 * `core/music.ts` needs it for the list of music services. Two
 * subdomain-matching implementations would eventually disagree.
 */
export function hostCovers(listed: string, key: string): boolean {
  return key === listed || key.endsWith(`.${listed}`);
}

/** True when any of a frame's keys is excluded. */
export function isSiteDisabled(
  disabledSites: readonly string[] | undefined,
  keys: readonly string[],
): boolean {
  if (!disabledSites?.length || !keys.length) return false;
  return disabledSites.some(
    (entry) => entry.length > 0 && keys.some((key) => hostCovers(entry, key)),
  );
}

/**
 * Is the exclusion list full, so that the next unrelated host cannot be added?
 *
 * Exported because the popup has to be able to say so. `toggleSite` refuses
 * quietly by design — a function that returns a list cannot report a reason —
 * and a refusal nobody is told about is the failure this replaced.
 */
export function isSiteListFull(disabledSites: readonly string[] | undefined): boolean {
  return sanitizeDisabledSites(disabledSites).length >= MAX_DISABLED_SITES;
}

/**
 * Add or remove a site, returning a new sorted list. Adding a parent domain
 * drops the subdomains it now covers, so the list cannot accumulate redundant
 * entries; removing a site also removes any listed parent that was excluding
 * it, otherwise "turn back on" would appear to do nothing.
 *
 * At the cap the add is **refused**, and the list comes back unchanged. It used
 * to be `next.sort().slice(0, MAX_DISABLED_SITES)`, which made room by deleting
 * whichever hostname sorted last. That is two silent failures in one line: if
 * the new key sorted last it was itself the entry dropped, so "skip this site"
 * did nothing while the popup said it had worked; and if it did not, an
 * unrelated site the user excluded months ago was silently switched back on.
 * Refusing keeps the user's own data intact and is a state the popup can
 * explain — see `isSiteListFull`.
 *
 * Note the cap is checked against `next`, after the subdomain filter, so adding
 * a parent domain that absorbs several listed subdomains still succeeds on a
 * full list: it makes room rather than needing it.
 */
export function toggleSite(
  disabledSites: readonly string[] | undefined,
  site: string,
  disabled: boolean,
): string[] {
  const key = normalizeSite(site);
  const current = sanitizeDisabledSites(disabledSites);
  if (!key) return current;

  if (disabled) {
    if (current.some((entry) => hostCovers(entry, key))) return current;
    const next = current.filter((entry) => !hostCovers(key, entry));
    if (next.length >= MAX_DISABLED_SITES) return current;
    next.push(key);
    return next.sort();
  }

  return current.filter((entry) => !hostCovers(entry, key));
}

/** Coerce stored data into a clean, de-duplicated, capped list of hostnames. */
export function sanitizeDisabledSites(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const key = normalizeSite(typeof entry === 'string' ? entry : '');
    if (key) seen.add(key);
    if (seen.size >= MAX_DISABLED_SITES) break;
  }
  return [...seen].sort();
}
