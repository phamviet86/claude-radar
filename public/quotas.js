// Quotas footer (opt-in). Fetches /api/quotas, which the server answers from its own cache, so polling here
// never reaches the vendors. All text goes through textContent: nothing from the server is ever parsed as HTML.
// Left: Claude tokens (a local estimate, no plan limit known, so numbers only). Right: a used/total bar for each
// service that reports one (Firecrawl, Crawl4AI).
(() => {
  const POLL_MS = 15000;
  const host = document.getElementById('quotas');
  const dot = document.getElementById('sb-quota');
  if (!host || !dot) return;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));

  // "13:40" today, "Mon 02:00" later
  function when(epochSec) {
    const d = new Date(epochSec * 1000);
    const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm}`;
  }
  const ago = (ms) => (ms < 90e3 ? 'vừa xong' : ms < 3600e3 ? `${Math.round(ms / 60e3)} phút trước` : `${Math.round(ms / 3600e3)} giờ trước`);

  // left block: Claude. With captured plan limits: a bar with percent used and the reset time per window, as on claude.ai.
  // Without them: token numbers only (the plan limit itself is not public, so no bar).
  function claude(p) {
    const b = el('div', 'qblock qleft');
    const t = el('div', 'qtitle');
    t.append(el('b', '', 'CLAUDE'));
    const stale = p.plan && Date.now() - p.plan.at > 30 * 60e3;
    t.append(el('span', 'qsub', p.plan ? (stale ? 'THEO GÓI · CŨ' : 'THEO GÓI') : 'ƯỚC TÍNH'));
    b.append(t);
    const tokens = new Map((p.windows || []).map((w) => [w.label.includes('5') ? '5H' : '7D', w.used]));
    b.title = p.plan ? `Cập nhật ${ago(Date.now() - p.plan.at)} từ status line của Claude Code. Tokens (ước tính): 5H ${fmt(tokens.get('5H') || 0)}, 7D ${fmt(tokens.get('7D') || 0)}` : p.note || '';
    const rows = p.plan ? [['5H', p.plan.fiveHour], ['7D', p.plan.week]] : [['5H', null], ['7D', null]];
    for (const [key, w] of rows) {
      const row = el('div', w ? 'qrow qplan' : 'qrow');
      row.append(el('span', 'qk', key));
      if (w && !w.reset) {
        const bar = el('span', 'qbar');
        const fill = el('i');
        fill.style.width = `${Math.max(0, Math.min(100, w.percent))}%`;
        bar.append(fill);
        row.append(bar, el('b', 'qv', `${Math.round(w.percent)}%`), el('span', 'qk', `reset ${when(w.resetsAt)}`));
        row.dataset.high = String(w.percent >= 80);
      } else if (w) {
        row.append(el('span', 'qoff', 'đã reset, chờ cập nhật'));
      } else {
        row.append(el('b', 'qv', fmt(tokens.get(key) || 0)), el('span', 'qk', 'tokens'));
      }
      b.append(row);
    }
    return b;
  }

  // right block: one row per service: name | bar | used / total | flag
  function service(p) {
    const row = el('div', 'qrow qsvc');
    row.dataset.state = p.state;
    if (p.low) row.dataset.low = 'true';
    row.append(el('span', 'qk', p.label.toUpperCase().replace(' CLOUD', '')));
    if (p.state === 'ok' && p.limit > 0) {
      const bar = el('span', 'qbar');
      const fill = el('i');
      fill.style.width = `${Math.max(0, Math.min(100, (p.used / p.limit) * 100))}%`;
      bar.append(fill);
      row.append(bar, el('b', 'qv', `${fmt(p.used)} / ${fmt(p.limit)}`), el('span', 'qlow', p.low ? 'sắp hết' : ''));
      row.title = `${p.label}: ${p.used.toLocaleString('en-US')} đã dùng / ${p.limit.toLocaleString('en-US')} ${p.unit}${p.periodEnd ? ` · đến ${new Date(p.periodEnd).toLocaleDateString('en-GB')}` : ''}`;
    } else {
      const off = el('span', 'qoff', p.state === 'needs-key' ? 'Chưa bật' : p.state === 'error' ? 'lỗi' : 'không khả dụng');
      row.append(off);
      row.title = p.state === 'needs-key' ? `Đặt biến môi trường ${p.env} rồi khởi động lại.` : p.note || '';
    }
    return row;
  }

  function draw(data) {
    host.replaceChildren();
    const left = data.providers.find((p) => p.id === 'claude');
    const right = el('div', 'qblock qright');
    for (const id of ['firecrawl', 'crawl4ai']) {
      const p = data.providers.find((x) => x.id === id);
      if (p) right.append(service(p));
    }
    if (left) host.append(claude(left));
    host.append(right);
    dot.hidden = !data.low;
    host.hidden = false;
  }

  async function poll() {
    try {
      const res = await fetch('/api/quotas', { cache: 'no-store' });
      if (res.ok) draw(await res.json());
    } catch { /* keep the last footer; the board has its own connection light */ }
  }
  (async function loop() { await poll(); setTimeout(loop, POLL_MS); })();
})();
