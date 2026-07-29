/**
 * Locate a Chrome (or Chromium/Edge) executable for the headless dev tooling.
 *
 * `CHROME_PATH` still wins, but it is an override rather than a requirement.
 * The scripts used to hard-code the macOS bundle path, so a Windows or Linux
 * contributor got an opaque spawn failure instead of a test run.
 */
import { existsSync } from 'node:fs';

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ],
  win32: [
    `${process.env.PROGRAMFILES ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.PROGRAMFILES ?? 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
};

export function findChrome() {
  const override = process.env.CHROME_PATH;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`CHROME_PATH points at a file that does not exist: ${override}`);
    }
    return override;
  }

  const found = (CANDIDATES[process.platform] ?? []).find((candidate) => existsSync(candidate));
  if (found) return found;

  throw new Error(
    `could not find Chrome on ${process.platform}. Set CHROME_PATH to the executable, e.g.\n` +
      (process.platform === 'win32'
        ? '  $env:CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'
        : '  CHROME_PATH=/path/to/chrome npm run smoke'),
  );
}
