// Read-only UI: fetches /api/board every 2 seconds and updates by thread id (keeps the existing DOM, never redraws the whole list).
// A single grid of cards, left to right: needs input first, then running, then done. Each card is tinted by its status.
// A card that changes status slides to its new position (FLIP) and flashes briefly. Click a card to see its timeline.
const STATUS_META = {
  input: { name: 'Needs input', icon: 'circle-alert', c: 'var(--input)' },
  work: { name: 'Running', icon: 'circle-dot', c: 'var(--work)' },
  done: { name: 'Done', icon: 'circle-check', c: 'var(--done)' },
};
// Today / 3 days toggle; neither selected = all
const RANGES = [['1d', 'Today'], ['3d', '3 days']];
const ORDER = { input: 0, work: 1, done: 2 };
const DONE_CAP = 24;
const POLL_MS = 2000;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ui = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${LUCIDE_UI[name] ?? ''}</svg>`;
document.querySelectorAll('svg[data-ic]').forEach((s) => { s.innerHTML = LUCIDE_UI[s.dataset.ic] ?? ''; });
const prefersReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = { booted: false, folder: 'all', range: '1d', status: 'all', pinned: false, more: false, sel: null, member: null, timeline: null, data: null, raw: '' };
try {
  const saved = JSON.parse(localStorage.getItem('thread-board') || '{}');
  for (const k of ['folder', 'range', 'status']) if (typeof saved[k] === 'string') state[k] = saved[k];
  state.pinned = saved.pinned === true;
  if (state.range !== 'all' && !RANGES.some((r) => r[0] === state.range)) state.range = '1d';
  if (!['all', 'input', 'work', 'done'].includes(state.status)) state.status = 'all';
} catch { /* no localStorage: use the defaults */ }
const save = () => {
  try {
    localStorage.setItem('thread-board', JSON.stringify({ folder: state.folder, range: state.range, status: state.status, pinned: state.pinned }));
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

/* ---- project tags: a Lucide icon per folder (stable by name, unique across the folders present); the color comes from CSS (status color on cards) ---- */
const ICON_NAMES = Object.keys(LUCIDE);
const hash = (s) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h; };
let tags = new Map();
function assignTags(paths) {
  const key = paths.join('|');
  if (tags.key === key) return;
  const next = new Map(), used = new Set();
  for (const p of [...paths].sort()) {
    let i = hash(p) % ICON_NAMES.length;
    while (used.has(i) && used.size < ICON_NAMES.length) i = (i + 1) % ICON_NAMES.length;
    used.add(i);
    next.set(p, { icon: i });
  }
  next.key = key;
  tags = next;
}
const tagEl = (path) => {
  const t = tags.get(path) ?? { icon: hash(path) % ICON_NAMES.length };
  return `<span class="tg" aria-hidden="true"><svg viewBox="0 0 24 24">${LUCIDE[ICON_NAMES[t.icon]]}</svg></span>`;
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
    : `<a class="open-sm" href="${esc(openUrl(g.id))}" aria-label="Open &quot;${esc(g.title)}&quot; in Claude" title="Open in Claude"><span class="ot">Open in Claude</span>${ui('external-link')}</a>`;
  const run = g.status === 'work' && g.leadRun ? `<span class="runchip"><i class="led"></i>PID ${g.leadRun.pid}</span>` : '';
  const head = `<div class="chead"><span class="cs">${ui(STATUS_META[g.status].icon)}${{ input: 'NEEDS INPUT', work: 'RUNNING', done: 'DONE' }[g.status]}</span><span class="cid proj">${tagEl(g.path)}<span class="pn">${esc(g.folder)}</span></span></div>`;
  return `${head}<button class="main" data-id="${esc(g.id)}"><span class="title">${esc(g.title)}</span>${lineHtml(g)}</button>${kids}
    <div class="foot"><div class="fr-act">${open}${pin}${count}${run || `<time data-at="${g.activityAt}"></time>`}</div></div>`;
}

const els = new Map();
function flash(el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
/** The new status content fades in on top of the old color transition (the card's own animations are untouched). */
function swap(el) { el.classList.remove('swap'); void el.offsetWidth; el.classList.add('swap'); setTimeout(() => el.classList.remove('swap'), 700); }
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
/**
 * Re-inserting a card or replacing its inner HTML (cards, top-bar counters) restarts the CSS animations inside it from
 * zero, which shows as a stutter on every sync. Every endless animation is therefore pinned to a fixed start time, so its
 * phase stays continuous across those updates:
 * - inside a card, the start time is the moment that card entered its current status, so each card has its own rhythm
 *   (a card that turned to "needs input" 2 seconds after another one has its beam 2 seconds behind it);
 * - everywhere else (top-bar lamps, radar icon, background beam) it is the start of the page, so they stay in step.
 */
function keepPhase() {
  for (const a of document.getAnimations()) {
    if (a.effect?.getTiming().iterations !== Infinity) continue;
    const card = /** @type {Element | null} */ (a.effect.target)?.closest?.('.card');
    if (card?.classList.contains('ghost')) continue; // the copy of a removed card just fades out
    const start = card ? (/** @type {any} */ (card)._epoch ?? 0) : 0;
    if (a.startTime !== start) a.startTime = start;
  }
}

/**
 * A removed card fades out where it was, on a fixed-position copy, while the remaining cards slide into the gap.
 * @param {Element} el
 * @param {DOMRect | undefined} rect where the card was before this sync
 */
function fadeOut(el, rect) {
  if (!rect) return;
  const ghost = /** @type {HTMLElement} */ (el.cloneNode(true));
  ghost.className = 'card ghost';
  Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, transform: '', transition: 'none' });
  document.body.append(ghost);
  ghost.addEventListener('animationend', () => ghost.remove(), { once: true });
  setTimeout(() => ghost.remove(), 700);
}

/**
 * Put the children of `host` in the order of `nodes`. moveBefore keeps a moved card's state (running animations and, above all,
 * the status color transition, which would not start on a re-inserted element); without it, fall back to insertBefore.
 * @param {HTMLElement} host
 * @param {Node[]} nodes
 */
function place(host, nodes) {
  const move = typeof host.moveBefore === 'function';
  nodes.forEach((node, i) => {
    const at = host.children[i] ?? null;
    if (node === at) return;
    if (move && node.parentNode === host) host.moveBefore(node, at);
    else host.insertBefore(node, at);
  });
  while (host.children.length > nodes.length) host.lastElementChild?.remove();
}

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
      if (el.dataset.s !== g.status) /** @type {any} */ (el)._epoch = document.timeline.currentTime; // this card's own animation clock starts now
      el.innerHTML = html;
      el.dataset.sig = sig;
      el.dataset.s = g.status;
      if (changed && !quiet) { flash(el); swap(el); }
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
  if (!same) place(host, frag);

  for (const [id, el] of els) {
    if (seen.has(id)) continue;
    if (!quiet && !prefersReduced()) fadeOut(el, first.get(id));
    el.remove();
    els.delete(id);
  }
  for (const [id, el] of els) { const g = list.find((x) => x.id === id); const t = el.querySelector('time'); if (g && t) t.textContent = ago(g.activityAt, true); }

  if (!quiet && !prefersReduced()) {
    for (const [id, el] of els) {
      const a = first.get(id);
      if (!a || !el.isConnected) continue;
      const b = el.getBoundingClientRect(), dx = a.left - b.left, dy = a.top - b.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      // Web Animations instead of inline transitions: an inline `transition` would replace the stylesheet's list and cut the status color transition
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 500, easing: 'cubic-bezier(.2, 0, 0, 1)' });
    }
  }
  counts();
  for (const b of document.querySelectorAll('#range button')) b.setAttribute('aria-pressed', String(state.range === b.dataset.range));
  keepPhase(); // last, after every DOM update above (counts() rebuilds the top-bar lamps)
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
  const items = folders.map((f) => [f.path, f.folder]);
  const sig = items.map((i) => i.join(':')).join('|') + state.folder + state.pinned;
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  const pinChip = `<button class="chip pinf" data-pinned aria-pressed="${state.pinned}" title="Show only pinned threads">${ui('pin')}Pinned</button><i class="chip-sep" aria-hidden="true"></i>`;
  const chipHtml = items.map(([k, n]) => `<button class="chip" data-f="${esc(k)}" aria-pressed="${state.folder === k}">${tagEl(k)}${esc(n)}</button>`).join('');
  host.innerHTML = pinChip + chipHtml;
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
    const dur = t.durationMs > 20000 ? `<span class="wm">${span(t.durationMs)}</span>` : '';
    const toolCount = t.tools.reduce((a, x) => a + x.n, 0);
    events.push({ at: t.at, work: true, html: `<details class="work"><summary><span class="wh">${esc(t.headline || t.prompt.split('\n')[0])}</span><span class="wm">${toolCount ? `${toolCount} tool calls` : ''}</span>${dur}</summary><div class="you"><span class="who">YOU</span><div class="md">${md(t.prompt)}</div></div>${tools}${t.reply ? `<div class="ai"><span class="who">CLAUDE</span><div class="md">${md(t.reply)}</div></div>` : ''}</details>` });
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
    <div><p class="lbl">Timeline${all.length > 1 ? `: ${esc(m.title)}` : ''}</p>${timelineHtml(g, m)}</div>`;
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

