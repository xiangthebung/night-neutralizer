/**
 * Copy the production build into the repository root.
 *
 * GitHub's source ZIP should be usable by someone who does not have Node.js
 * installed. Keeping the compiled extension at the root means the extracted
 * repository can be selected directly in chrome://extensions.
 *
 * One wrinkle, and the reason this file is longer than a `cp`: the icons are
 * generated rather than stored, and PNG is a compressed format. `scripts/
 * icons.mjs` draws exactly the same pixels on every machine, but it hands them
 * to `zlib.deflateSync`, whose output is a property of the zlib build Node was
 * linked against rather than of the input. So a rebuild on a machine with a
 * different Node produces eight PNGs that differ byte for byte and not by one
 * pixel — which made `npm run build` dirty the working tree on a clean
 * checkout, and put meaningless icon churn into commits that touched nothing
 * visual. Comparing the *pixels* and keeping the existing file when they match
 * removes the noise without pretending the compressor is deterministic.
 */
import { cp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'dist');

const REQUIRED = ['manifest.json', 'popup.html', 'popup.js', 'service-worker.js', 'content.js'];
const GENERATED = [
  'manifest.json',
  'content.js',
  'service-worker.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'icons',
];

/**
 * A PNG's decompressed image data, or null if it cannot be read as one.
 *
 * Only the `IDAT` chunks matter: everything else these files carry (`IHDR`,
 * `IEND`) is fixed by the size, and the encoder writes no metadata at all.
 */
function pixels(png) {
  try {
    if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) return null;
    const parts = [];
    let offset = 8;
    while (offset + 8 <= png.length) {
      const length = png.readUInt32BE(offset);
      const type = png.toString('ascii', offset + 4, offset + 8);
      if (type === 'IDAT') parts.push(png.subarray(offset + 8, offset + 8 + length));
      offset += 12 + length;
    }
    return parts.length > 0 ? inflateSync(Buffer.concat(parts)) : null;
  } catch {
    return null;
  }
}

/** Copy `from` to `to`, unless `to` is already the same picture. */
async function syncPng(from, to) {
  const next = await readFile(from);
  const current = await readFile(to).catch(() => null);
  if (current) {
    const a = pixels(current);
    const b = pixels(next);
    // Identical pixels: keep whatever is already on disk, so a different zlib
    // does not show up as a change. Anything unreadable falls through to the
    // plain copy rather than being trusted.
    if (a && b && a.equals(b)) return false;
  }
  await writeFile(to, next);
  return true;
}

async function syncIcons() {
  const from = path.join(source, 'icons');
  const to = path.join(root, 'icons');
  await mkdir(to, { recursive: true });
  const entries = await readdir(from, { withFileTypes: true });

  // Names that are no longer generated must still disappear from the root.
  const generated = new Set(entries.map((entry) => entry.name));
  for (const existing of await readdir(to, { withFileTypes: true }).catch(() => [])) {
    if (!generated.has(existing.name)) {
      await rm(path.join(to, existing.name), { recursive: true, force: true });
    }
  }

  let rewritten = 0;
  for (const entry of entries) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await cp(a, b, { recursive: true, force: true });
      rewritten++;
    } else if (entry.name.endsWith('.png')) {
      if (await syncPng(a, b)) rewritten++;
    } else {
      await cp(a, b, { force: true });
      rewritten++;
    }
  }
  return { total: entries.length, rewritten };
}

async function main() {
  const entries = await readdir(source, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  const missing = REQUIRED.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`dist/ is missing: ${missing.join(', ')}. Run the production build first.`);
  }

  // Remove only files/directories owned by this sync step. The rest of the
  // repository root contains source, test, legal, and project metadata files.
  // `icons` is deliberately not in this pass: it is reconciled file by file
  // below so unchanged pictures keep their existing bytes.
  await Promise.all(
    GENERATED.filter((name) => name !== 'icons').map((name) =>
      rm(path.join(root, name), { recursive: true, force: true }),
    ),
  );

  await Promise.all(
    entries
      .filter((entry) => entry.name !== 'icons')
      .map((entry) =>
        cp(path.join(source, entry.name), path.join(root, entry.name), {
          recursive: entry.isDirectory(),
          force: true,
        }),
      ),
  );

  const icons = await syncIcons();
  console.log(
    'synced the production build into the repository root for Load unpacked' +
      ` (${icons.rewritten} of ${icons.total} icons rewritten)`,
  );
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
