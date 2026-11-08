// Quotas panel (opt-in). Fetches /api/quotas, which the server answers from its own cache, so polling here
// never reaches the vendors. All text goes through textContent: nothing from the server is ever parsed as HTML.
(() => {
  const POLL_MS = 15000;
  const host = document.getElementById('quotas');
  const dot = document.getElementById('sb-quota');
  if (!host || !dot) return;
  let open = false;
  try { open = localStorage.getItem('claude-radar-quotas') === 'open'; } catch { /* no localStorage: collapsed */ }

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
  const STATE = { ok: 'OK', estimate: 'ƯỚC TÍNH', 'needs-key': 'CHƯA BẬT', unavailable: 'KHÔNG KHẢ DỤNG', error: 'LỖI' };

  function card(p) {
    const c = el('div', 'qcard');
    c.dataset.state = p.state;
    if (p.low) c.dataset.low = 'true';
    const head = el('div', 'qhead');
    head.append(el('b', '', p.label), el('span', 'qstate', STATE[p.state] || p.state));
    if (p.low) head.append(el('span', 'qlow', 'sắp hết'));
    c.append(head);
    if (p.state === 'ok') {
      c.append(el('div', 'qnum', `${fmt(p.remaining)} / ${fmt(p.limit)} ${p.unit} còn lại`));
      if (p.limit > 0) {
        const bar = el('div', 'qbar');
        const fill = el('i');
        fill.style.width = `${Math.max(0, Math.min(100, (p.remaining / p.limit) * 100))}%`;
        bar.append(fill);
        c.append(bar);
      }
      if (p.periodEnd) c.append(el('div', 'qnote', `Kỳ thanh toán đến ${new Date(p.periodEnd).toLocaleDateString('en-GB')}`));
    }
    for (const w of p.windows || []) c.append(el('div', 'qnum', `${w.label}: ${fmt(w.used)} ${p.unit} đã dùng`));
    if (p.state === 'needs-key') c.append(el('div', 'qnote', `Đặt biến môi trường ${p.env} rồi khởi động lại.`));
    else if (p.note) c.append(el('div', 'qnote', p.note));
    if (p.link) {
      const a = el('a', 'qlink', 'Mở trang chính thức');
      a.href = p.link; a.target = '_blank'; a.rel = 'noopener noreferrer';
      c.append(a);
    }
    return c;
  }

  function draw(data) {
    host.replaceChildren();
    const toggle = el('button', 'qtoggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.append(el('span', '', 'QUOTAS'), el('span', 'qsum', data.enabled ? (data.low ? 'sắp hết' : 'đã bật') : 'Chưa bật'));
    toggle.addEventListener('click', () => {
      open = !open;
      try { localStorage.setItem('claude-radar-quotas', open ? 'open' : 'closed'); } catch { /* ignore */ }
      draw(data);
    });
    host.append(toggle);
    if (open) {
      const grid = el('div', 'qgrid');
      for (const p of data.providers) grid.append(card(p));
      host.append(grid);
    }
    dot.hidden = !data.low;
    host.hidden = false;
  }

  async function poll() {
    try {
      const res = await fetch('/api/quotas', { cache: 'no-store' });
      if (res.ok) draw(await res.json());
    } catch { /* keep the last panel; the board has its own connection light */ }
  }
  (async function loop() { await poll(); setTimeout(loop, POLL_MS); })();
})();
