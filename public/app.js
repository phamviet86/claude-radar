// Read-only UI: fetches /api/board every 5 seconds and updates by thread id (keeps the existing DOM, never redraws the whole list).
// A single grid of cards, left to right: needs input first, then running, then done. Each card is tinted by its status.
// A card that changes status slides to its new position (FLIP) and flashes briefly. Click a card to see its timeline.
const STATUS_META = {
  input: { name: 'Needs input', icon: 'circle-alert', c: 'var(--input)' },
  work: { name: 'Running', icon: 'circle-dot', c: 'var(--work)' },
  done: { name: 'Done', icon: 'circle-check', c: 'var(--done)' },
};
const RANGES = [['1d', 'Today'], ['3d', '3 days'], ['all', 'All']];
const ORDER = { input: 0, work: 1, done: 2 };
const DONE_CAP = 24;
const THEMES = [['auto', 'Auto', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']];
const POLL_MS = 5000;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ui = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${LUCIDE_UI[name] ?? ''}</svg>`;
document.querySelectorAll('svg[data-ic]').forEach((s) => { s.innerHTML = LUCIDE_UI[s.dataset.ic] ?? ''; });
const prefersReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = { booted: false, tab: 'board', folder: 'all', theme: 'auto', range: '3d', status: 'all', pinned: false, more: false, sel: null, member: null, timeline: null, data: null, raw: '', pick: new Set() };
try {
  const saved = JSON.parse(localStorage.getItem('thread-board') || '{}');
  for (const k of ['tab', 'folder', 'theme', 'range', 'status']) if (typeof saved[k] === 'string') state[k] = saved[k];
  state.pinned = saved.pinned === true;
  if (!RANGES.some((r) => r[0] === state.range)) state.range = '3d';
  if (!['all', 'input', 'work', 'done'].includes(state.status)) state.status = 'all';
} catch { /* no localStorage: use the defaults */ }
const save = () => {
  try {
    localStorage.setItem('thread-board', JSON.stringify({ tab: state.tab, folder: state.folder, theme: state.theme, range: state.range, status: state.status, pinned: state.pinned }));
  } catch { /* ignore */ }
};

/* ---- time ---- */
function ago(ts, short = false) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (short) return m < 2 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  if (m < 2) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}
function clock(ts) {
  const d = new Date(ts), t = new Date();
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === t.toDateString() ? hm : `${d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' })} ${hm}`;
}
function span(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1).replace('.0', '')} h`;
}

/* ---- project tags: a Lucide icon and color per folder; stable by name, unique across the folders present ---- */
const ICON_NAMES = Object.keys(LUCIDE);
const hash = (s) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h; };
let tags = new Map();
function assignTags(paths) {
  const key = paths.join('|');
  if (tags.key === key) return;
  const next = new Map(), used = new Set();
  const byHash = [...paths].sort((a, b) => hash(a) - hash(b));
  byHash.forEach((p, n) => next.set(p, { icon: -1, hue: Math.round((n * 360) / byHash.length + 24) % 360 }));
  for (const p of [...paths].sort()) {
    let i = hash(p) % ICON_NAMES.length;
    while (used.has(i) && used.size < ICON_NAMES.length) i = (i + 1) % ICON_NAMES.length;
    used.add(i);
    next.get(p).icon = i;
  }
  next.key = key;
  tags = next;
}
const tagEl = (path) => {
  const t = tags.get(path) ?? { icon: hash(path) % ICON_NAMES.length, hue: hash(`${path}#`) % 360 };
  return `<span class="tg" style="--tc:hsl(${t.hue} 62% 46%)" aria-hidden="true"><svg viewBox="0 0 24 24">${LUCIDE[ICON_NAMES[t.icon]]}</svg></span>`;
};

/* ---- open a thread in Claude desktop ---- */
const openUrl = (id) => `claude://code/continue?session=${encodeURIComponent(id)}`;
const openLink = (id, label) => `<a class="open" href="${esc(openUrl(id))}" title="Open this thread in Claude desktop">${label}${ui('external-link')}</a>`;

const groups = () => state.data?.groups ?? [];
const members = (g) => [g, ...g.children.flatMap((c) => [c, ...c.children])];
const findGroup = (id) => groups().find((g) => members(g).some((m) => m.id === id));

