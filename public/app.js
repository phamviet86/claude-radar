// Giao diện chỉ đọc: lấy /api/board mỗi 5 giây rồi vẽ lại khi dữ liệu đổi. Bấm một thread để xem timeline của nó.
const COLS = [
  { k: 'input', name: 'Cần input', c: 'var(--input)' },
  { k: 'work', name: 'Đang thực hiện', c: 'var(--work)' },
  { k: 'done', name: 'Hoàn thành', c: 'var(--done)' },
];
const LABEL = { input: 'Cần input', work: 'Đang thực hiện', done: 'Hoàn thành' };
const SC = { input: 'var(--input)', work: 'var(--work)', done: 'var(--done)' };
const BUCKETS = [['today', 'Hôm nay'], ['yesterday', 'Hôm qua'], ['week', 'Tuần này'], ['older', 'Cũ hơn']];
const POLL_MS = 5000;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Bỏ dấu để "tim" khớp "Tìm". */
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

const state = { tab: 'board', group: false, folder: 'all', q: '', sel: null, member: null, timeline: null, open: { today: true, yesterday: true, week: true, older: false }, data: null, raw: '' };
try {
  Object.assign(state, JSON.parse(localStorage.getItem('thread-board') || '{}'));
} catch { /* không có localStorage: dùng mặc định */ }
state.sel = null; state.member = null; state.timeline = null;
const save = () => {
  try {
    localStorage.setItem('thread-board', JSON.stringify({ tab: state.tab, group: state.group, folder: state.folder, open: state.open }));
  } catch { /* bỏ qua */ }
};

function ago(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 2) return 'vừa xong';
  if (m < 60) return `${m} phút trước`;
  if (m < 1440) return `${Math.round(m / 60)} giờ trước`;
  return `${Math.round(m / 1440)} ngày trước`;
}
function clock(ts) {
  const d = new Date(ts), t = new Date();
  const hm = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === t.toDateString() ? hm : `${d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })} ${hm}`;
}
function span(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} giây`;
  if (s < 3600) return `${Math.round(s / 60)} phút`;
  return `${(s / 3600).toFixed(1).replace('.0', '')} giờ`;
}

/* ---- thẻ dự án: biểu tượng riêng cho mỗi thư mục, kèm màu. Cố định theo tên, không trùng giữa các thư mục đang có. ---- */
const ICONS = [
  '<circle cx="8" cy="8" r="5.5"/>', '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/>', '<path d="M8 2l6.5 11.5h-13z"/>', '<path d="M8 1.5l6.5 6.5L8 14.5 1.5 8z"/>',
  '<path d="M8 1.5l1.9 4.2 4.6.5-3.4 3.1 1 4.5L8 11.5l-4.1 2.3 1-4.5L1.5 6.2l4.6-.5z"/>', '<path d="M8 1.5l5.6 3.25v6.5L8 14.5l-5.6-3.25v-6.5z"/>',
  '<path d="M6 2h4v4h4v4h-4v4H6v-4H2V6h4z"/>', '<path d="M8 14S2 10 2 6a3.2 3.2 0 0 1 6-1.6A3.2 3.2 0 0 1 14 6c0 4-6 8-6 8z"/>',
  '<path d="M9 1.5L3 9h4l-1 5.5L13 7H9z"/>', '<path d="M12.5 10.5A6 6 0 0 1 5.5 3.5a6 6 0 1 0 7 7z"/>', '<path d="M13.5 2.5C6 2.5 2.5 6 2.5 10.5a3 3 0 0 0 3 3C10 13.5 13.5 10 13.5 2.5z"/>',
  '<path d="M8 1.5S3 7 3 10a5 5 0 0 0 10 0C13 7 8 1.5 8 1.5z"/>', '<path d="M3 1.5h1.5v13H3zM5.5 2.5h8l-2 3 2 3h-8z"/>', '<path d="M5 1.5h6l3.5 3.5v6L11 14.5H5L1.5 11V5z"/>',
  '<path fill-rule="evenodd" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm0 3.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/>',
];
const hash = (s) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h; };
let tags = new Map();
function assignTags(paths) {
  const key = paths.join('|');
  if (tags.key === key) return;
  const next = new Map(), used = new Set();
  // màu: chia đều vòng màu cho các thư mục đang có (xếp theo hash của tên) nên luôn tách biệt nhau
  const byHash = [...paths].sort((a, b) => hash(a) - hash(b));
  byHash.forEach((p, n) => next.set(p, { icon: -1, hue: Math.round((n * 360) / byHash.length + 24) % 360 }));
  // biểu tượng: từ tên thư mục, không trùng nhau
  for (const p of [...paths].sort()) {
    let i = hash(p) % ICONS.length;
    while (used.has(i) && used.size < ICONS.length) i = (i + 1) % ICONS.length;
    used.add(i);
    next.get(p).icon = i;
  }
  next.key = key;
  tags = next;
}
const tag = (path) => {
  const t = tags.get(path) ?? { icon: hash(path) % ICONS.length, hue: hash(`${path}#`) % 360 };
  return `<span class="tag" style="--c:hsl(${t.hue} 58% 44%)" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">${ICONS[t.icon]}</svg></span>`;
};

