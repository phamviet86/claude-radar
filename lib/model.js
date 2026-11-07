// Pure board model: from the raw data of Claude desktop and of the running processes, derive each thread's status,
// fold child threads into their parent, and bucket finished groups by day. It never touches the disk or the real clock:
// everything is passed in.

/**
 * @typedef {'input' | 'work' | 'done'} Status
 * @typedef {{category?: string, detail?: string, needsAction?: string}} Summary
 * @typedef {{
 *   id: string, cliId?: string, title: string, path: string, folder: string, parentId?: string,
 *   starred: boolean, archived: boolean, createdAt?: number, lastActivityAt: number, summary?: Summary,
 * }} Thread
 * @typedef {{
 *   pid: number, hostId?: string, cliId?: string, status?: string, waitingFor?: string, statusUpdatedAt?: number,
 * }} RunningProcess
 * @typedef {{role: 'user' | 'assistant', text: string, at: number}} LatestMessage
 */

/** @type {Record<Status, number>} */
export const RANK = { input: 0, work: 1, done: 2 };

const WORKTREE = /[\\/]\.(?:claude|codex)[\\/]worktrees[\\/][^\\/]+$/;

/** @param {unknown} v */
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
/** @param {unknown} v */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Project folder: the session's origin folder, with worktrees folded back into the main project.
 * @param {unknown} originCwd
 * @param {unknown} cwd
 */
export function projectPath(originCwd, cwd) {
  const p = str(originCwd) ?? str(cwd) ?? '';
  return p.replace(WORKTREE, '') || p;
}

/** @param {string} path */
export function folderName(path) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * A Claude desktop local_*.json file -> thread. undefined if it is broken or has no id.
 * @param {string} raw
 * @returns {Thread | undefined}
 */
export function parseDesktopSession(raw) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return undefined; // expected: the file is being written, or the format changed
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
    title: str(j.title) ?? str(from?.title) ?? 'Untitled thread',
    path,
    folder: folderName(path),
    parentId: parent && parent !== id ? parent : undefined,
    starred: j.isStarred === true,
    archived: j.isArchived === true,
    createdAt: num(j.createdAt),
    lastActivityAt: num(j.lastActivityAt) ?? num(j.createdAt) ?? 0,
    summary:
      category || str(s?.status_detail) || str(s?.needs_action)
        ? { category, detail: str(s?.status_detail), needsAction: str(s?.needs_action) }
        : undefined,
  };
}

/**
 * A ~/.claude/sessions/<pid>.json file -> running process.
 * @param {string} raw
 * @returns {RunningProcess | undefined}
 */
export function parseRegistryEntry(raw) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return undefined; // expected: the file is being written, or the format changed
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
 * Status of one thread. Order of precedence:
 * 1. A live process: 'waiting' = waiting for you (permission, ...), 'busy'/'shell' = working. The summary at that point belongs to the previous turn.
 * 2. End-of-turn summary: blocked/review_ready = needs you, completed = done.
 * 3. Nothing else: process alive = working (no summary yet); process gone = done, flagged as having no summary.
 * @param {RunningProcess | undefined} running
 * @param {Summary | undefined} summary
 */
export function threadStatus(running, summary) {
  const text = summary?.needsAction ?? summary?.detail;
  if (running?.status === 'waiting') {
    return { status: 'input', detail: running.waitingFor ?? text, reason: 'process-waiting' };
  }
  if (running && (running.status === 'busy' || running.status === 'shell')) {
    return {
      status: 'work',
      detail: summary?.detail ?? summary?.needsAction,
      stale: !!(summary?.detail ?? summary?.needsAction),
      reason: 'process-busy',
    };
  }
  const cat = summary?.category;
  if (cat === 'blocked' || cat === 'review_ready') {
    return { status: 'input', detail: summary?.needsAction ?? summary?.detail, reason: `summary-${cat}` };
  }
  if (cat === 'completed') {
    return { status: 'done', detail: summary?.detail ?? summary?.needsAction, reason: 'summary-completed' };
  }
  if (summary && (summary.detail || summary.needsAction)) {
    return { status: 'done', detail: summary.detail ?? summary.needsAction, reason: 'summary-unknown' };
  }
  if (running) return { status: 'work', detail: undefined, nosummary: true, reason: 'process-no-summary' };
  return { status: 'done', detail: undefined, nosummary: true, reason: 'no-summary' };
}

