/**
 * Development server.
 *
 * The site is fully static, so this exists only so you can open it over
 * `http://localhost` — ES modules, Web Workers and service workers all refuse
 * to run from `file://`. It serves the repository as-is; there is no build.
 *
 * It also sends the two cross-origin isolation headers. In production those
 * come from `coi.js`, because GitHub Pages cannot set response headers; here
 * they come from the server, so the multi-threaded FFmpeg core and
 * `SharedArrayBuffer` behave locally exactly as they will once deployed.
 *
 *   node tools/serve.js [port]
 */

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const PORT = Number(process.argv[2]) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Refuse to serve anything outside the repository.
  const target = join(ROOT, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(ROOT)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  let stats;
  try {
    stats = statSync(target);
    if (stats.isDirectory()) throw new Error('directory');
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }

  response.writeHead(200, {
    'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
    'content-length': stats.size,
    'cache-control': 'no-cache',
    // Match what a strict host would send, so problems show up here first.
    'x-content-type-options': 'nosniff',
    // Cross-origin isolation: without these two, `SharedArrayBuffer` is
    // undefined and only the single-threaded core can run.
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'same-origin',
  });
  createReadStream(target).pipe(response);
});

server.listen(PORT, () => {
  console.log(`media-forge dev server: http://localhost:${PORT}/`);
});