const groups = () => state.data?.groups ?? [];
const members = (g) => [g, ...g.children.flatMap((c) => [c, ...c.children])];
const matches = (g) => !state.q || members(g).some((m) => fold(m.title).includes(fold(state.q)));
const visible = () => groups().filter((g) => (state.folder === 'all' || g.path === state.folder) && matches(g));
const findGroup = (id) => groups().find((g) => members(g).some((m) => m.id === id));

function chips() {
  const gs = groups();
  const paths = [...new Map(gs.map((g) => [g.path, g.folder])).entries()];
  if (state.folder !== 'all' && !paths.some(([p]) => p === state.folder)) state.folder = 'all';
  const all = [['all', 'Tất cả', gs.length, false], ...paths.map(([p, f]) => [p, f, gs.filter((g) => g.path === p).length, true])];
  $('#chips').innerHTML = all.map(([k, n, c, icon]) =>
    `<button class="chip" data-f="${esc(k)}" aria-pressed="${state.folder === k}">${icon ? tag(k) : ''}${esc(n)} <span class="count">${c}</span></button>`).join('');
}

function meta(g) {
  const n = members(g).length - 1;
  return `<span class="meta">${state.group ? '' : `<span class="folder">${tag(g.path)}${esc(g.folder)}</span>`}${g.starred ? '<span class="badge pin">GHIM</span>' : ''}${n && g.status === 'done' ? `<span class="badge team">★ ${n} THREAD CON</span>` : ''}<span class="since">${ago(g.activityAt)}</span></span>`;
}

/** Thẻ: chỉ tên thread, các thread con (đang ở trạng thái nào) và nhãn dự án. Chi tiết nằm trong timeline. */
function card(g) {
  const subs = g.status !== 'done' && g.children.length
    ? `<div class="subs">${g.children.map((c) => `<button class="sub-row" data-id="${esc(c.id)}" style="--s:${SC[c.status]}"><span class="st"></span><span class="sn">${esc(c.title)}</span>${c.folder !== g.folder ? `<span class="fl">${esc(c.folder)}</span>` : ''}<span class="ss">${LABEL[c.status]}</span></button>`).join('')}</div>`
    : '';
  return `<div class="card"><button class="main" data-id="${esc(g.id)}"><span class="t">${esc(g.title)}</span></button>${subs}${meta(g)}</div>`;
}

function doneColumn(list) {
  const out = BUCKETS.map(([k, name]) => {
    const items = list.filter((g) => g.bucket === k);
    if (!items.length) return '';
    const open = state.q ? true : state.open[k];
    return `<section class="bucket"><button class="bhead" data-bucket="${k}" aria-expanded="${open}"><span class="chev">▸</span>${name}<span class="n">${items.length}</span></button>${open ? items.map(card).join('') : ''}</section>`;
  }).join('');
  return out || '<div class="empty">Không có thread.</div>';
}

function columns(list) {
  return `<div class="board">${COLS.map((c) => {
    const items = list.filter((g) => g.status === c.k);
    const body = c.k === 'done' ? doneColumn(items) : items.length ? items.map(card).join('') : '<div class="empty">Không có thread.</div>';
    return `<section class="col" data-s="${c.k}" style="--s:${c.c}"><h2><span class="pill"></span>${c.name}<span class="n">${items.length}</span></h2><div class="cards">${body}</div></section>`;
  }).join('')}</div>`;
}

function board() {
  const list = visible();
  $('#count').textContent = `${list.length} nhóm thread`;
  if (!groups().length) return '<div class="empty">Chưa có thread nào để hiển thị.</div>';
  if (!state.group) return columns(list);
  const paths = [...new Map(list.map((g) => [g.path, g.folder])).entries()];
  return paths.map(([p, f]) => {
    const l = list.filter((g) => g.path === p);
    return `<div class="lane"><h3>${tag(p)}${esc(f)} <small>${esc(p)} · ${l.length} nhóm</small></h3>${columns(l)}</div>`;
  }).join('') || '<div class="empty">Không có thread khớp.</div>';
}

function node(t, child) {
  return `<button class="node ${child ? 'c' : ''}" data-id="${esc(t.id)}" style="--s:${SC[t.status]}"><span class="st"></span><span>${esc(t.title)}</span></button>`;
}

