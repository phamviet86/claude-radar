import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, dayBucket, parseDesktopSession, parseRegistryEntry, projectPath, threadStatus, worst } from '../lib/model.js';

const NOW = new Date(2026, 10, 7, 12, 0, 0).getTime();
const H = 3_600_000;
const D = 24 * H;

const sum = (category, detail, needsAction) => ({ category, detail, needsAction });
const run = (status, extra = {}) => ({ pid: 1, status, ...extra });

test('trạng thái: tiến trình đang chạy thắng tóm tắt cũ', () => {
  assert.equal(threadStatus(run('busy'), sum('completed', 'xong lượt trước')).status, 'work');
  assert.equal(threadStatus(run('busy'), sum('blocked', undefined, 'hỏi gì đó')).status, 'work');
  assert.equal(threadStatus(run('shell'), sum('completed', 'x')).status, 'work');
  assert.equal(threadStatus(run('busy'), sum('completed', 'x')).stale, true);
});

test('trạng thái: tiến trình chờ bạn (cấp quyền) là cần input, kèm lý do', () => {
  const r = threadStatus(run('waiting', { waitingFor: 'approve Bash' }), sum('completed', 'x'));
  assert.equal(r.status, 'input');
  assert.equal(r.detail, 'approve Bash');
});

test('trạng thái: tóm tắt cuối lượt khi tiến trình rảnh hoặc đã tắt', () => {
  for (const r of [undefined, run('idle')]) {
    assert.equal(threadStatus(r, sum('blocked', undefined, 'Anh muốn commit không?')).status, 'input');
    assert.equal(threadStatus(r, sum('blocked', undefined, 'Anh muốn commit không?')).detail, 'Anh muốn commit không?');
    assert.equal(threadStatus(r, sum('review_ready', 'đã xong, xem lại')).status, 'input');
    assert.equal(threadStatus(r, sum('completed', 'làm xong X')).status, 'done');
    assert.equal(threadStatus(r, sum('completed', 'làm xong X')).detail, 'làm xong X');
    assert.equal(threadStatus(r, sum('loại-lạ', 'có chữ')).status, 'done');
  }
});

test('trạng thái: không có tóm tắt', () => {
  const live = threadStatus(run('idle'), undefined);
  assert.equal(live.status, 'work');
  assert.equal(live.nosummary, true);
  const dead = threadStatus(undefined, undefined);
  assert.equal(dead.status, 'done');
  assert.equal(dead.nosummary, true);
});

test('worst: cần input > đang làm > xong', () => {
  assert.equal(worst(['done', 'work', 'input']), 'input');
  assert.equal(worst(['done', 'work']), 'work');
  assert.equal(worst(['done', 'done']), 'done');
});

test('dayBucket theo giờ địa phương', () => {
  assert.equal(dayBucket(NOW - 2 * H, NOW), 'today');
  assert.equal(dayBucket(new Date(2026, 10, 6, 23, 0).getTime(), NOW), 'yesterday');
  assert.equal(dayBucket(NOW - 3 * D, NOW), 'week');
  assert.equal(dayBucket(NOW - 9 * D, NOW), 'older');
});