/* ---- cards ---- */
function lineHtml(g) {
  const l = g.line;
  if (!l) return '<p class="sum nosum">No messages yet</p>';
  const from = g.latestFrom ? (g.latestFrom.length > 28 ? `${g.latestFrom.slice(0, 27)}…` : g.latestFrom) : '';
  const who = from ? `<span class="from">${esc(from)}</span>` : l.kind === 'message' && l.role === 'user' ? '<span class="from">You</span>' : l.stale ? '<span class="from">Previous turn</span>' : '';
  return `<p class="sum">${who}${esc(l.text)}</p>`;
}
function cardHtml(g) {
  const ks = g.children;
  const kids = g.status !== 'done' && ks.length
    ? `<ul class="kids">${ks.map((c) => `<li><button class="kid-btn" data-id="${esc(c.id)}" style="--c:${STATUS_META[c.status].c}">${ui('corner-down-right')}<span class="kt">${esc(c.title)}</span>${c.folder !== g.folder ? `<span class="kf">${esc(c.folder)}</span>` : ''}<span class="ks">${STATUS_META[c.status].name}</span></button></li>`).join('')}</ul>`
    : '';
  // child threads sit right under the summary (listed one by one while the group is not done)
  const count = g.status === 'done' && ks.length ? `<span class="badge kc">+${ks.length} thread</span>` : '';
  const pin = g.status !== 'input' && g.starred ? `<span class="pin">${ui('pin')}PINNED</span>` : '';
  // needs input: the full "Open in Claude" button (opens the exact thread that is waiting); otherwise just an icon button. Both sit to the left of the time.
  const open = g.status === 'input'
    ? openLink(g.leadId, 'Open in Claude')
    : `<a class="open-sm" href="${esc(openUrl(g.id))}" aria-label="Open &quot;${esc(g.title)}&quot; in Claude" title="Open in Claude">${ui('external-link')}</a>`;
  const run = g.status === 'work' && g.leadRun ? `<span class="runchip"><i class="led"></i>PID ${g.leadRun.pid}</span>` : '';
  const head = `<div class="chead"><span class="cs">${ui(STATUS_META[g.status].icon)}${{ input: 'NEEDS INPUT', work: 'RUNNING', done: 'DONE' }[g.status]}</span><span class="cid proj">${tagEl(g.path)}<span class="pn">${esc(g.folder)}</span></span></div>`;
  return `${head}<button class="main" data-id="${esc(g.id)}"><span class="title">${esc(g.title)}</span>${lineHtml(g)}</button>${kids}
    <div class="foot"><div class="fr-act">${open}${pin}${count}${run || `<time data-at="${g.activityAt}"></time>`}</div></div>`;
}

const els = new Map();
function flash(el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
/** Start (ms) of the selected time range; finished threads older than this are hidden. Needs-input and running threads always show. */
function cutoff() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return { '1d': d.getTime(), '3d': Date.now() - 3 * 86400000, all: 0 }[state.range];
}
/** Cards of the board: filtered by project, status and time range (finished threads only); needs input first, then running, then done. */
function boardList() {
  const from = cutoff();
  return groups()
    .filter((g) => (state.folder === 'all' || g.path === state.folder) && (!state.pinned || g.starred) && (state.status === 'all' || g.status === state.status) && (g.status !== 'done' || g.activityAt >= from))
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.activityAt - a.activityAt);
}

function messageEl(text) {
  const el = document.createElement('div');
  el.className = 'empty';
  el.textContent = text;
  return el;
}

