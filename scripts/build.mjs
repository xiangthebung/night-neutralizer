/**
 * Build pipeline for the Night Neutralizer extension.
 *
 *   node scripts/build.mjs            production build into dist/
 *   node scripts/build.mjs --dev      unminified build with sourcemaps
 *   node scripts/build.mjs --watch    rebuild on change (implies --dev)
 *   node scripts/build.mjs --zip      production build + night-neutralizer.zip
 *   node scripts/build.mjs --clean-only
 *
 * Everything is bundled locally with esbuild. No remote code is fetched at
 * build time or at runtime, and the archive is written by Node rather than by
 * an external `zip` binary, so packaging works identically on every platform.
 */
import * as esbuild from 'esbuild';
import { mkdir, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON_SIZES, renderIcon } from './icons.mjs';
import { createZip, verifyZip } from './zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const out = path.join(root, 'dist');

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const dev = watch || args.includes('--dev');
const cleanOnly = args.includes('--clean-only');
const zip = args.includes('--zip');

const entryPoints = {
  content: path.join(src, 'content', 'index.ts'),
  'service-worker': path.join(src, 'background', 'service-worker.ts'),
  popup: path.join(src, 'popup', 'popup.ts'),
};

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints,
  outdir: out,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome111'],
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'info',
  define: { __DEV__: String(dev) },
};

async function copyStatic() {
  const manifest = JSON.parse(await readFile(path.join(src, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  manifest.version = pkg.version;
  await writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  for (const file of ['popup.html', 'popup.css']) {
    await writeFile(path.join(out, file), await readFile(path.join(src, 'popup', file)));
  }

  await mkdir(path.join(out, 'icons'), { recursive: true });
  for (const size of ICON_SIZES) {
    await writeFile(path.join(out, 'icons', `icon-${size}.png`), renderIcon(size));
    // Dimmed variant, swapped in by the service worker while the extension is
    // switched off so the toolbar shows its state without being opened.
    await writeFile(
      path.join(out, 'icons', `icon-off-${size}.png`),
      renderIcon(size, { dim: true }),
    );
  }
}

/** Every file under dist/, as archive-relative forward-slash paths. */
async function collect(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await collect(path.join(dir, entry.name), name)));
    else files.push({ name, data: await readFile(path.join(dir, entry.name)) });
  }
  return files;
}

async function writeZip() {
  // Store artifacts live in artifacts/, named after the version they contain, so
  // an older archive is never silently overwritten and every extension in this
  // workspace puts its upload in the same place.
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const artifacts = path.join(root, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  const archive = path.join(artifacts, `night-neutralizer-${pkg.version}.zip`);
  const files = await collect(out);
  const bytes = createZip(files);
  await writeFile(archive, bytes);

  // Read it straight back: every entry is inflated and CRC-checked, so a
  // malformed archive fails here rather than at the Web Store upload.
  const entries = verifyZip(bytes);
  if (entries.length !== files.length) {
    throw new Error(`zip verification found ${entries.length} of ${files.length} entries`);
  }
  if (!entries.some((entry) => entry.name === 'manifest.json')) {
    throw new Error('zip is missing manifest.json at the archive root');
  }

  console.log(
    `wrote ${path.relative(root, archive)} ` +
      `(${entries.length} files, ${(bytes.length / 1024).toFixed(1)} kB, verified)`,
  );
}

async function main() {
  await rm(out, { recursive: true, force: true });
  if (cleanOnly) {
    console.log('cleaned dist/');
    return;
  }
  await mkdir(out, { recursive: true });
  await copyStatic();

  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('watching for changes... (static files are not watched; re-run for manifest/popup.html edits)');
    return;
  }

  await esbuild.build(buildOptions);
  console.log(`\nbuild complete -> ${path.relative(root, out)}/  (${dev ? 'development' : 'production'})`);
  if (zip) await writeZip();
  console.log('Load it via chrome://extensions -> Developer mode -> Load unpacked -> select dist/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
