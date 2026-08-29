/**
 * The documentation, checked against the code.
 *
 * Every claim in this file was true when it was written and every one of them
 * is the kind that goes quietly false: a setting is added and the privacy
 * policy is not, a file is renamed and the layout diagram is not, a constant is
 * retuned and the store listing keeps quoting the old figure. None of it shows
 * up in a diff, none of it shows up in a browser, and for a Chrome extension
 * the privacy policy in particular is a published promise — the store treats it
 * as part of the submission, not as prose.
 *
 * So the rot is a failing command instead of a good intention. The rule for
 * what belongs here is narrow: a claim earns a test when it is *mechanically*
 * derivable from the source. Anything about how the result looks or sounds is
 * for a person, and is named as such in TESTING.md rather than hidden among
 * things that are actually verified.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, MAX_DISABLED_SITES, type Settings } from '../src/core/types';
import { describeAudioEffect, describeVideoEffect } from '../src/core/readings';
import { formatClock } from '../src/core/schedule';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string): string => readFileSync(path.join(root, file), 'utf8');

const readme = read('README.md');
const policy = read('PRIVACY_POLICY.md');
const listing = read('STORE_LISTING.md');
const manifest = JSON.parse(read('src/manifest.json')) as {
  name: string;
  version: string;
  description: string;
  permissions: string[];
  content_scripts: { matches: string[] }[];
};
const pkg = JSON.parse(read('package.json')) as { version: string; scripts: Record<string, string> };

describe('the privacy policy describes what is actually stored', () => {
  /**
   * One row per stored setting, and the phrase the policy has to use for it.
   *
   * The table is the point: adding a key to `Settings` fails this file until
   * somebody writes down what it is, which is the moment to notice that the
   * published policy does not mention it either. `images` and `darkMode` both
   * shipped without a line here, which is what this is for.
   */
  const DISCLOSED: Record<keyof Settings, RegExp> = {
    enabled: /whether the extension is on/i,
    audioStrength: /strength values for audio and video/i,
    videoStrength: /strength values for audio and video/i,
    audio: /audio processing/i,
    video: /video processing/i,
    images: /still-image processing/i,
    nightEq: /night EQ/i,
    skipMusic: /whether music is left alone/i,
    darkMode: /whether the page itself is darkened/i,
    nightOnly: /whether processing is limited to it/i,
    nightStart: /night window \(start and end minutes\)/i,
    nightEnd: /night window \(start and end minutes\)/i,
    disabledSites: /list of hostnames you have excluded/i,
  };

  it('has a line for every key the extension writes', () => {
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const pattern = DISCLOSED[key];
      expect(pattern, `no disclosure declared for the setting "${key}"`).toBeDefined();
      expect(policy, `PRIVACY_POLICY.md does not disclose "${key}"`).toMatch(pattern);
    }
  });

  it('declares nothing the extension no longer stores', () => {
    // The mirror of the test above: a setting removed from the code has to come
    // out of the policy too, or the policy over-discloses and reads as stale.
    const stored = new Set(Object.keys(DEFAULT_SETTINGS));
    for (const key of Object.keys(DISCLOSED)) {
      expect(stored.has(key), `the policy still describes the removed setting "${key}"`).toBe(true);
    }
  });

  it('quotes the real cap on the exclusion list', () => {
    expect(policy).toMatch(new RegExp(`capped at ${MAX_DISABLED_SITES} entries`));
    expect(readme).toMatch(new RegExp(`\\b${MAX_DISABLED_SITES}\\b`));
  });

  it('is right that the source makes no network calls', () => {
    // The policy invites the reader to check this themselves, so it had better
    // survive being checked. Call syntax rather than bare words, because the
    // word "fetched" appears in a comment about CORS.
    const forbidden = [/\bfetch\s*\(/, /new\s+XMLHttpRequest/, /\.sendBeacon\s*\(/, /new\s+WebSocket/];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.ts$/.test(entry.name)) {
          const source = readFileSync(full, 'utf8');
          for (const pattern of forbidden) {
            if (pattern.test(source)) offenders.push(`${path.relative(root, full)}: ${pattern}`);
          }
        }
      }
    };
    walk(path.join(root, 'src'));
    expect(offenders).toEqual([]);
    expect(policy).toMatch(/no network requests of any kind/i);
  });

  it('names only the permissions the manifest asks for', () => {
    expect(manifest.permissions).toEqual(['storage']);
    // A second permission would need its own justification in the listing and
    // its own sentence in the policy, and adding one silently is the failure.
    expect(listing).toMatch(/\*\*storage\*\* \(the only entry in `permissions`\)/);
  });
});

