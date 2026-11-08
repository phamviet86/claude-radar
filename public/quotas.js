// Quotas footer (opt-in). Fetches /api/quotas, which the server answers from its own cache, so polling here
// never reaches the vendors. All text goes through textContent: nothing from the server is ever parsed as HTML.
// Left: Claude tokens (a local estimate, no plan limit known, so numbers only). Right: a used/total bar for each
// service that reports one (Firecrawl, Crawl4AI).
(() => {
  const POLL_MS = 15000;
  const IN_APP = /Electron\//.test(navigator.userAgent); // the Mac app has the API keys window; a plain browser does not
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
  const ago = (ms) => (ms < 90e3 ? 'just now' : ms < 3600e3 ? `${Math.round(ms / 60e3)} min ago` : `${Math.round(ms / 3600e3)} h ago`);

  // left block: Claude. With captured plan limits: a bar with percent used and the reset time per window, as on claude.ai.
  // Without them: token numbers only (the plan limit itself is not public, so no bar).
  function claude(p) {
    const b = el('div', 'qblock qleft');
    const t = el('div', 'qtitle');
    t.append(el('b', '', 'CLAUDE'));
    const stale = p.plan && Date.now() - p.plan.at > 30 * 60e3;
    t.append(el('span', 'qsub', p.plan ? (stale ? 'PLAN · STALE' : 'PLAN') : 'ESTIMATE'));
    b.append(t);
    const tokens = new Map((p.windows || []).map((w) => [w.label.includes('5') ? '5H' : '7D', w.used]));
    b.title = p.plan ? `Updated ${ago(Date.now() - p.plan.at)} from the Claude Code status line. Tokens (estimate): 5H ${fmt(tokens.get('5H') || 0)}, 7D ${fmt(tokens.get('7D') || 0)}` : p.note || '';
    const rows = p.plan ? [['5H', p.plan.fiveHour], ['7D', p.plan.week]] : [['5H', null], ['7D', null]];
    const list = el('div', p.plan ? 'qrows' : 'qrows qinline');
    b.append(list);
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
        row.append(el('span', 'qoff', 'reset, waiting for an update'));
      } else {
        row.append(el('b', 'qv', fmt(tokens.get(key) || 0)), el('span', 'qk', 'tokens'));
      }
      list.append(row);
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
      const val = el('span', 'qval');
      val.append(el('b', 'qv', `${fmt(p.used)} / ${fmt(p.limit)}`));
      if (p.low) val.append(el('span', 'qlow', 'low'));
      row.append(bar, val);
      row.title = `${p.label}: ${p.used.toLocaleString('en-US')} used of ${p.limit.toLocaleString('en-US')} ${p.unit}${p.periodEnd ? ` · until ${new Date(p.periodEnd).toLocaleDateString('en-GB')}` : ''}`;
    } else if (p.state === 'needs-key' && IN_APP) {
      // Mac app: the button asks the app (through window.open, handled in desktop/main.js) to show the API keys window
      const off = el('span', 'qoff');
      const btn = el('button', 'qenable', 'ENABLE');
      btn.type = 'button';
      btn.title = `Enter the ${p.label} key`;
      btn.addEventListener('click', () => window.open('claude-radar://keys'));
      off.append(el('span', '', 'Off'), btn);
      row.append(off);
    } else {
      const off = el('span', 'qoff', p.state === 'needs-key' ? 'Off' : p.state === 'error' ? 'error' : 'unavailable');
      row.append(off);
      row.title = p.state === 'needs-key' ? `Set the ${p.env} environment variable and restart.` : p.note || '';
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
  window.addEventListener('claude-radar:keys', poll); // the app saved or cleared a key: refresh now
  (async function loop() { await poll(); setTimeout(loop, POLL_MS); })();
})();
