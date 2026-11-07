// Máy chủ cục bộ, chỉ đọc. GET /api/board trả về bảng; phần còn lại là trang tĩnh trong public/.
// Chỉ nghe ở 127.0.0.1 và từ chối Host mang tên khác (chống DNS rebinding): tiêu đề và tóm tắt thread không rời khỏi máy.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoard } from './lib/model.js';
import { SessionReader } from './lib/read.js';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const HOST_OK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export function createBoardServer(reader = new SessionReader(), now = Date.now) {
  return createServer(async (req, res) => {
    const send = (code, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(body);
    };
    if (!HOST_OK.test(req.headers.host ?? '')) return send(403, 'Host not allowed');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Read-only');
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/board') {
      try {
        const { desktop, registry, warnings } = reader.read();
        const latest = new Map(desktop.filter((t) => !t.archived).map((t) => [t.id, reader.latest(t.cliId)]));
        const board = buildBoard({ desktop, registry, now: now(), includeArchived: url.searchParams.get('archived') === '1', latest });
        return send(200, JSON.stringify({ ...board, warnings }), 'application/json; charset=utf-8');
      } catch (e) {
        return send(500, JSON.stringify({ error: 'Could not read the threads.', detail: String(e?.message ?? e) }), 'application/json; charset=utf-8');
      }
    }
    if (url.pathname === '/api/timeline') {
      // chỉ nhận id của thread có thật (đường dẫn tệp luôn do máy chủ tự tìm, không lấy từ yêu cầu)
      const id = url.searchParams.get('id') ?? '';
      try {
        const t = /^local_[\w-]+$/.test(id) ? reader.read().desktop.find((x) => x.id === id) : undefined;
        if (!t) return send(404, JSON.stringify({ error: 'No such thread.' }), 'application/json; charset=utf-8');
        return send(200, JSON.stringify({ id, ...reader.timeline(t.cliId) }), 'application/json; charset=utf-8');
      } catch (e) {
        return send(500, JSON.stringify({ error: 'Could not build the timeline.', detail: String(e?.message ?? e) }), 'application/json; charset=utf-8');
      }
    }
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
    if (rel.includes('..')) return send(400, 'Invalid path');
    try {
      const file = join(PUBLIC, rel);
      return send(200, await readFile(file), TYPES[extname(file)] ?? 'application/octet-stream');
    } catch {
      return send(404, 'Not found');
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 4848;
  createBoardServer().listen(port, '127.0.0.1', () => console.log(`Thread Board at http://127.0.0.1:${port}`));
}