/** Updates the grid by thread id. quiet = no effects (first render, filter change). */
function sync(quiet) {
  const all = groups();
  const list = boardList();
  const host = $('#flow');

  const first = new Map();
  for (const [id, el] of els) if (el.isConnected) first.set(id, el.getBoundingClientRect());

  // first render that has cards: a short "power-on" sequence
  const booting = !state.booted && list.length > 0;
  if (booting) { state.booted = true; host.classList.add('boot'); setTimeout(() => host.classList.remove('boot'), 1400); }
  const seen = new Set();
  const frag = [];
  const doneTotal = list.filter((g) => g.status === 'done').length;
  let doneShown = 0;
  for (const g of list) {
    seen.add(g.id);
    let el = els.get(g.id), fresh = false;
    if (!el) { el = document.createElement('article'); el.className = 'card'; els.set(g.id, el); fresh = true; }
    const html = cardHtml(g), sig = `${g.status}|${html}`;
    if (el.dataset.sig !== sig) {
      const changed = el.dataset.s && el.dataset.s !== g.status;
      el.innerHTML = html;
      el.dataset.sig = sig;
      el.dataset.s = g.status;
      if (changed && !quiet) flash(el);
    }
    if (g.status === 'done') {
      if (!state.more && doneShown >= DONE_CAP) continue;
      doneShown++;
    }
    frag.push(el);
    if (!quiet || booting) el.style.setProperty('--i', String(frag.length - 1));
    if (fresh && !quiet) el.classList.add('enter');
  }
  if (doneTotal > doneShown) {
    const b = document.createElement('button');
    b.className = 'more-btn';
    b.dataset.more = '1';
    b.textContent = `Show ${doneTotal - doneShown} more finished threads`;
    frag.push(b);
  }
  if (!list.length) frag.push(messageEl(all.length ? 'No threads match the filters.' : 'No threads to show yet.'));
  const cur = [...host.children];
  const same = cur.length === frag.length && cur.every((c, i) => c === frag[i] || (!els.has(c.dataset?.id ?? '') && c.className === frag[i].className && c.isEqualNode(frag[i])));
  if (!same) host.replaceChildren(...frag);

  for (const [id, el] of els) if (!seen.has(id)) { el.remove(); els.delete(id); }
  for (const [id, el] of els) { const g = list.find((x) => x.id === id); const t = el.querySelector('time'); if (g && t) t.textContent = ago(g.activityAt, true); }

  if (!quiet && !prefersReduced()) {
    for (const [id, el] of els) {
      const a = first.get(id);
      if (!a || !el.isConnected) continue;
      const b = el.getBoundingClientRect(), dx = a.left - b.left, dy = a.top - b.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = 'transform .24s var(--ease-out)';
        el.style.transform = '';
        setTimeout(() => { el.style.transition = ''; }, 260);
      });
    }
  }
  counts();
  for (const b of document.querySelectorAll('#range button')) b.setAttribute('aria-pressed', String(state.range === b.dataset.range));
}

function rangeBar() {
  const host = $('#range');
  if (host.dataset.ready) return;
  host.dataset.ready = '1';
  host.innerHTML = `${RANGES.map(([k, n]) => `<button data-range="${k}" aria-pressed="false">${n}</button>`).join('')}`;
}

function chips() {
  const host = $('#chips');
  const folders = state.data?.folders ?? [];
  if (state.folder !== 'all' && !folders.some((f) => f.path === state.folder)) { state.folder = 'all'; save(); }
  const items = [['all', 'All'], ...folders.map((f) => [f.path, f.folder])];
  const sig = items.map((i) => i.join(':')).join('|') + state.folder + state.pinned;
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  const pinChip = `<button class="chip pinf" data-pinned aria-pressed="${state.pinned}" title="Show only pinned threads">${ui('pin')}Pinned</button><i class="chip-sep" aria-hidden="true"></i>`;
  const chipHtml = items.map(([k, n]) => `<button class="chip ${k === 'all' ? 'all' : ''}" data-f="${esc(k)}" aria-pressed="${state.folder === k}">${k === 'all' ? '' : tagEl(k)}${esc(n)}</button>`).join('');
  const cut = chipHtml.indexOf('</button>') + 9;
  host.innerHTML = chipHtml.slice(0, cut) + pinChip + chipHtml.slice(cut);
}

/* ---- Projects tab: the project's threads on top, checkboxes to show only some threads' work, then "In progress" / "Finished" ---- */
/** Every thread of a group (root, children, grandchildren) with each thread's own status. */
function flat(g) {
  const out = [{ id: g.id, title: g.title, depth: 0, ...g.own }];
  const walk = (c, depth) => { out.push({ id: c.id, title: c.title, depth, status: c.status, detail: c.detail, stale: c.stale, latest: c.latest, activityAt: c.activityAt }); c.children.forEach((k) => walk(k, depth + 1)); };
  g.children.forEach((c) => walk(c, 1));
  return out;
}
/** Description line of a thread: the latest message while running, otherwise Claude's summary (if any). */
const workText = (m) => (m.status === 'work' ? (m.latest?.text ?? m.detail) : (m.detail ?? m.latest?.text)) ?? '';
const RANK = { input: 0, work: 1, done: 2 };