/* ---- redraw ---- */
function render(quiet) {
  assignTags((state.data?.folders ?? []).map((f) => f.path));
  chips();
  rangeBar();
  sync(quiet);
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
    // generatedAt changes on every response, so compare without it: an unchanged board only refreshes the time labels
    const same = raw.replace(/"generatedAt":\d+,?/, '') === state.raw;
    if (!same) {
      state.raw = raw.replace(/"generatedAt":\d+,?/, '');
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

document.addEventListener('animationend', (e) => { e.target.classList?.remove('enter', 'flash'); });
document.addEventListener('click', (e) => {
  const b = e.target.closest('button, #scrim');
  if (!b) return;
  if (b.hasAttribute('data-pinned')) { state.pinned = !state.pinned; state.more = false; save(); render(true); }
  else if (b.dataset.f !== undefined) { state.folder = state.folder === b.dataset.f ? 'all' : b.dataset.f; save(); render(true); }
  else if (b.dataset.more) { state.more = true; sync(true); }
  else if (b.dataset.range) { state.range = state.range === b.dataset.range ? 'all' : b.dataset.range; state.more = false; save(); render(true); }
  else if (b.dataset.member) { state.member = b.dataset.member; state.timeline = null; drawer(); loadTimeline(state.member); }
  else if (b.dataset.id) openDrawer(b.dataset.id);
  else if (b.dataset.status) {
    // click a count in the top bar: show only that status; click again to clear
    state.status = state.status === b.dataset.status ? 'all' : b.dataset.status;
    state.more = false;
    save();
    render(true);
  }
  else if (b.id === 'dclose' || b.id === 'scrim') closeDrawer();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.sel) closeDrawer(); });

render(true);
poll();
// chained timeouts, not setInterval: a slow response never piles up requests
(async function loop() { await poll(); setTimeout(loop, POLL_MS); })();
