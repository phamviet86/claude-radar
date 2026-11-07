// Mô hình thuần của bảng: từ dữ liệu thô của Claude desktop và của tiến trình đang chạy suy ra trạng thái từng thread,
// gộp thread con vào thread cha, và chia nhóm "xong" theo ngày. Không đụng đến đĩa hay thời gian thật: mọi thứ truyền vào.

export const RANK = { input: 0, work: 1, done: 2 };

const WORKTREE = /[\\/]\.(?:claude|codex)[\\/]worktrees[\\/][^\\/]+$/;

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Thư mục của dự án: thư mục gốc của phiên, gộp worktree về dự án chính. */
export function projectPath(originCwd, cwd) {
  const p = str(originCwd) ?? str(cwd) ?? '';
  return p.replace(WORKTREE, '') || p;
}

export function folderName(path) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Tệp local_*.json của Claude desktop -> thread. undefined nếu hỏng hoặc thiếu id. */
export function parseDesktopSession(raw) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!j || typeof j !== 'object') return undefined;
  const id = str(j.sessionId);
  if (!id) return undefined;
  const path = projectPath(j.originCwd, j.cwd);
  const from = j.spawnedFrom && typeof j.spawnedFrom === 'object' ? j.spawnedFrom : undefined;
  const parent = str(from?.sessionId);
  const s = j.postTurnSummary && typeof j.postTurnSummary === 'object' ? j.postTurnSummary : undefined;
  const category = str(s?.status_category);
  return {
    id,
    cliId: str(j.cliSessionId),
    title: str(j.title) ?? str(from?.title) ?? 'Thread không tên',
    path,
    folder: folderName(path),
    parentId: parent && parent !== id ? parent : undefined,
    starred: j.isStarred === true,
    archived: j.isArchived === true,
    createdAt: num(j.createdAt),
    lastActivityAt: num(j.lastActivityAt) ?? num(j.createdAt) ?? 0,
    summary: category || str(s?.status_detail) || str(s?.needs_action)
      ? { category, detail: str(s?.status_detail), needsAction: str(s?.needs_action) }
      : undefined,
  };
}

/** Tệp ~/.claude/sessions/<pid>.json -> tiến trình đang chạy. */
export function parseRegistryEntry(raw) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!j || typeof j !== 'object') return undefined;
  const pid = num(j.pid);
  if (pid === undefined) return undefined;
  return {
    pid,
    hostId: str(j.hostSessionId),
    cliId: str(j.sessionId),
    status: str(j.status),
    waitingFor: str(j.waitingFor),
    statusUpdatedAt: num(j.statusUpdatedAt),
  };
}

/**
 * Trạng thái của một thread. Thứ tự ưu tiên:
 * 1. Tiến trình đang chạy: 'waiting' = chờ bạn (cấp quyền...), 'busy'/'shell' = đang làm. Tóm tắt khi đó là của lượt trước.
 * 2. Tóm tắt cuối lượt: blocked/review_ready = cần bạn, completed = xong.
 * 3. Không có gì: tiến trình còn sống = đang làm (chưa có tóm tắt); đã tắt = xong, ghi rõ chưa có tóm tắt.
 */
export function threadStatus(running, summary) {
  const text = summary?.needsAction ?? summary?.detail;
  if (running?.status === 'waiting') {
    return { status: 'input', detail: running.waitingFor ?? text, reason: 'process-waiting' };
  }
  if (running && (running.status === 'busy' || running.status === 'shell')) {
    return { status: 'work', detail: summary?.detail ?? summary?.needsAction, stale: !!(summary?.detail ?? summary?.needsAction), reason: 'process-busy' };
  }
  const cat = summary?.category;
  if (cat === 'blocked' || cat === 'review_ready') {
    return { status: 'input', detail: summary.needsAction ?? summary.detail, reason: `summary-${cat}` };
  }
  if (cat === 'completed') return { status: 'done', detail: summary.detail ?? summary.needsAction, reason: 'summary-completed' };
  if (summary && (summary.detail || summary.needsAction)) {
    return { status: 'done', detail: summary.detail ?? summary.needsAction, reason: 'summary-unknown' };
  }
  if (running) return { status: 'work', detail: undefined, nosummary: true, reason: 'process-no-summary' };
  return { status: 'done', detail: undefined, nosummary: true, reason: 'no-summary' };
}

/** Trạng thái gộp: cần input > đang làm > xong. */
export function worst(statuses) {
  return statuses.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
}

