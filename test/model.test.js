import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, dayBucket, parseDesktopSession, parseRegistryEntry, projectPath, threadStatus, worst } from '../lib/model.js';

const NOW = new Date(2026, 10, 7, 12, 0, 0).getTime();
const H = 3_600_000;
const D = 24 * H;

const sum = (category, detail, needsAction) => ({ category, detail, needsAction });
const run = (status, extra = {}) => ({ pid: 1, status, ...extra });

test('status: a running process wins over an old summary', () => {
  assert.equal(threadStatus(run('busy'), sum('completed', 'finished last turn')).status, 'work');
  assert.equal(threadStatus(run('busy'), sum('blocked', undefined, 'asking something')).status, 'work');
  assert.equal(threadStatus(run('shell'), sum('completed', 'x')).status, 'work');
  assert.equal(threadStatus(run('busy'), sum('completed', 'x')).stale, true);
});

test('status: a process waiting for you (permission) needs input, with the reason', () => {
  const r = threadStatus(run('waiting', { waitingFor: 'approve Bash' }), sum('completed', 'x'));
  assert.equal(r.status, 'input');
  assert.equal(r.detail, 'approve Bash');
});

test('status: end-of-turn summary when the process is idle or gone', () => {
  for (const r of [undefined, run('idle')]) {
    assert.equal(threadStatus(r, sum('blocked', undefined, 'Do you want to commit?')).status, 'input');
    assert.equal(threadStatus(r, sum('blocked', undefined, 'Do you want to commit?')).detail, 'Do you want to commit?');
    assert.equal(threadStatus(r, sum('review_ready', 'done, please review')).status, 'input');
    assert.equal(threadStatus(r, sum('completed', 'finished X')).status, 'done');
    assert.equal(threadStatus(r, sum('completed', 'finished X')).detail, 'finished X');
    assert.equal(threadStatus(r, sum('unknown-kind', 'has text')).status, 'done');
  }
});

test('status: no summary', () => {
  const live = threadStatus(run('idle'), undefined);
  assert.equal(live.status, 'work');
  assert.equal(live.nosummary, true);
  const dead = threadStatus(undefined, undefined);
  assert.equal(dead.status, 'done');
  assert.equal(dead.nosummary, true);
});

test('worst: needs input > working > done', () => {
  assert.equal(worst(['done', 'work', 'input']), 'input');
  assert.equal(worst(['done', 'work']), 'work');
  assert.equal(worst(['done', 'done']), 'done');
});

test('dayBucket uses local time', () => {
  assert.equal(dayBucket(NOW - 2 * H, NOW), 'today');
  assert.equal(dayBucket(new Date(2026, 10, 6, 23, 0).getTime(), NOW), 'yesterday');
  assert.equal(dayBucket(NOW - 3 * D, NOW), 'week');
  assert.equal(dayBucket(NOW - 9 * D, NOW), 'older');
});

test('parseDesktopSession: picks the right fields, folds worktrees, ignores broken files', () => {
  const t = parseDesktopSession(JSON.stringify({
    sessionId: 'local_a', cliSessionId: 'cli-a', title: 'Task A', originCwd: '/p/proj/.claude/worktrees/x', cwd: '/p/proj/.claude/worktrees/x',
    isStarred: true, isArchived: false, lastActivityAt: 5, spawnedFrom: { sessionId: 'local_m' },
    postTurnSummary: { status_category: 'blocked', status_detail: '', needs_action: 'Question?' },
  }));
  assert.equal(t.id, 'local_a');
  assert.equal(t.path, '/p/proj');
  assert.equal(t.folder, 'proj');
  assert.equal(t.parentId, 'local_m');
  assert.equal(t.starred, true);
  assert.deepEqual(t.summary, { category: 'blocked', detail: undefined, needsAction: 'Question?' });
  assert.equal(parseDesktopSession('{broken'), undefined);
  assert.equal(parseDesktopSession('{}'), undefined);
  assert.equal(parseDesktopSession(JSON.stringify({ sessionId: 'local_b', spawnedFrom: { sessionId: 'local_b' } })).parentId, undefined);
});

