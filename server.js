// Local read-only server. GET /api/board returns the board; everything else is a static page from public/.
// Listens on 127.0.0.1 only and rejects any other Host header (DNS-rebinding guard): thread titles and summaries never leave the machine.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoard } from './lib/model.js';
import { SessionReader } from './lib/read.js';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const JSON_TYPE = 'application/json; charset=utf-8';
const TYPES = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
});
const HOST_OK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/**
 * @param {SessionReader} [reader]
 * @param {() => number} [now]
 */
export function createBoardServer(reader = new SessionReader(), now = Date.now) {
  return createServer(async (req, res) => {
    const send = (/** @type {number} */ code, /** @type {string | Buffer} */ body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(body);
    };
    const sendJson = (/** @type {number} */ code, /** @type {unknown} */ body) => send(code, JSON.stringify(body), JSON_TYPE);

    if (!HOST_OK.test(req.headers.host ?? '')) return send(403, 'Host not allowed');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Read-only');
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/api/board') {
      try {
        const { desktop, registry, warnings } = reader.read();
        const latest = new Map(desktop.filter((t) => !t.archived).map((t) => [t.id, reader.latest(t.cliId)]));
        const includeArchived = url.searchParams.get('archived') === '1';
        const board = buildBoard({ desktop, registry, now: now(), includeArchived, latest });
        return sendJson(200, { ...board, warnings });
      } catch (e) {
        return sendJson(500, { error: 'Could not read the threads.', detail: String(e instanceof Error ? e.message : e) });
      }
    }

    if (url.pathname === '/api/timeline') {
      // only ids of real threads are accepted (the transcript path is always found by the server, never taken from the request)
      const id = url.searchParams.get('id') ?? '';
      try {
        const t = /^local_[\w-]+$/.test(id) ? reader.read().desktop.find((x) => x.id === id) : undefined;
        if (!t) return sendJson(404, { error: 'No such thread.' });
        return sendJson(200, { id, ...reader.timeline(t.cliId) });
      } catch (e) {
        return sendJson(500, { error: 'Could not build the timeline.', detail: String(e instanceof Error ? e.message : e) });
      }
    }

    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
    if (rel.includes('..')) return send(400, 'Invalid path');
    try {
      const file = join(PUBLIC, rel);
      return send(200, await readFile(file), TYPES[extname(file)] ?? 'application/octet-stream');
    } catch {
      return send(404, 'Not found'); // expected: no such file in public/
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 4848;
  createBoardServer().listen(port, '127.0.0.1', () => console.log(`Thread Board at http://127.0.0.1:${port}`));
}