const LINE_MAX = 240;
/** @param {string} t */
const clipLine = (t) => (t.length > LINE_MAX ? `${t.slice(0, LINE_MAX - 1).trimEnd()}…` : t);

/**
 * The text line on a card. A stopped thread shows Claude's summary (short, on point). A running thread, or one with
 * no summary, shows the latest message: the summary only exists once a turn ends, so while running it is from the previous turn.
 * @param {{status: string, detail?: string | null, latest?: LatestMessage | null}} node
 */
export function cardLine(node) {
  if (node.status !== 'work' && node.detail) return { kind: 'summary', text: clipLine(node.detail) };
  if (node.latest) return { kind: 'message', role: node.latest.role, text: node.latest.text };
  if (node.detail) return { kind: 'summary', text: clipLine(node.detail), stale: node.status === 'work' };
  return null;
}

/**
 * Merged status: needs input > working > done.
 * @param {Status[]} statuses
 */
export function worst(statuses) {
  return statuses.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
}

const DAY = 86_400_000;

/**
 * Day bucket (local time) of a timestamp.
 * @param {number} ts
 * @param {number} now
 */
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
 * @typedef {object} BoardNode One thread on the board, before and after it is folded into its parent.
 * @property {string} id
 * @property {string} title
 * @property {string} folder
 * @property {string} path
 * @property {boolean} starred
 * @property {boolean} archived
 * @property {Status} status
 * @property {string | null} detail
 * @property {boolean} stale
 * @property {boolean} nosummary
 * @property {string} reason
 * @property {boolean} running
 * @property {{pid: number, status: string | null} | null} run
 * @property {number} activityAt
 * @property {number | null} createdAt
 * @property {LatestMessage | null} latest
 * @property {string | undefined} parentId
 * @property {BoardNode[]} children
 */

/**
 * One node per visible thread, with its status derived from the matching process and summary.
 * @param {Thread[]} visible
 * @param {RunningProcess[]} registry
 * @param {Map<string, LatestMessage | null>} latest
 * @returns {Map<string, BoardNode>}
 */
function buildNodes(visible, registry, latest) {
  const runByHost = new Map();
  const runByCli = new Map();
  for (const r of registry) {
    if (r.hostId) runByHost.set(r.hostId, r);
    if (r.cliId) runByCli.set(r.cliId, r);
  }
  const known = new Set(visible.map((t) => t.id));
  const nodes = new Map();
  for (const t of visible) {
    const run = runByHost.get(t.id) ?? (t.cliId ? runByCli.get(t.cliId) : undefined);
    const st = threadStatus(run, t.summary);
    nodes.set(t.id, {
      id: t.id,
      title: t.title,
      folder: t.folder,
      path: t.path,
      starred: t.starred,
      archived: t.archived,
      status: st.status,
      detail: st.detail ?? null,
      stale: !!st.stale,
      nosummary: !!st.nosummary,
      reason: st.reason,
      running: !!run,
      run: run ? { pid: run.pid, status: run.status ?? null } : null,
      activityAt: Math.max(t.lastActivityAt, run?.statusUpdatedAt ?? 0),
      createdAt: t.createdAt ?? null,
      latest: latest.get(t.id) ?? null,
      parentId: t.parentId && known.has(t.parentId) ? t.parentId : undefined,
      children: [],
    });
  }
  return nodes;
}

/**
 * Attach each child to its parent. A child whose parent is missing, or that sits in a cycle, stands on its own.
 * @param {Map<string, BoardNode>} nodes
 */
