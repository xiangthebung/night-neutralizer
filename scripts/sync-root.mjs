/**
 * Copy the production build into the repository root.
 *
 * GitHub's source ZIP should be usable by someone who does not have Node.js
 * installed. Keeping the compiled extension at the root means the extracted
 * repository can be selected directly in chrome://extensions.
 */
import { cp, readdir, rm } from 'node:fs/promises';
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

async function main() {
  const entries = await readdir(source, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  const missing = REQUIRED.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`dist/ is missing: ${missing.join(', ')}. Run the production build first.`);
  }

  // Remove only files/directories owned by this sync step. The rest of the
  // repository root contains source, test, legal, and project metadata files.
  await Promise.all(
    GENERATED.map((name) => rm(path.join(root, name), { recursive: true, force: true })),
  );

  await Promise.all(
    entries.map((entry) =>
      cp(path.join(source, entry.name), path.join(root, entry.name), {
        recursive: entry.isDirectory(),
        force: true,
      }),
    ),
  );

  console.log('synced the production build into the repository root for Load unpacked');
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