function projects() {
  const fs = (state.data?.folders ?? []).filter((f) => state.folder === 'all' || f.path === state.folder);
  $('#count').textContent = `${fs.length} dự án`;
  if (!fs.length) return '<div class="empty">Không có dự án.</div>';
  return `<div class="projects">${fs.map((f) => {
    const gs = groups().filter((g) => g.path === f.path);
    const stat = (k, label) => (f.count[k] ? `<span class="stat ${k}">${f.count[k]} ${label}</span>` : '');
    return `<article class="proj"><div><h3>${tag(f.path)}${esc(f.folder)}</h3><div class="path">${esc(f.path)}</div></div>
      <div class="stats">${stat('input', 'cần input')}${stat('work', 'đang làm')}${stat('done', 'xong')}</div>
      <div><p class="lbl">Đang làm gì</p>${f.doing.length ? `<ul>${f.doing.map((d) => `<li><b>${esc(d.title)}:</b> ${esc(d.detail)}</li>`).join('')}</ul>` : '<span class="d">Không có việc dở.</span>'}</div>
      <div><p class="lbl">Đã làm được</p>${f.done.length ? `<ul>${f.done.map((d) => `<li>${esc(d.detail)} <span class="count">${ago(d.activityAt)}</span></li>`).join('')}</ul>` : '<span class="d">Chưa có kết quả.</span>'}</div>
      <div><p class="lbl">Thread trong dự án</p><div class="tree">${gs.map((g) => node(g, false) + g.children.map((c) => node(c, true)).join('')).join('')}</div></div></article>`;
  }).join('')}</div>`;
}

/* ---- ngăn chi tiết: tóm tắt nhóm + timeline của thread đang chọn ---- */
function timelineHtml(g, m) {
  const tl = state.timeline && state.timeline.id === m.id ? state.timeline : null;
  const events = [];
  for (const c of g.children) if (c.createdAt && m.id === g.id) events.push({ at: c.createdAt, html: `<span class="ev-k">Thread con</span> <b>${esc(c.title)}</b> được tạo` });
  if (m.createdAt) events.push({ at: m.createdAt, html: '<span class="ev-k">Tạo thread</span>' });
  for (const t of tl?.turns ?? []) {
    const tools = t.tools.length ? `<div class="ev-tools">${t.tools.slice(0, 8).map((x) => `<span class="badge">${esc(x.name)} ×${x.n}</span>`).join('')}${t.tools.length > 8 ? `<span class="badge">+${t.tools.length - 8}</span>` : ''}</div>` : '';
    events.push({ at: t.at, html: `<div class="ev-you"><span class="ev-k">Bạn</span> ${esc(t.prompt)}</div>${tools}${t.reply ? `<div class="ev-ai"><span class="ev-k">Claude</span> ${esc(t.reply)}</div>` : ''}${t.durationMs > 20000 ? `<div class="ev-dur">${span(t.durationMs)}</div>` : ''}` });
  }
  events.sort((a, b) => b.at - a.at);
  let note = '';
  if (!tl) note = '<p class="d">Đang tải timeline…</p>';
  else if (tl.error) note = `<p class="d">${esc(tl.error)}</p>`;
  else if (tl.tooBig) note = '<p class="d">Tệp hội thoại quá lớn nên không hiển thị timeline.</p>';
  else if (!tl.found) note = '<p class="d">Không tìm thấy tệp hội thoại của thread này, nên chỉ có các mốc cơ bản.</p>';
  else if (tl.omitted) note = `<p class="d">Chỉ hiển thị các lượt gần nhất, ${tl.omitted} lượt cũ hơn được ẩn.</p>`;
  return `${note}<ol class="timeline">${events.map((e) => `<li><span class="ev-t">${clock(e.at)}</span><div class="ev-b">${e.html}</div></li>`).join('')}</ol>`;
}

