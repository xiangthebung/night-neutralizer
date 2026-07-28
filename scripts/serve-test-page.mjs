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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
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
