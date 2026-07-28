/**
 * Build pipeline for the Night Neutralizer extension.
 *
 *   node scripts/build.mjs            production build into dist/
 *   node scripts/build.mjs --dev      unminified build with sourcemaps
 *   node scripts/build.mjs --watch    rebuild on change (implies --dev)
 *   node scripts/build.mjs --clean-only
 *
 * Everything is bundled locally with esbuild. No remote code is fetched at
 * build time or at runtime.
 */
import * as esbuild from 'esbuild';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON_SIZES, renderIcon } from './icons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const out = path.join(root, 'dist');

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const dev = watch || args.includes('--dev');
const cleanOnly = args.includes('--clean-only');

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
  }
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
  console.log('Load it via chrome://extensions -> Developer mode -> Load unpacked -> select dist/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