function workItem(m) {
  const text = workText(m);
  return `<li class="witem" style="--c:${STATUS_META[m.status].c}"><span class="wic">${ui(STATUS_META[m.status].icon)}</span><div class="wbody"><button class="wt" data-id="${esc(m.id)}">${esc(m.title)}</button><p class="${text ? '' : 'nosum'}">${text ? esc(text) : 'No summary yet'}</p></div><time>${ago(m.activityAt, true)}</time></li>`;
}

function projectsHtml() {
  const fs = (state.data?.folders ?? []).filter((f) => (state.folder === 'all' || f.path === state.folder) && (!state.pinned || groups().some((g) => g.path === f.path && g.starred)));
  if (!fs.length) return `<div class="empty">${state.pinned ? 'No pinned threads.' : 'No projects.'}</div>`;
  return fs.map((f) => {
    const all = groups().filter((g) => g.path === f.path && (!state.pinned || g.starred)).flatMap(flat);
    const picked = all.filter((m) => state.pick.has(m.id));
    const shown = picked.length ? picked : all;
    const doing = shown.filter((m) => m.status !== 'done').sort((a, b) => RANK[a.status] - RANK[b.status] || b.activityAt - a.activityAt);
    const doneAll = shown.filter((m) => m.status === 'done').sort((a, b) => b.activityAt - a.activityAt);
    const done = doneAll.slice(0, picked.length ? 20 : 6);
    const stat = (k, label) => (f.count[k] ? `<span class="stat" style="--c:${STATUS_META[k].c}">${ui(STATUS_META[k].icon)}${f.count[k]} ${label}</span>` : '');
    const rows = all.map((m) => `<div class="trow ${m.depth ? 'c' : ''}" style="--c:${STATUS_META[m.status].c}" ${m.depth > 1 ? `data-d="${m.depth}"` : ''}>
        <input type="checkbox" data-pick="${esc(m.id)}" ${state.pick.has(m.id) ? 'checked' : ''} aria-label="Show only the work of thread ${esc(m.title)}">
        <span class="tic" title="${STATUS_META[m.status].name}">${ui(STATUS_META[m.status].icon)}</span>
        <button class="tn" data-id="${esc(m.id)}">${esc(m.title)}</button>
        <time>${ago(m.activityAt, true)}</time>
        <a class="open-sm row" href="${esc(openUrl(m.id))}" aria-label="Open &quot;${esc(m.title)}&quot; in Claude" title="Open in Claude">${ui('external-link')}</a>
      </div>`).join('');
    return `<article class="pcard">
      <div class="p-head">${tagEl(f.path)}<div class="p-id"><h3>${esc(f.folder)}</h3><div class="p-path" title="${esc(f.path)}">${esc(f.path)}</div></div></div>
      <div class="stats">${stat('input', 'needs input')}${stat('work', 'running')}${stat('done', 'done')}</div>
      <section><p class="lbl">Threads in project · ${all.length}</p><div class="threads">${rows}</div></section>
      ${picked.length ? `<div class="pickbar"><span>Showing the work of ${picked.length} threads</span><button class="link" data-clearpick="${esc(f.path)}">Clear selection</button></div>` : ''}
      <section><p class="lbl">In progress · ${doing.length}</p>${doing.length ? `<ul class="wlist">${doing.map(workItem).join('')}</ul>` : '<p class="d">Nothing in progress.</p>'}</section>
      <section><p class="lbl">Finished · ${doneAll.length}</p>${done.length ? `<ul class="wlist">${done.map(workItem).join('')}</ul>${doneAll.length > done.length ? `<p class="d more">and ${doneAll.length - done.length} more finished threads; tick a thread above to see it on its own.</p>` : ''}` : '<p class="d">No results yet.</p>'}</section>
    </article>`;
  }).join('');
}