test('parseRegistryEntry', () => {
  const r = parseRegistryEntry(JSON.stringify({ pid: 7, hostSessionId: 'local_a', sessionId: 'cli-a', status: 'waiting', waitingFor: 'x' }));
  assert.equal(r.hostId, 'local_a');
  assert.equal(r.status, 'waiting');
  assert.equal(parseRegistryEntry('{}'), undefined);
  assert.equal(parseRegistryEntry('nope'), undefined);
});

const t = (id, over = {}) => ({ id, title: id, path: '/w/p', folder: 'p', starred: false, archived: false, lastActivityAt: NOW - H, summary: sum('completed', `result ${id}`), ...over });

test('buildBoard: child threads fold into the parent card, status merges across the group', () => {
  const desktop = [t('m'), t('c', { parentId: 'm' })];
  // both done -> group done
  let b = buildBoard({ desktop, registry: [], now: NOW });
  assert.equal(b.groups.length, 1);
  assert.equal(b.groups[0].status, 'done');
  assert.equal(b.groups[0].children.length, 1);
  // child running -> whole group working even though the parent is done
  b = buildBoard({ desktop, registry: [{ pid: 1, hostId: 'c', status: 'busy' }], now: NOW });
  assert.equal(b.groups[0].status, 'work');
  assert.equal(b.groups[0].leadId, 'c');
  // parent needs input, child running -> needs input wins
  b = buildBoard({ desktop: [t('m', { summary: sum('blocked', undefined, 'Question?') }), t('c', { parentId: 'm' })], registry: [{ pid: 1, hostId: 'c', status: 'busy' }], now: NOW });
  assert.equal(b.groups[0].status, 'input');
  assert.equal(b.groups[0].detail, 'Question?');
});

test('buildBoard: parent missing or archived -> child stands alone; a cycle does not hang', () => {
  let b = buildBoard({ desktop: [t('c', { parentId: 'ghost' })], registry: [], now: NOW });
  assert.equal(b.groups.length, 1);
  b = buildBoard({ desktop: [t('m', { archived: true }), t('c', { parentId: 'm' })], registry: [], now: NOW });
  assert.deepEqual(b.groups.map((g) => g.id), ['c']);
  b = buildBoard({ desktop: [t('a', { parentId: 'b' }), t('b', { parentId: 'a' })], registry: [], now: NOW });
  assert.ok(b.groups.length >= 1);
});

test('buildBoard: ordered by time (pinned does not go first), day buckets only for finished threads', () => {
  const desktop = [t('x', { lastActivityAt: NOW - 20 * D }), t('y', { lastActivityAt: NOW - H }), t('z', { starred: true, lastActivityAt: NOW - 5 * D })];
  const b = buildBoard({ desktop, registry: [], now: NOW });
  assert.deepEqual(b.groups.map((g) => g.id), ['y', 'z', 'x']);
  assert.deepEqual(b.groups.map((g) => g.bucket), ['today', 'week', 'older']);
  assert.equal(b.groups.find((g) => g.id === 'z').starred, true); // still marked as pinned
  const busy = buildBoard({ desktop: [t('w')], registry: [{ pid: 1, hostId: 'w', status: 'busy' }], now: NOW });
  assert.equal(busy.groups[0].bucket, null);
});

test('buildBoard: matches a process by hostSessionId, then by the CLI sessionId', () => {
  const b = buildBoard({ desktop: [t('a', { cliId: 'cli-a' })], registry: [{ pid: 1, cliId: 'cli-a', status: 'busy' }], now: NOW });
  assert.equal(b.groups[0].status, 'work');
});

test('buildBoard: per-folder summary', () => {
  const desktop = [t('a', { summary: sum('blocked', undefined, 'Question?') }), t('b'), t('c', { path: '/w/q', folder: 'q' })];
  const b = buildBoard({ desktop, registry: [], now: NOW });
  assert.equal(b.folders[0].folder, 'p');
  assert.deepEqual(b.folders[0].count, { input: 1, work: 0, done: 1 });
  assert.equal(b.folders[0].doing[0].detail, 'Question?');
  assert.equal(b.folders[0].done[0].detail, 'result b');
});

