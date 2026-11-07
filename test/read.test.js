import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopSessionsDir, registryDir, SessionReader } from '../lib/read.js';
import { createBoardServer } from '../server.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'thread-board-'));
  const desktop = join(root, 'claude-code-sessions', 'acct', 'org');
  const reg = join(root, 'sessions');
  mkdirSync(desktop, { recursive: true });
  mkdirSync(reg, { recursive: true });
  writeFileSync(join(desktop, 'local_a.json'), JSON.stringify({ sessionId: 'local_a', title: 'A', cwd: '/w/p', lastActivityAt: 10, postTurnSummary: { status_category: 'completed', status_detail: 'xong' } }));
  writeFileSync(join(desktop, 'local_b.json'), '{broken');
  writeFileSync(join(desktop, 'khac.json'), JSON.stringify({ sessionId: 'local_x' }));
  writeFileSync(join(reg, '100.json'), JSON.stringify({ pid: 100, hostSessionId: 'local_a', status: 'busy' }));
  writeFileSync(join(reg, '200.json'), JSON.stringify({ pid: 200, hostSessionId: 'local_z', status: 'busy' }));
  return { root, desktopDir: join(root, 'claude-code-sessions'), registryDir: reg };
}

test('SessionReader: reads threads, skips broken files and dead processes', () => {
  const f = fixture();
  try {
    const r = new SessionReader({ desktopDir: f.desktopDir, registryDir: f.registryDir, isAlive: (pid) => pid === 100 });
    const out = r.read();
    assert.deepEqual(out.desktop.map((t) => t.id), ['local_a']);
    assert.deepEqual(out.registry.map((e) => e.pid), [100]);
    assert.deepEqual(out.warnings, []);
    assert.equal(r.read().desktop.length, 1); // the second read uses the cache
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('SessionReader: a missing folder only warns, no error', () => {
  const r = new SessionReader({ desktopDir: '/does/not/exist', registryDir: '/also/not/there' });
  const out = r.read();
  assert.deepEqual(out.desktop, []);
  assert.equal(out.warnings.length, 2);
  assert.equal(new SessionReader({ desktopDir: null, registryDir: '/x' }).read().warnings[0].includes('turned off'), true);
});

test('default paths follow the operating system and environment variables', () => {
  assert.equal(desktopSessionsDir({}, 'darwin', '/h'), '/h/Library/Application Support/Claude/claude-code-sessions');
  assert.equal(desktopSessionsDir({ XDG_CONFIG_HOME: '/c' }, 'linux', '/h'), '/c/Claude/claude-code-sessions');
  assert.equal(desktopSessionsDir({ THREAD_BOARD_DESKTOP: 'off' }, 'darwin', '/h'), null);
  assert.equal(desktopSessionsDir({ THREAD_BOARD_DESKTOP: '/x' }, 'darwin', '/h'), '/x');
  assert.equal(registryDir({ CLAUDE_CONFIG_DIR: '/cfg' }, '/h'), '/cfg/sessions');
  assert.equal(registryDir({}, '/h'), '/h/.claude/sessions');
});

test('server: read-only, rejects a foreign Host, serves /api/board', async () => {
  const f = fixture();
  const reader = new SessionReader({ desktopDir: f.desktopDir, registryDir: f.registryDir, isAlive: () => true });
  const server = createBoardServer(reader, () => 1_000_000);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const board = await (await fetch(`${base}/api/board`)).json();
    assert.equal(board.groups.length, 1);
    assert.equal(board.groups[0].status, 'work'); // process 100 is busy
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/../package.json`)).status === 200, false);
    assert.equal((await fetch(`${base}/api/board`, { method: 'POST' })).status, 405);
    const http = await import('node:http');
    const code = await new Promise((ok) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/board', headers: { Host: 'evil.example' } }, (res) => { res.resume(); ok(res.statusCode); }));
    assert.equal(code, 403);
  } finally {
    server.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