function linkChildren(nodes) {
  /** @param {BoardNode} n */
  const isCycle = (n) => {
    const seen = new Set([n.id]);
    for (let p = n.parentId; p; p = nodes.get(p)?.parentId) {
      if (seen.has(p)) return true;
      seen.add(p);
    }
    return false;
  };
  for (const n of nodes.values()) if (n.parentId && isCycle(n)) n.parentId = undefined;
  for (const n of nodes.values()) if (n.parentId) nodes.get(n.parentId)?.children.push(n);
}

/**
 * One card per root thread, newest first.
 * @param {Map<string, BoardNode>} nodes
 * @param {number} now
 */
function groupThreads(nodes, now) {
  /** @param {BoardNode} n @returns {BoardNode[]} */
  const members = (n) => [n, ...n.children.flatMap(members)];
  const groups = [];
  for (const n of nodes.values()) {
    if (n.parentId) continue;
    const all = members(n);
    const status = worst(all.map((m) => m.status));
    // main line: from the thread that decides the merged status (the newest one if several)
    const lead = all.filter((m) => m.status === status).sort((a, b) => b.activityAt - a.activityAt)[0];
    const activityAt = Math.max(...all.map((m) => m.activityAt));
    n.children.sort((a, b) => b.activityAt - a.activityAt);
    groups.push({
      id: n.id,
      title: n.title,
      folder: n.folder,
      path: n.path,
      starred: all.some((m) => m.starred),
      status,
      detail: lead.detail,
      stale: lead.stale,
      nosummary: lead.nosummary,
      leadId: lead.id,
      activityAt,
      latest: lead.latest,
      latestFrom: lead.id === n.id ? null : lead.title,
      line: cardLine(lead),
      leadRun: lead.run,
      // the root thread's own state (the fields above describe the whole group)
      own: {
        status: n.status,
        detail: n.detail,
        stale: n.stale,
        latest: n.latest,
        activityAt: n.activityAt,
        createdAt: n.createdAt,
        run: n.run,
      },
      bucket: status === 'done' ? dayBucket(activityAt, now) : null,
      children: n.children.map((c) => ({ ...c, children: c.children.map((g) => ({ ...g, children: [] })) })),
    });
  }
  // by time, newest first; pinned threads are not moved to the top, they only carry the PINNED chip
  groups.sort((a, b) => b.activityAt - a.activityAt);
  return groups;
}

/**
 * Per-folder counts plus what is in progress and what just finished.
 * @param {ReturnType<typeof groupThreads>} groups
 */
function summarizeFolders(groups) {
  const folders = [];
  for (const path of new Set(groups.map((g) => g.path))) {
    const gs = groups.filter((g) => g.path === path);
    const count = { input: 0, work: 0, done: 0 };
    for (const g of gs) count[g.status]++;
    folders.push({
      folder: folderName(path),
      path,
      count,
      doing: gs
        .filter((g) => g.status !== 'done' && g.detail)
        .map((g) => ({ id: g.id, title: g.title, status: g.status, detail: g.detail })),
      done: gs
        .filter((g) => g.status === 'done' && g.detail)
        .slice(0, 5)
        .map((g) => ({ id: g.id, title: g.title, detail: g.detail, activityAt: g.activityAt })),
    });
  }
  // folders that need you first, then folders that are running, then by name
  const urgency = (/** @type {{count: {input: number, work: number}}} */ f) => (f.count.input ? 0 : f.count.work ? 1 : 2);
  folders.sort((a, b) => urgency(a) - urgency(b) || a.folder.localeCompare(b.folder));
  return folders;
}

/**
 * Data for the page.
 * @param {{
 *   desktop: Thread[], registry: RunningProcess[], now: number, includeArchived?: boolean,
 *   latest?: Map<string, LatestMessage | null>,
 * }} input
 */
export function buildBoard({ desktop, registry, now, includeArchived = false, latest = new Map() }) {
  const visible = desktop.filter((t) => includeArchived || !t.archived);
  const nodes = buildNodes(visible, registry, latest);
  linkChildren(nodes);
  const groups = groupThreads(nodes, now);
  return { generatedAt: now, groups, folders: summarizeFolders(groups) };
}