/* ---- small markdown for the timeline: paragraphs, lists, bold/italic, code, quotes, http(s) links. HTML is always escaped first. ---- */
function mdInline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}
function md(text) {
  const lines = esc(text).split('\n');
  const bullet = /^\s*[-*•]\s+/, ordered = /^\s*\d+[.)]\s+/, quote = /^&gt;\s?/, special = /^(```|#{1,6}\s|\s*[-*•]\s|\s*\d+[.)]\s|&gt;)/;
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      i++;
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
    } else if (!l.trim()) i++;
    else if (/^#{1,6}\s+/.test(l)) { out.push(`<p class="md-h">${mdInline(l.replace(/^#{1,6}\s+/, ''))}</p>`); i++; }
    else if (bullet.test(l) || ordered.test(l)) {
      const re = bullet.test(l) ? bullet : ordered, tag = re === bullet ? 'ul' : 'ol', items = [];
      while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, ''));
      out.push(`<${tag}>${items.map((x) => `<li>${mdInline(x)}</li>`).join('')}</${tag}>`);
    } else if (quote.test(l)) {
      const buf = [];
      while (i < lines.length && quote.test(lines[i])) buf.push(lines[i++].replace(quote, ''));
      out.push(`<blockquote>${buf.map(mdInline).join('<br>')}</blockquote>`);
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && (!buf.length || !special.test(lines[i]))) buf.push(lines[i++]);
      out.push(`<p>${buf.map(mdInline).join('<br>')}</p>`);
    }
  }
  return out.join('');
}

/* ---- detail drawer + timeline ---- */
let lastFocus = null;
function timelineHtml(g, m) {
  const tl = state.timeline && state.timeline.id === m.id ? state.timeline : null;
  const events = [];
  if (m.id === g.id) for (const c of g.children) if (c.createdAt) events.push({ at: c.createdAt, html: `<div><span class="who">SUB-THREAD</span><b>${esc(c.title)}</b> created</div>` });
  if (m.createdAt) events.push({ at: m.createdAt, html: '<div><span class="who">THREAD</span>Created</div>' });
  for (const t of tl?.turns ?? []) {
    const tools = t.tools.length ? `<div class="tools-row">${t.tools.slice(0, 8).map((x) => `<span class="tool">${esc(x.name)} ×${x.n}</span>`).join('')}${t.tools.length > 8 ? `<span class="tool">+${t.tools.length - 8}</span>` : ''}</div>` : '';
    events.push({ at: t.at, html: `<div class="you"><span class="who">YOU</span><div class="md">${md(t.prompt)}</div></div>${tools}${t.reply ? `<div class="ai"><span class="who">CLAUDE</span><div class="md">${md(t.reply)}</div></div>` : ''}${t.durationMs > 20000 ? `<div class="dur">${span(t.durationMs)}</div>` : ''}` });
  }
  events.sort((a, b) => b.at - a.at);
  let note = '';
  if (!tl) note = '<p class="d">Loading timeline…</p>';
  else if (tl.error) note = `<p class="d">${esc(tl.error)}</p>`;
  else if (tl.tooBig) note = '<p class="d">The transcript is too large to show a timeline.</p>';
  else if (!tl.found) note = '<p class="d">The transcript for this thread was not found, so only basic milestones are shown.</p>';
  else if (tl.omitted) note = `<p class="d">Showing only the most recent turns; ${tl.omitted} older turns are hidden.</p>`;
  return `${note}<ol class="tl">${events.map((e) => `<li><span class="tt">${esc(clock(e.at))}</span><div class="tb">${e.html}</div></li>`).join('')}</ol>`;
}

