/**
 * Zero-dependency static server for the local test bench.
 *
 *   npm run testpage   ->   http://localhost:8765
 *
 * Content scripts do not run on file:// URLs unless the user explicitly grants
 * file access, so the manual tests are served over http instead.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-page');
const port = Number(process.env.PORT ?? 8791);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Media the bench records at runtime and hands back, so the cross-origin case
 * (`test-page/cross.html`) has a real clip to play without the repository
 * holding a binary. `PUT /blob/<name>` stores a body in memory; `GET` serves
 * it with byte ranges, which a media element asks for from its first request.
 * Deliberately no CORS headers: that is the case being reproduced.
 */
const blobs = new Map();
const MAX_BLOB_BYTES = 16 * 1024 * 1024;

async function serveBlob(req, res, name) {
  if (req.method === 'PUT') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BLOB_BYTES) {
        res.writeHead(413).end('too large');
        return;
      }
      chunks.push(chunk);
    }
    blobs.set(name, {
      type: req.headers['content-type'] ?? 'application/octet-stream',
      body: Buffer.concat(chunks),
    });
    res.writeHead(204).end();
    return;
  }
  const blob = blobs.get(name);
  if (!blob) {
    res.writeHead(404).end('not found');
    return;
  }
  const headers = {
    'content-type': blob.type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'x-nn-test-bench': '1',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), blob.body.length - 1) : blob.body.length - 1;
    if (start > end || start >= blob.body.length) {
      res.writeHead(416, { 'content-range': `bytes */${blob.body.length}` }).end();
      return;
    }
    const part = blob.body.subarray(start, end + 1);
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${blob.body.length}`,
      'content-length': String(part.length),
    });
    res.end(req.method === 'HEAD' ? undefined : part);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': String(blob.body.length) });
  res.end(req.method === 'HEAD' ? undefined : blob.body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    if (url.pathname.startsWith('/blob/')) {
      await serveBlob(req, res, decodeURIComponent(url.pathname.slice('/blob/'.length)));
      return;
    }
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const target = path.join(root, path.normalize(relative));

    // Path traversal guard.
    if (!target.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    const info = await stat(target);
    if (!info.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }

    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      // Sentinel so the smoke test can tell this server apart from anything
      // else that happens to be listening on the port.
      'x-nn-test-bench': '1',
    });
    res.end(body);
  } catch (error) {
    if (process.env.DEBUG) console.error('404', req.url, error);
    res.writeHead(404).end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`test bench: http://localhost:${port}`);
  console.log('stop with Ctrl+C');
});
