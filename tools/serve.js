/**
 * Local static file server for development.
 *
 * The app is a static site, so the only thing needed locally is a server that
 * sends correct MIME types and never caches modules during development. This is
 * a dev convenience only — in production the files are served by Azure Static
 * Web Apps, which has no code of ours running at all.
 *
 *   npm start            → http://localhost:4173
 *   PORT=8080 npm start
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', 'web');
const PORT = Number(process.env.PORT ?? 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const requested = decodeURIComponent(url.pathname) === '/' ? '/index.html' : decodeURIComponent(url.pathname);

  // Resolve inside web/ only; refuse anything that escapes.
  const resolved = normalize(join(ROOT, requested));
  if (resolved !== ROOT && !resolved.startsWith(ROOT + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(resolved);
    const target = info.isDirectory() ? join(resolved, 'index.html') : resolved;
    const data = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': data.length,
      // No caching in dev, so an edited module is picked up on reload. The
      // service worker is excluded from this rule by never being cached itself.
      'cache-control': 'no-cache, must-revalidate',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Not found: ${requested}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`TypeBreak (static) running at http://localhost:${PORT}`);
  console.log(`Serving ${ROOT}`);
  console.log('Offline support requires HTTPS or localhost — localhost qualifies.');
});