describe('the store listing quotes the shipped values', () => {
  it('uses the manifest description verbatim, inside the store limit', () => {
    const summary = /## Summary\s+([^\n]+)/.exec(listing)?.[1]?.trim() ?? '';
    expect(summary).toBe(manifest.description);
    expect(summary.length).toBeLessThanOrEqual(132);

    // The listing states the length; a description edited without re-counting
    // is how a submission ends up over the limit.
    const stated = Number(/short description is (\d+) characters/.exec(listing)?.[1]);
    expect(stated).toBe(summary.length);
  });

  it('agrees with the manifest and the package on name and version', () => {
    expect(manifest.version).toBe(pkg.version);
    expect(listing).toMatch(new RegExp(`Version ${manifest.version.replace(/\./g, '\\.')}\\.`));
    for (const document of [listing, policy, readme]) {
      expect(document).toContain(manifest.name);
    }
  });

  it('quotes the captions the popup actually shows at the default strength', () => {
    // These are the two lines a reader is most likely to believe without
    // checking, and they are derived from the tone curve and the audio transfer
    // model, so retuning either silently falsifies the listing.
    const [videoOne, videoTwo] = describeVideoEffect(DEFAULT_SETTINGS.videoStrength);
    const [audioOne, audioTwo] = describeAudioEffect(DEFAULT_SETTINGS.audioStrength);
    const quoted = (line: string): string => line.toLowerCase().replace(/^./, (c) => c);

    for (const line of [videoOne, videoTwo, audioOne, audioTwo]) {
      expect(listing.toLowerCase()).toContain(quoted(line).toLowerCase());
    }
  });

  it('quotes the shipped defaults for the sliders and the night window', () => {
    expect(DEFAULT_SETTINGS.audioStrength).toBe(DEFAULT_SETTINGS.videoStrength);
    expect(listing).toMatch(new RegExp(`default ${DEFAULT_SETTINGS.audioStrength}\\b`));
    const window = `${formatClock(DEFAULT_SETTINGS.nightStart)} to ${formatClock(
      DEFAULT_SETTINGS.nightEnd,
    )}`;
    expect(listing).toContain(window);
    expect(readme).toContain(formatClock(DEFAULT_SETTINGS.nightStart));
  });

  it('describes the content-script matches the manifest declares', () => {
    const matches = manifest.content_scripts[0]?.matches ?? [];
    expect(matches).toEqual(['http://*/*', 'https://*/*']);
    for (const pattern of matches) {
      expect(listing).toContain(pattern);
      expect(readme).toContain(pattern);
      expect(policy).toContain(pattern);
    }
  });
});

describe('the README describes the repository that exists', () => {
  it('lists only files and directories that are really there', () => {
    // The layout diagram is the part of a README that rots first, because a
    // rename never touches it.
    const block = /## Project layout\s+```([\s\S]*?)```/.exec(readme)?.[1] ?? '';
    expect(block.length).toBeGreaterThan(0);

    /** Rebuild each entry's full path from the diagram's indentation. */
    const parents: string[] = [];
    const missing: string[] = [];
    const checked: string[] = [];
    // Split on either ending. This file is checked out with CRLF on Windows,
    // and splitting on '\n' alone left a '\r' at the end of every line, which
    // the entry pattern's `$` then refused to match — so the loop below found
    // nothing, `missing` stayed empty, and the whole check passed vacuously
    // while the diagram could say anything at all. Hence `checked` below.
    for (const line of block.split(/\r?\n/)) {
      const entry = /^(\s*)(\S+?)(\/?)(?:\s{2,}\S.*)?$/.exec(line);
      if (!entry) continue;
      const depth = Math.floor((entry[1] as string).length / 2);
      if (depth > parents.length) continue;
      parents.length = depth;
      const name = entry[2] as string;
      const directory = parents.join('/');
      if (entry[3] === '/') parents[depth] = name;
      for (const candidate of expand(directory, name)) {
        checked.push(candidate);
        if (!existsSync(path.join(root, candidate))) missing.push(candidate);
      }
    }
    // The diagram is nearly fifty lines; anything much below that means the
    // parser stopped seeing it rather than that the repository shrank.
    expect(checked.length).toBeGreaterThan(40);
    expect(checked).toContain('src/core/tone-curve.ts');
    expect(missing).toEqual([]);
  });

  it('quotes the real number of unit tests', () => {
    // Derived rather than maintained: a hand-written count is a second copy of
    // the truth and it always drifts. Every suite here writes one `it(` per
    // test, which the suite total is checked against below.
    const files = readdirSync(path.join(root, 'tests')).filter((name) => name.endsWith('.test.ts'));
    let counted = 0;
    for (const file of files) {
      counted += (read(`tests/${file}`).match(/^\s*it\(/gm) ?? []).length;
    }
    const stated = Number(/`npm test`, (\d+) tests/.exec(readme)?.[1]);
    expect(stated, 'README no longer states a test count in the expected form').toBeGreaterThan(0);
    expect(stated).toBe(counted);
  });

  it('quotes the real number of end-to-end checks', () => {
    const smoke = read('scripts/smoke.mjs');
    const counted = (smoke.match(/^\s*check\(/gm) ?? []).length;
    const stated = Number(/asserts (\d+) checks/.exec(read('TESTING.md'))?.[1]);
    expect(stated, 'TESTING.md no longer states a smoke count').toBeGreaterThan(0);
    expect(stated).toBe(counted);
  });

  it('documents every npm script it tells the reader to run', () => {
    const documented = [...readme.matchAll(/`npm run ([a-z:]+)`/g)].map((match) => match[1] ?? '');
    for (const script of new Set(documented)) {
      expect(pkg.scripts[script], `README documents a missing script: npm run ${script}`).toBeDefined();
    }
  });
});

describe('no document ships a placeholder', () => {
  it('has nothing left to fill in', () => {
    for (const [name, text] of [
      ['README.md', readme],
      ['PRIVACY_POLICY.md', policy],
      ['STORE_LISTING.md', listing],
    ] as const) {
      expect(text, `${name} contains a placeholder`).not.toMatch(
        /\bTODO\b|\bTBD\b|\bFIXME\b|\[YOUR |LOREM IPSUM/i,
      );
    }
  });
});

/**
 * One diagram entry to the paths it stands for.
 *
 * Almost always exactly one. The exception is `popup.html/.css/.ts`, which the
 * layout writes as a single line because the three files are one component;
 * that expands to all three so a rename of any of them is still caught.
 */
function expand(directory: string, name: string): string[] {
  const join = (leaf: string): string => (directory ? `${directory}/${leaf}` : leaf);
  if (!name.includes('/')) return [join(name)];
  const [first, ...rest] = name.split('/');
  const stem = (first as string).replace(/\.[^.]*$/, '');
  return [join(first as string), ...rest.map((extension) => join(`${stem}${extension}`))];
}
