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

  function claude(p) {
    const g = el('div', 'qgroup');
    const item = el('span', 'qitem');
    item.title = p.note || '';
    item.append(el('span', 'qk', 'CLAUDE · ƯỚC TÍNH'));
    g.append(item);
    for (const w of p.windows || []) {
      const i = el('span', 'qitem');
      i.title = `${w.label}: ${Math.round(w.used).toLocaleString('en-US')} ${p.unit} đã dùng`;
      i.append(el('span', 'qk', w.label.includes('5') ? '5H' : '7D'), el('b', '', fmt(w.used)), el('span', 'qk', 'tokens'));
      g.append(i);
    }
    return g;
  }

  function service(p) {
    const i = el('span', 'qitem');
    i.dataset.state = p.state;
    if (p.low) i.dataset.low = 'true';
    i.append(el('span', 'qk', p.label.toUpperCase().replace(' CLOUD', '')));
    if (p.state === 'ok' && p.limit > 0) {
      const bar = el('span', 'qbar');
      const fill = el('i');
      fill.style.width = `${Math.max(0, Math.min(100, (p.used / p.limit) * 100))}%`;
      bar.append(fill);
      i.append(bar, el('b', '', `${fmt(p.used)} / ${fmt(p.limit)}`));
      if (p.low) i.append(el('span', 'qlow', 'sắp hết'));
      i.title = `${p.label}: ${p.used.toLocaleString('en-US')} đã dùng / ${p.limit.toLocaleString('en-US')} ${p.unit}${p.periodEnd ? ` · đến ${new Date(p.periodEnd).toLocaleDateString('en-GB')}` : ''}`;
    } else if (p.state === 'needs-key') {
      i.append(el('span', 'qoff', 'Chưa bật'));
      i.title = `Đặt biến môi trường ${p.env} rồi khởi động lại.`;
    } else {
      i.append(el('span', 'qoff', p.state === 'error' ? 'lỗi' : 'không khả dụng'));
      i.title = p.note || '';
    }
    return i;
  }

  function draw(data) {
    host.replaceChildren();
    const left = data.providers.find((p) => p.id === 'claude');
    const right = el('div', 'qgroup');
    for (const p of data.providers) if (p.id === 'firecrawl' || p.id === 'crawl4ai') right.append(service(p));
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
