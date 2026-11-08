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

  // left block: Claude, one row per window (numbers only: no plan limit is known)
  function claude(p) {
    const b = el('div', 'qblock qleft');
    b.title = p.note || '';
    const t = el('div', 'qtitle');
    t.append(el('b', '', 'CLAUDE'), el('span', 'qsub', 'ƯỚC TÍNH'));
    b.append(t);
    for (const w of p.windows || []) {
      const row = el('div', 'qrow');
      row.title = `${w.label}: ${Math.round(w.used).toLocaleString('en-US')} ${p.unit} đã dùng`;
      row.append(el('span', 'qk', w.label.includes('5') ? '5H' : '7D'), el('b', 'qv', fmt(w.used)), el('span', 'qk', 'tokens'));
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