async function loadTimeline(id) {
  try {
    const res = await fetch(`/api/timeline?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    const data = await res.json();
    if (state.member !== id) return;
    state.timeline = res.ok ? data : { id, error: data.error || 'Không tải được timeline.', turns: [] };
  } catch {
    if (state.member !== id) return;
    state.timeline = { id, error: 'Không tải được timeline.', turns: [] };
  }
  drawer();
}

function openThread(id) {
  const g = findGroup(id);
  if (!g) return;
  state.sel = g.id; state.member = id; state.timeline = null;
  drawer();
  loadTimeline(id);
}

function drawer() {
  const d = $('#drawer');
  const g = state.sel && groups().find((x) => x.id === state.sel);
  $('#scrim').hidden = !g;
  d.classList.toggle('open', !!g);
  if (!g) { d.innerHTML = ''; return; }
  const all = [g, ...g.children];
  const m = all.find((x) => x.id === state.member) ?? g;
  const keep = d.querySelector('.timeline-wrap')?.scrollTop ?? 0;
  d.innerHTML = `<button class="x" id="close">Đóng</button>
    <div><span class="status ${g.status}">${LABEL[g.status]}</span> <span class="count">&nbsp;${ago(g.activityAt)}</span></div>
    <h2>${esc(g.title)}</h2>
    <div class="folder">${tag(g.path)}${esc(g.path)}</div>
    ${g.status === 'input' && g.detail ? `<div><p class="lbl">Đang chờ bạn</p><div class="quote">${esc(g.detail)}</div></div>` : ''}
    ${g.status === 'work' && g.detail ? `<div><p class="lbl">Tóm tắt lượt trước</p><div class="d">${esc(g.detail)}</div></div>` : ''}
    ${g.status === 'done' && g.detail ? `<div><p class="lbl">Kết quả</p><div class="d">${esc(g.detail)}</div></div>` : ''}
    ${all.length > 1 ? `<div class="members" role="tablist" aria-label="Thread trong nhóm">${all.map((x) => `<button class="mem" role="tab" data-member="${esc(x.id)}" aria-selected="${x.id === m.id}" style="--s:${SC[x.status]}"><span class="st"></span>${esc(x.title)}<span class="ss">${LABEL[x.status]}</span></button>`).join('')}</div>` : ''}
    <div class="timeline-wrap"><p class="lbl">Timeline${all.length > 1 ? `: ${esc(m.title)}` : ''}</p>${timelineHtml(g, m)}</div>
    ${g.status !== 'work' ? '<p class="d">Trạng thái lấy từ tóm tắt tự động của Claude, có thể chưa chính xác.</p>' : ''}
    <div class="hint">Muốn trả lời hoặc yêu cầu làm tiếp, mở thread này trong Claude desktop. Trang này chỉ hiển thị trạng thái.</div>`;
  const w = d.querySelector('.timeline-wrap');
  if (w) w.scrollTop = keep;
}

function render() {
  assignTags((state.data?.folders ?? []).map((f) => f.path));
  chips();
  $('#groupSeg').style.display = state.tab === 'board' ? '' : 'none';
  $('#g0').setAttribute('aria-pressed', String(!state.group));
  $('#g1').setAttribute('aria-pressed', String(state.group));
  $('#tab-board').setAttribute('aria-selected', String(state.tab === 'board'));
  $('#tab-proj').setAttribute('aria-selected', String(state.tab === 'proj'));
  $('#main').innerHTML = state.tab === 'board' ? board() : projects();
  drawer();
}

function setBanner(text) {
  const b = $('#banner');
  b.hidden = !text;
  b.textContent = text || '';
}

async function poll() {
  try {
    const res = await fetch('/api/board', { cache: 'no-store' });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Máy chủ trả lỗi ${res.status}`);
    const data = JSON.parse(raw);
    setBanner((data.warnings || []).join(' '));
    if (raw !== state.raw) {
      state.raw = raw;
      state.data = data;
      render();
      if (state.member) loadTimeline(state.member); // thread đang mở có thể vừa có thêm lượt mới
    }
    $('#upd').textContent = `Cập nhật ${new Date().toLocaleTimeString('vi-VN')} · tự làm mới mỗi ${POLL_MS / 1000} giây`;
  } catch (e) {
    setBanner(`Không kết nối được máy chủ (${e.message}). Đang hiển thị dữ liệu lần cuối${state.data ? '' : ' (chưa có)'}.`);
  }
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('button, #scrim');
  if (!b) return;
  if (b.dataset.f !== undefined) { state.folder = b.dataset.f; save(); render(); }
  else if (b.dataset.bucket) { state.open[b.dataset.bucket] = !state.open[b.dataset.bucket]; save(); render(); }
  else if (b.dataset.member) { state.member = b.dataset.member; state.timeline = null; drawer(); loadTimeline(state.member); }
  else if (b.dataset.id) openThread(b.dataset.id);
  else if (b.id === 'tab-board') { state.tab = 'board'; save(); render(); }
  else if (b.id === 'tab-proj') { state.tab = 'proj'; save(); render(); }
  else if (b.id === 'g0') { state.group = false; save(); render(); }
  else if (b.id === 'g1') { state.group = true; save(); render(); }
  else if (b.id === 'close' || b.id === 'scrim') { state.sel = null; state.member = null; drawer(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.sel) { state.sel = null; state.member = null; drawer(); } });
$('#q').addEventListener('input', (e) => { state.q = e.target.value; render(); });
render();
poll();
setInterval(poll, POLL_MS);