function drawerHtml(g, m) {
  const all = [g, ...g.children];
  const asking = g.status === 'input' ? members(g).find((x) => x.id === g.leadId) ?? g : null;
  const summary = m.detail ? `<div><p class="lbl">${m.status === 'work' ? 'Summary of the previous turn' : 'Claude\'s summary'}</p><p class="d">${esc(m.detail)}</p></div>` : '';
  return `<div class="d-top"><span class="pillst" style="--c:${STATUS_META[g.status].c}">${ui(STATUS_META[g.status].icon)}${STATUS_META[g.status].name}</span><button class="btn" id="dclose" aria-label="Close">${ui('x')}Close</button></div>
    <div><h2>${esc(g.title)}</h2><div class="path">${tagEl(g.path)}${esc(g.path)}</div></div>
    <div class="idline"><span>ID <b>${esc(m.id)}</b></span>${(m.run ?? (m.id === g.id ? g.own?.run : null)) ? `<span>PID <b>${(m.run ?? g.own.run).pid}</b> · ${esc((m.run ?? g.own.run).status ?? '')}</span>` : ''}</div>
    ${asking?.detail ? `<div><p class="lbl">Waiting for you</p><div class="ask">${esc(asking.detail)}</div></div>` : ''}
    <div>${openLink(m.id, m.status === 'input' ? 'Open in Claude to reply' : 'Open this thread in Claude')}</div>
    ${all.length > 1 ? `<div><p class="lbl">Threads in this group</p><div class="members" role="tablist">${all.map((x) => `<button class="mem" role="tab" data-member="${esc(x.id)}" aria-selected="${x.id === m.id}" style="--c:${STATUS_META[x.status].c}"><span class="mst"></span>${esc(x.title)}<span class="ms">${STATUS_META[x.status].name}</span></button>`).join('')}</div></div>` : ''}
    ${summary}
    <div><p class="lbl">Timeline${all.length > 1 ? `: ${esc(m.title)}` : ''}</p>${timelineHtml(g, m)}</div>
    <div class="hint">This page only shows status. The "Open in Claude" button uses the claude:// link of Claude desktop; if nothing happens, open the thread from Claude desktop's own list. Status is derived from Claude's automatic summaries, so it may not always be accurate.</div>`;
}

function drawer() {
  const d = $('#drawer');
  const g = state.sel && groups().find((x) => x.id === state.sel);
  if (!g) { if (d.classList.contains('on')) closeDrawer(true); return; }
  const m = members(g).find((x) => x.id === state.member) ?? g;
  const top = d.scrollTop;
  d.innerHTML = drawerHtml(g, m);
  d.scrollTop = top;
}