const DAY = 86_400_000;

/** Nhóm ngày (giờ địa phương) của một thời điểm. */
export function dayBucket(ts, now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  if (ts >= today) return 'today';
  if (ts >= today - DAY) return 'yesterday';
  if (ts >= today - 6 * DAY) return 'week';
  return 'older';
}

/**
 * Dữ liệu cho trang.
 * @param {{desktop: object[], registry: object[], now: number, includeArchived?: boolean}} input
 */
export function buildBoard({ desktop, registry, now, includeArchived = false }) {
  const runByHost = new Map();
  const runByCli = new Map();
  for (const r of registry) {
    if (r.hostId) runByHost.set(r.hostId, r);
    if (r.cliId) runByCli.set(r.cliId, r);
  }
  const visible = desktop.filter((t) => includeArchived || !t.archived);
  const known = new Set(visible.map((t) => t.id));

  const nodes = new Map();
  for (const t of visible) {
    const run = runByHost.get(t.id) ?? (t.cliId ? runByCli.get(t.cliId) : undefined);
    const st = threadStatus(run, t.summary);
    const at = Math.max(t.lastActivityAt, run?.statusUpdatedAt ?? 0);
    nodes.set(t.id, {
      id: t.id, title: t.title, folder: t.folder, path: t.path, starred: t.starred, archived: t.archived,
      status: st.status, detail: st.detail ?? null, stale: !!st.stale, nosummary: !!st.nosummary, reason: st.reason,
      running: !!run, activityAt: at, createdAt: t.createdAt ?? null, parentId: t.parentId && known.has(t.parentId) ? t.parentId : undefined, children: [],
    });
  }
  // thread con có mẹ trong danh sách vào thẻ mẹ; vòng lặp hoặc mẹ thiếu: đứng riêng
  const isCycle = (n) => {
    const seen = new Set([n.id]);
    for (let p = n.parentId; p; p = nodes.get(p)?.parentId) {
      if (seen.has(p)) return true;
      seen.add(p);
    }
    return false;
  };
  for (const n of nodes.values()) if (n.parentId && isCycle(n)) n.parentId = undefined;
  for (const n of nodes.values()) if (n.parentId) nodes.get(n.parentId).children.push(n);

  const members = (n) => [n, ...n.children.flatMap(members)];
  const groups = [];
  for (const n of nodes.values()) {
    if (n.parentId) continue;
    const all = members(n);
    const status = worst(all.map((m) => m.status));
    // dòng chính: của thread quyết định trạng thái gộp (mới nhất nếu nhiều)
    const lead = all.filter((m) => m.status === status).sort((a, b) => b.activityAt - a.activityAt)[0];
    const activityAt = Math.max(...all.map((m) => m.activityAt));
    n.children.sort((a, b) => b.activityAt - a.activityAt);
    groups.push({
      id: n.id, title: n.title, folder: n.folder, path: n.path, starred: all.some((m) => m.starred), status,
      detail: lead.detail, stale: lead.stale, nosummary: lead.nosummary, leadId: lead.id, activityAt,
      bucket: status === 'done' ? dayBucket(activityAt, now) : null,
      children: n.children.map((c) => ({ ...c, children: c.children.map((g) => ({ ...g, children: [] })) })),
    });
  }
  groups.sort((a, b) => Number(b.starred) - Number(a.starred) || b.activityAt - a.activityAt);

  const folders = [];
  for (const path of [...new Set(groups.map((g) => g.path))]) {
    const gs = groups.filter((g) => g.path === path);
    const count = { input: 0, work: 0, done: 0 };
    for (const g of gs) count[g.status]++;
    folders.push({
      folder: folderName(path), path, count,
      doing: gs.filter((g) => g.status !== 'done' && g.detail).map((g) => ({ id: g.id, title: g.title, status: g.status, detail: g.detail })),
      done: gs.filter((g) => g.status === 'done' && g.detail).slice(0, 5).map((g) => ({ id: g.id, title: g.title, detail: g.detail, activityAt: g.activityAt })),
    });
  }
  // dự án cần bạn lên đầu, rồi dự án đang chạy, rồi theo tên
  const urgency = (f) => (f.count.input ? 0 : f.count.work ? 1 : 2);
  folders.sort((a, b) => urgency(a) - urgency(b) || a.folder.localeCompare(b.folder));
  return { generatedAt: now, groups, folders };
}