test('parseDesktopSession: lấy đúng trường, gộp worktree, bỏ tệp hỏng', () => {
  const t = parseDesktopSession(JSON.stringify({
    sessionId: 'local_a', cliSessionId: 'cli-a', title: 'Việc A', originCwd: '/p/proj/.claude/worktrees/x', cwd: '/p/proj/.claude/worktrees/x',
    isStarred: true, isArchived: false, lastActivityAt: 5, spawnedFrom: { sessionId: 'local_m' },
    postTurnSummary: { status_category: 'blocked', status_detail: '', needs_action: 'Hỏi?' },
  }));
  assert.equal(t.id, 'local_a');
  assert.equal(t.path, '/p/proj');
  assert.equal(t.folder, 'proj');
  assert.equal(t.parentId, 'local_m');
  assert.equal(t.starred, true);
  assert.deepEqual(t.summary, { category: 'blocked', detail: undefined, needsAction: 'Hỏi?' });
  assert.equal(parseDesktopSession('{hỏng'), undefined);
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

const t = (id, over = {}) => ({ id, title: id, path: '/w/p', folder: 'p', starred: false, archived: false, lastActivityAt: NOW - H, summary: sum('completed', `kq ${id}`), ...over });

test('buildBoard: thread con gộp vào thẻ mẹ, trạng thái gộp theo cả nhóm', () => {
  const desktop = [t('m'), t('c', { parentId: 'm' })];
  // cả hai xong -> nhóm xong
  let b = buildBoard({ desktop, registry: [], now: NOW });
  assert.equal(b.groups.length, 1);
  assert.equal(b.groups[0].status, 'done');
  assert.equal(b.groups[0].children.length, 1);
  // con đang chạy -> cả nhóm đang làm dù mẹ đã xong
  b = buildBoard({ desktop, registry: [{ pid: 1, hostId: 'c', status: 'busy' }], now: NOW });
  assert.equal(b.groups[0].status, 'work');
  assert.equal(b.groups[0].leadId, 'c');
  // mẹ cần input, con đang chạy -> cần input thắng
  b = buildBoard({ desktop: [t('m', { summary: sum('blocked', undefined, 'Hỏi?') }), t('c', { parentId: 'm' })], registry: [{ pid: 1, hostId: 'c', status: 'busy' }], now: NOW });
  assert.equal(b.groups[0].status, 'input');
  assert.equal(b.groups[0].detail, 'Hỏi?');
});

test('buildBoard: mẹ thiếu hoặc đã lưu trữ -> con đứng riêng; vòng lặp không treo', () => {
  let b = buildBoard({ desktop: [t('c', { parentId: 'ghost' })], registry: [], now: NOW });
  assert.equal(b.groups.length, 1);
  b = buildBoard({ desktop: [t('m', { archived: true }), t('c', { parentId: 'm' })], registry: [], now: NOW });
  assert.deepEqual(b.groups.map((g) => g.id), ['c']);
  b = buildBoard({ desktop: [t('a', { parentId: 'b' }), t('b', { parentId: 'a' })], registry: [], now: NOW });
  assert.ok(b.groups.length >= 1);
});

test('buildBoard: ghim lên đầu, nhóm ngày chỉ cho thread xong', () => {
  const desktop = [t('x', { lastActivityAt: NOW - 20 * D }), t('y', { lastActivityAt: NOW - H }), t('z', { starred: true, lastActivityAt: NOW - 5 * D })];
  const b = buildBoard({ desktop, registry: [], now: NOW });
  assert.deepEqual(b.groups.map((g) => g.id), ['z', 'y', 'x']);
  assert.deepEqual(b.groups.map((g) => g.bucket), ['week', 'today', 'older']);
  const busy = buildBoard({ desktop: [t('w')], registry: [{ pid: 1, hostId: 'w', status: 'busy' }], now: NOW });
  assert.equal(busy.groups[0].bucket, null);
});

test('buildBoard: nối tiến trình theo hostSessionId rồi theo sessionId của CLI', () => {
  const b = buildBoard({ desktop: [t('a', { cliId: 'cli-a' })], registry: [{ pid: 1, cliId: 'cli-a', status: 'busy' }], now: NOW });
  assert.equal(b.groups[0].status, 'work');
});

test('buildBoard: tóm tắt theo thư mục', () => {
  const desktop = [t('a', { summary: sum('blocked', undefined, 'Hỏi?') }), t('b'), t('c', { path: '/w/q', folder: 'q' })];
  const b = buildBoard({ desktop, registry: [], now: NOW });
  assert.equal(b.folders[0].folder, 'p');
  assert.deepEqual(b.folders[0].count, { input: 1, work: 0, done: 1 });
  assert.equal(b.folders[0].doing[0].detail, 'Hỏi?');
  assert.equal(b.folders[0].done[0].detail, 'kq b');
});

test('projectPath', () => {
  assert.equal(projectPath('/a/b', '/a/b/c'), '/a/b');
  assert.equal(projectPath(undefined, '/a/b'), '/a/b');
});