function openDrawer(id) {
  const g = findGroup(id);
  if (!g) return;
  lastFocus = document.activeElement;
  state.sel = g.id;
  state.member = id;
  state.timeline = null;
  drawer();
  $('#drawer').classList.add('on');
  $('#scrim').classList.add('on');
  $('#drawer').focus({ preventScroll: true });
  history.replaceState(null, '', `#thread=${encodeURIComponent(id)}`);
  loadTimeline(id);
}
function closeDrawer(silent) {
  state.sel = null;
  state.member = null;
  $('#drawer').classList.remove('on');
  $('#scrim').classList.remove('on');
  history.replaceState(null, '', location.pathname + location.search);
  if (!silent && lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
}
async function loadTimeline(id) {
  try {
    const res = await fetch(`/api/timeline?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    const data = await res.json();
    if (state.member !== id) return;
    state.timeline = res.ok ? data : { id, error: data.error || 'Could not load the timeline.', turns: [] };
  } catch {
    if (state.member !== id) return;
    state.timeline = { id, error: 'Could not load the timeline.', turns: [] };
  }
  drawer();
}

/* ---- light/dark theme ---- */
function applyTheme() {
  if (state.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', state.theme);
  const [, name, ic] = THEMES.find((x) => x[0] === state.theme) ?? THEMES[0];
  $('#themeTx').textContent = name;
  $('#themeIc').innerHTML = LUCIDE_UI[ic];
}

/* ---- redraw ---- */
function render(quiet) {
  assignTags((state.data?.folders ?? []).map((f) => f.path));
  chips();
  rangeBar();
  $('#range').style.display = state.tab === 'board' ? '' : 'none'; // the time range only applies to the board; the Projects tab does not use it
  $('#tab-board').setAttribute('aria-selected', String(state.tab === 'board'));
  $('#tab-proj').setAttribute('aria-selected', String(state.tab === 'proj'));
  $('#board').hidden = state.tab !== 'board';
  $('#projects').hidden = state.tab !== 'proj';
  sync(quiet);
  if (state.tab === 'proj') $('#projects').innerHTML = projectsHtml();
  if (state.sel) drawer();
}
function setBanner(text) {
  const b = $('#banner');
  b.hidden = !text;
  b.textContent = text || '';
}
/** Thread counts per status in the top bar; click one to see only that status, click again to clear. */
function counts() {
  const gs = groups();
  const n = (k) => gs.filter((g) => g.status === k).length;
  const ni = n('input'), nw = n('work'), nd = n('done');
  // lights follow how much attention is needed: input and/or running light up their lamps and the done lamp stays off; when only done is left, the done lamp lights up
  const lit = { input: ni > 0, work: nw > 0, done: nd > 0 && ni === 0 && nw === 0 };
  const num = { input: ni, work: nw, done: nd };
  const html = ['input', 'work', 'done'].map((k) => `<button data-status="${k}" data-lit="${lit[k]}" aria-pressed="${state.status === k}" title="${STATUS_META[k].name}: click to filter" style="--c:${STATUS_META[k].c}"><i class="led"></i>${{ input: 'INPUT', work: 'RUN', done: 'DONE' }[k]} <b>${String(num[k]).padStart(2, '0')}</b></button>`).join('');
  const host = $('#sb-counts');
  if (host.dataset.sig !== html) { host.dataset.sig = html; host.innerHTML = html; }
}
/** Connection state (the LIVE light) in the top-right corner. */
function statusBar(ok) {
  $('#sb-led').className = `led ${ok ? 'live' : 'off'}`;
  $('#sb-state').textContent = ok ? 'LIVE' : 'DISCONNECTED';
}
let firstLoad = true;
async function poll() {
  try {
    const res = await fetch('/api/board', { cache: 'no-store' });
    const raw = await res.text();
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    const data = JSON.parse(raw);
    setBanner((data.warnings || []).join(' '));
    if (raw !== state.raw) {
      state.raw = raw;
      state.data = data;
      render(firstLoad);
      if (state.member) loadTimeline(state.member); // the open thread may have just got a new turn
      if (firstLoad) {
        const m = /^#thread=(.+)$/.exec(location.hash);
        if (m) openDrawer(decodeURIComponent(m[1]));
      }
      firstLoad = false;
    } else {
      sync(true); // data unchanged: only refresh the time labels
    }
    $('#stamp').textContent = new Date().toLocaleTimeString('en-GB');
    statusBar(true);
  } catch (e) {
    setBanner(`Cannot reach the server (${e.message}). Showing the last data${state.data ? '' : ' (none yet)'}.`);
    statusBar(false);
  }
}

document.addEventListener('change', (e) => {
  const c = e.target.closest?.('input[data-pick]');
  if (!c) return;
  if (c.checked) state.pick.add(c.dataset.pick); else state.pick.delete(c.dataset.pick);
  $('#projects').innerHTML = projectsHtml();
  $(`input[data-pick="${CSS.escape(c.dataset.pick)}"]`)?.focus({ preventScroll: true });
});
document.addEventListener('animationend', (e) => { e.target.classList?.remove('enter', 'flash'); });
document.addEventListener('click', (e) => {
  const b = e.target.closest('button, #scrim');
  if (!b) return;
  if (b.hasAttribute('data-pinned')) { state.pinned = !state.pinned; state.more = false; save(); render(true); }
  else if (b.dataset.f !== undefined) { state.folder = b.dataset.f; save(); render(true); }
  else if (b.dataset.clearpick) {
    for (const g of groups().filter((x) => x.path === b.dataset.clearpick)) for (const m of flat(g)) state.pick.delete(m.id);
    $('#projects').innerHTML = projectsHtml();
  }
  else if (b.dataset.more) { state.more = true; sync(true); }
  else if (b.dataset.range) { state.range = b.dataset.range; state.more = false; save(); render(true); }
  else if (b.dataset.member) { state.member = b.dataset.member; state.timeline = null; drawer(); loadTimeline(state.member); }
  else if (b.dataset.id) openDrawer(b.dataset.id);
  else if (b.dataset.status) {
    // click a count in the top bar: show only that status; click again to clear
    state.status = state.status === b.dataset.status ? 'all' : b.dataset.status;
    state.more = false;
    if (state.tab !== 'board') state.tab = 'board';
    save();
    render(true);
  }
  else if (b.id === 'tab-board') { state.tab = 'board'; save(); render(true); }
  else if (b.id === 'tab-proj') { state.tab = 'proj'; save(); render(true); }
  else if (b.id === 'theme') { state.theme = THEMES[(THEMES.findIndex((x) => x[0] === state.theme) + 1) % THEMES.length][0]; save(); applyTheme(); }
  else if (b.id === 'dclose' || b.id === 'scrim') closeDrawer();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.sel) closeDrawer(); });

applyTheme();
render(true);
poll();
setInterval(poll, POLL_MS);
