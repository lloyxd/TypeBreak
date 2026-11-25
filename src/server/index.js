/**
 * HTTP server for the TypeBreak web app.
 *
 * Deliberately dependency-free: `node:http` plus static file serving. The API is
 * a thin JSON wrapper over `AppService` — the same object the CLI uses — so no
 * learning logic is repeated here.
 *
 *   npm run web            → http://localhost:4173
 *   PORT=8080 npm run web
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppService } from '../core/service.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const WEB_ROOT = join(ROOT, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const service = new AppService({ rootDir: ROOT });

/** Send JSON with no-store so progress is always fresh. */
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function fail(res, status, message) {
  json(res, status, { error: message });
}

async function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Route table. Each handler receives `{ params, query, body }` and returns a
 * value to be sent as JSON, or throws.
 */
const routes = [
  ['GET', /^\/api\/health$/, () => ({ ok: true, at: new Date().toISOString() })],
  ['GET', /^\/api\/bootstrap$/, () => ({
    overview: service.libraryOverview(),
    reference: service.reference(),
    dashboard: service.dashboard(),
    adaptive: service.assessment(),
    settings: service.settings(),
  })],
  ['GET', /^\/api\/dashboard$/, () => service.dashboard()],
  ['GET', /^\/api\/stats$/, () => service.stats()],

  ['GET', /^\/api\/lessons$/, ({ query }) => service.lessons({
    finger: query.finger,
    movement: query.movement,
    category: query.category,
    difficulty: query.level ? Number.parseInt(query.level, 10) : undefined,
    search: query.search,
  })],
  ['GET', /^\/api\/lessons\/([^/]+)$/, ({ params }) => {
    const lesson = service.lesson(params[0]);
    if (!lesson) throw Object.assign(new Error('Lesson not found'), { status: 404 });
    const progress = service.lessonProgress().find((p) => p.lessonId === lesson.id);
    return { lesson, progress };
  }],

  ['GET', /^\/api\/plan$/, ({ query }) => service.todaysPlan({ force: query.force === '1' })],
  ['GET', /^\/api\/plan\/regenerate$/, () => service.todaysPlan({ force: true })],
  ['GET', /^\/api\/tasks$/, () => service.todaysTasks()],
  ['GET', /^\/api\/weaknesses$/, () => service.weaknesses()],
  ['GET', /^\/api\/adaptive$/, ({ query }) => service.assessment({ forcePlan: query.force === '1' })],
  ['GET', /^\/api\/recommendations$/, ({ query }) => service.recommendations(query.limit ? Number.parseInt(query.limit, 10) : 10)],

  ['GET', /^\/api\/progress\/fingers$/, () => service.fingerProgress()],
  ['GET', /^\/api\/progress\/movements$/, () => service.movementProgress()],
  ['GET', /^\/api\/progress\/lessons$/, () => service.lessonProgress()],
  ['GET', /^\/api\/progress\/history$/, ({ query }) => service.history({
    days: query.days ? Number.parseInt(query.days, 10) : 30,
  })],

  ['POST', /^\/api\/session$/, ({ body }) => service.startSession({
    lessonId: body.lessonId,
    exerciseId: body.exerciseId ?? undefined,
    mode: body.mode === 'strict' ? 'strict' : 'flow',
    clientId: body.clientId ?? 'web',
  })],
  ['POST', /^\/api\/session\/press$/, ({ body }) => service.press({
    clientId: body.clientId ?? 'web',
    key: String(body.key ?? ''),
  })],
  ['POST', /^\/api\/session\/finish$/, ({ body }) => service.finishSession({
    clientId: body.clientId ?? 'web',
  })],
  ['POST', /^\/api\/session\/cancel$/, ({ body }) => service.cancelSession({
    clientId: body.clientId ?? 'web',
  })],

  ['PATCH', /^\/api\/settings$/, ({ body }) => service.updateSettings(body)],
  ['POST', /^\/api\/reset$/, () => {
    service.resetProgress();
    return { reset: true };
  }],
];

/** Serve a file from web/, refusing to escape the directory. */
async function serveStatic(req, res, urlPath) {
  const requested = urlPath === '/' ? '/index.html' : urlPath;
  // Normalise and confirm the resolved path is still inside WEB_ROOT.
  const resolved = normalize(join(WEB_ROOT, decodeURIComponent(requested)));
  if (!resolved.startsWith(WEB_ROOT + sep) && resolved !== join(WEB_ROOT, 'index.html')) {
    return fail(res, 403, 'Forbidden');
  }

  try {
    const info = await stat(resolved);
    const target = info.isDirectory() ? join(resolved, 'index.html') : resolved;
    const data = await readFile(target);
    const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': data.length,
      'cache-control': 'no-cache, must-revalidate',
    });
    res.end(data);
    return undefined;
  } catch {
    // Single-page fallback for client-side routes.
    if (!extname(requested)) {
      try {
        const data = await readFile(join(WEB_ROOT, 'index.html'));
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
        res.end(data);
        return undefined;
      } catch {
        /* fall through */
      }
    }
    return fail(res, 404, 'Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Same-origin default; no CORS headers needed because the app is served here.
  if (!url.pathname.startsWith('/api/')) {
    await serveStatic(req, res, url.pathname);
    return;
  }

  const query = Object.fromEntries(url.searchParams.entries());

  for (const [method, pattern, handler] of routes) {
    if (req.method !== method) continue;
    const match = url.pathname.match(pattern);
    if (!match) continue;

    try {
      const body = method === 'GET' ? {} : await readBody(req);
      const params = match.slice(1).map((p) => decodeURIComponent(p));
      const result = await handler({ params, query, body, req, res });
      if (result !== undefined) json(res, 200, result);
      return;
    } catch (error) {
      const status = error.status ?? 400;
      fail(res, status, error.message ?? 'Request failed');
      return;
    }
  }

  fail(res, 404, `No route for ${req.method} ${url.pathname}`);
});

export function start(port = Number(process.env.PORT ?? 4173)) {
  return new Promise((resolve) => {
    server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
      resolve(server);
    });
  });
}

/** True when this file is the process entry point. */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const port = Number(process.env.PORT ?? 4173);
  start(port).then(() => {
    console.log(`TypeBreak web app running at http://localhost:${port}`);
    console.log(`Progress file: ${service.store.path}`);
  });
}

export { server, service };