test('projectPath', () => {
  assert.equal(projectPath('/a/b', '/a/b/c'), '/a/b');
  assert.equal(projectPath(undefined, '/a/b'), '/a/b');
});

test('buildBoard: the latest message comes from the thread that decides the group status', () => {
  const desktop = [t('m'), t('c', { parentId: 'm' })];
  const latest = new Map([['m', { role: 'assistant', at: 1, text: 'parent message' }], ['c', { role: 'assistant', at: 2, text: 'child message' }]]);
  let b = buildBoard({ desktop, registry: [], now: NOW, latest });
  assert.equal(b.groups[0].latest.text, 'parent message'); // both done: take the thread with the newest activity
  b = buildBoard({ desktop, registry: [{ pid: 1, hostId: 'c', status: 'busy' }], now: NOW, latest });
  assert.equal(b.groups[0].latest.text, 'child message');
  assert.equal(b.groups[0].latestFrom, 'c');
  assert.equal(buildBoard({ desktop: [t('x')], registry: [], now: NOW }).groups[0].latest, null);
});

import { cardLine } from '../lib/model.js';

test('cardLine: stopped shows the summary; running or without a summary shows the latest message', () => {
  const msg = { role: 'assistant', at: 1, text: 'last message' };
  assert.deepEqual(cardLine({ status: 'done', detail: 'summary', latest: msg }), { kind: 'summary', text: 'summary' });
  assert.deepEqual(cardLine({ status: 'input', detail: 'Question?', latest: msg }), { kind: 'summary', text: 'Question?' });
  assert.deepEqual(cardLine({ status: 'work', detail: 'old', latest: msg }), { kind: 'message', role: 'assistant', text: 'last message' });
  assert.deepEqual(cardLine({ status: 'done', detail: undefined, latest: msg }), { kind: 'message', role: 'assistant', text: 'last message' });
  assert.deepEqual(cardLine({ status: 'work', detail: 'old', latest: null }), { kind: 'summary', text: 'old', stale: true });
  assert.equal(cardLine({ status: 'done', detail: undefined, latest: null }), null);
  assert.ok(cardLine({ status: 'done', detail: 'x'.repeat(500) }).text.length <= 240);
});

test('buildBoard: the group line follows the thread that decides the status', () => {
  const desktop = [t('m'), t('c', { parentId: 'm' })];
  const latest = new Map([['c', { role: 'assistant', at: 2, text: 'child working' }]]);
  let b = buildBoard({ desktop, registry: [], now: NOW, latest });
  assert.equal(b.groups[0].line.kind, 'summary');
  b = buildBoard({ desktop, registry: [{ pid: 1, hostId: 'c', status: 'busy' }], now: NOW, latest });
  assert.deepEqual(b.groups[0].line, { kind: 'message', role: 'assistant', text: 'child working' });
});

test('buildBoard: own keeps the root thread\'s state even when the group is working because of a child', () => {
  const desktop = [t('m'), t('c', { parentId: 'm' })];
  const b = buildBoard({ desktop, registry: [{ pid: 1, hostId: 'c', status: 'busy' }], now: NOW });
  assert.equal(b.groups[0].status, 'work');
  assert.equal(b.groups[0].own.status, 'done');
  assert.equal(b.groups[0].own.detail, 'result m');
});

test('buildBoard: process info (pid, status) comes with a running thread', () => {
  const desktop = [t('m'), t('c', { parentId: 'm' })];
  const b = buildBoard({ desktop, registry: [{ pid: 4242, hostId: 'c', status: 'busy' }], now: NOW });
  assert.deepEqual(b.groups[0].leadRun, { pid: 4242, status: 'busy' });
  assert.deepEqual(b.groups[0].children[0].run, { pid: 4242, status: 'busy' });
  assert.equal(b.groups[0].own.status, 'done');
  assert.equal(buildBoard({ desktop: [t('x')], registry: [], now: NOW }).groups[0].leadRun, null);
});
