import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuotaService, shapeFirecrawl, shapeCrawl4ai, redact, FIRECRAWL_URL, CRAWL4AI_URL } from '../lib/quotas.js';
import { ClaudeUsage, parseUsage, windows, FIVE_HOURS } from '../lib/usage.js';
import { SessionReader } from '../lib/read.js';
import { createBoardServer } from '../server.js';

const NOW = Date.parse('2026-11-08T12:00:00Z');
const KEY = 'fc-secret-key-123';
const claude = { estimate: () => ({ fiveHour: 10, week: 100, warnings: [] }) };
const c4Body = { allowance_mc: 2500000, credit: '0.00', credit_mc: 5000, free: '1000.00', free_mc: 1000000, free_period: '2026-11', spend_month_mc: 1500, tier: 'community', topups: 0, recharge: {} };
const okBody = { success: true, data: { remainingCredits: 150, planCredits: 1000, billingPeriodStart: '2026-11-01T00:00:00Z', billingPeriodEnd: '2026-12-01T00:00:00Z' } };

/** @param {(url: string, init: RequestInit) => Promise<Response>} fn */
function mock(fn) {
  const calls = [];
  const f = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    calls.push({ url, init });
    return fn(url, init);
  };
  return { f: /** @type {typeof fetch} */ (/** @type {unknown} */ (f)), calls };
}
const json = (/** @type {unknown} */ b, status = 200) => new Response(JSON.stringify(b), { status });

test('no key: no network call, firecrawl needs-key, fixed cards for the rest', async () => {
  const m = mock(async () => json(okBody));
  const q = new QuotaService({ env: {}, fetch: m.f, claude });
  const out = await q.get(NOW);
  assert.equal(m.calls.length, 0);
  assert.equal(out.enabled, false);
  assert.deepEqual(out.providers.map((p) => [p.id, p.state]), [['claude', 'estimate'], ['firecrawl', 'needs-key'], ['crawl4ai', 'needs-key'], ['perplexity', 'unavailable']]);
  assert.equal(out.providers[1].env, 'FIRECRAWL_API_KEY');
  assert.equal(out.low, false);
});

test('firecrawl: one GET to the documented URL with a bearer key, shaped card, low flag', async () => {
  const m = mock(async () => json(okBody));
  const q = new QuotaService({ env: { FIRECRAWL_API_KEY: KEY }, fetch: m.f, claude });
  const out = await q.get(NOW);
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].url, FIRECRAWL_URL);
  assert.equal(m.calls[0].init.method, 'GET');
  assert.equal(/** @type {any} */ (m.calls[0].init.headers).Authorization, `Bearer ${KEY}`);
  const fc = out.providers[1];
  assert.deepEqual([fc.state, fc.remaining, fc.limit, fc.used, fc.low], ['ok', 150, 1000, 850, true]); // 15% < 20%
  assert.equal(out.low, true);
  assert.equal(JSON.stringify(out).includes(KEY), false);
});

test('firecrawl: not low at or above 20%', () => {
  const c = shapeFirecrawl({ data: { remainingCredits: 200, planCredits: 1000 } }, NOW);
  assert.equal(c.low, false);
});

test('cache: calls inside the TTL reuse the answer; after it, one new call', async () => {
  const m = mock(async () => json(okBody));
  const q = new QuotaService({ env: { FIRECRAWL_API_KEY: KEY }, fetch: m.f, claude, ttlMs: 300_000 });
  await q.get(NOW);
  await q.get(NOW + 2_000);
  await q.get(NOW + 299_000);
  assert.equal(m.calls.length, 1);
  await q.get(NOW + 301_000);
  assert.equal(m.calls.length, 2);
});

test('concurrent requests share one call', async () => {
  const m = mock(async () => json(okBody));
  const q = new QuotaService({ env: { FIRECRAWL_API_KEY: KEY }, fetch: m.f, claude });
  await Promise.all([q.get(NOW), q.get(NOW), q.get(NOW)]);
  assert.equal(m.calls.length, 1);
});

test('errors are cached too (no retry loop) and never contain the key', async () => {
  const m = mock(async () => json({ error: `bad key ${KEY}` }, 401));
  const q = new QuotaService({ env: { FIRECRAWL_API_KEY: KEY }, fetch: m.f, claude });
  const a = await q.get(NOW);
  await q.get(NOW + 10_000);
  assert.equal(m.calls.length, 1);
  assert.equal(a.providers[1].state, 'error');
  assert.match(a.providers[1].note, /rejected/);
  assert.equal(JSON.stringify(a).includes(KEY), false);
});

test('network failure and timeout become fixed phrases, key redacted', async () => {
  const boom = mock(async () => { throw new Error(`connect failed for ${KEY}`); });
  const a = await new QuotaService({ env: { FIRECRAWL_API_KEY: KEY }, fetch: boom.f, claude }).get(NOW);
  assert.equal(a.providers[1].state, 'error');
  assert.equal(JSON.stringify(a).includes(KEY), false);
  const slow = mock(async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); });
  const b = await new QuotaService({ env: { FIRECRAWL_API_KEY: KEY }, fetch: slow.f, claude }).get(NOW);
  assert.match(b.providers[1].note, /in time/);
});

test('malformed JSON body becomes an error card', async () => {
  const m = mock(async () => new Response('not json', { status: 200 }));
  const a = await new QuotaService({ env: { FIRECRAWL_API_KEY: KEY }, fetch: m.f, claude }).get(NOW);
  assert.equal(a.providers[1].state, 'error');
  assert.equal(shapeFirecrawl({ data: { remainingCredits: 'x' } }, NOW).state, 'error');
});

test('redact', () => {
  assert.equal(redact(`a ${KEY} b`, KEY), 'a [key] b');
  assert.equal(redact('a', ''), 'a');
});

test('usage: parseUsage dedupes streamed messages, windows are rolling', () => {
  const line = (/** @type {string} */ id, /** @type {number} */ ago, /** @type {number} */ out) => JSON.stringify({
    type: 'assistant', timestamp: new Date(NOW - ago).toISOString(), requestId: 'r' + id,
    message: { id, usage: { input_tokens: 10, output_tokens: out, cache_creation_input_tokens: 5, cache_read_input_tokens: 9999 } },
  });
  const text = [
    line('a', 1000, 1), line('a', 1000, 20), // same message streamed twice: the last wins
    line('b', FIVE_HOURS + 60_000, 100), // outside 5 h, inside 7 d
    line('c', 8 * 24 * 3600_000, 100), // outside 7 d
    '{broken', JSON.stringify({ type: 'user', timestamp: new Date(NOW).toISOString() }),
  ].join('\n');
  const entries = parseUsage(text);
  assert.equal(entries.length, 3);
  assert.deepEqual(windows(entries, NOW), { fiveHour: 35, week: 150 }); // 10+20+5, then + 10+100+5
});

test('usage: ClaudeUsage scans transcripts, ignores old files, caches', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-radar-usage-'));
  try {
    mkdirSync(join(root, 'proj'), { recursive: true });
    writeFileSync(join(root, 'proj', 's.jsonl'), JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - 1000).toISOString(), message: { id: 'm', usage: { input_tokens: 1, output_tokens: 2 } } }));
    utimesSync(join(root, 'proj', 's.jsonl'), NOW / 1000, NOW / 1000); // the file's mtime = the fake "now", so the test never depends on the real clock
    const u = new ClaudeUsage({ projectsDir: root });
    const e = u.estimate(NOW);
    assert.deepEqual([e.fiveHour, e.week, e.files], [3, 3, 1]);
    assert.equal(u.estimate(NOW + 1000), e); // cached for the TTL
    assert.deepEqual(new ClaudeUsage({ projectsDir: root }).estimate(NOW + 8 * 24 * 3600_000).week, 0); // file untouched for 7 days: skipped
    const v = new ClaudeUsage({ projectsDir: join(root, 'missing') });
    assert.match(v.estimate(NOW).warnings[0], /No Claude transcripts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('server: /api/quotas is GET-only JSON from the cache and never carries the key', async () => {
  const m = mock(async () => json(okBody));
  const q = new QuotaService({ env: { FIRECRAWL_API_KEY: KEY }, fetch: m.f, claude });
  const server = createBoardServer(new SessionReader({ desktopDir: null, registryDir: '/none' }), () => NOW, q);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  try {
    const r = await fetch(`${base}/api/quotas`);
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.equal(text.includes(KEY), false);
    assert.equal(JSON.parse(text).providers.length, 4);
    await fetch(`${base}/api/quotas`);
    assert.equal(m.calls.length, 1);
    assert.equal((await fetch(`${base}/api/quotas`, { method: 'POST' })).status, 405);
  } finally {
    server.close();
  }
});

test('crawl4ai: GET balance only, mc converted to credits, no low flag, no other route called', async () => {
  const m = mock(async (url) => (url === CRAWL4AI_URL ? json(c4Body) : json(okBody)));
  const q = new QuotaService({ env: { CRAWL4AI_API_KEY: 'sk_live_secret' }, fetch: m.f, claude });
  const out = await q.get(NOW);
  assert.equal(m.calls.length, 1); // firecrawl has no key: only crawl4ai is called
  assert.equal(m.calls[0].url, 'https://api.crawl4ai.com/v1/billing/balance');
  assert.equal(m.calls[0].init.method, 'GET');
  assert.equal(/** @type {any} */ (m.calls[0].init.headers).Authorization, 'Bearer sk_live_secret');
  const c = out.providers[2];
  assert.deepEqual(c.rows, [{ label: 'Free credits (2026-11)', value: '1,000' }, { label: 'Bought credits', value: '5' }, { label: 'Spent this month', value: '1.5' }]);
  assert.equal(c.remaining, 1005);
  assert.equal(c.low, undefined);
  assert.equal(out.enabled, true);
  assert.equal(out.providers[1].state, 'needs-key');
  assert.equal(JSON.stringify(out).includes('sk_live_secret'), false);
});

test('crawl4ai: errors and odd bodies are cached error cards without the key', async () => {
  const m = mock(async () => json({ detail: 'sk_live_secret' }, 500));
  const q = new QuotaService({ env: { CRAWL4AI_API_KEY: 'sk_live_secret' }, fetch: m.f, claude });
  const a = await q.get(NOW);
  await q.get(NOW + 1000);
  assert.equal(m.calls.length, 1);
  assert.equal(a.providers[2].state, 'error');
  assert.equal(JSON.stringify(a).includes('sk_live_secret'), false);
  assert.equal(shapeCrawl4ai({ free_mc: 'x' }, NOW).state, 'error');
});

test('both keys set: each provider is called once, in parallel, and cached separately', async () => {
  const m = mock(async (url) => (url === CRAWL4AI_URL ? json(c4Body) : json(okBody)));
  const q = new QuotaService({ env: { FIRECRAWL_API_KEY: KEY, CRAWL4AI_API_KEY: 'sk_live_secret' }, fetch: m.f, claude });
  await Promise.all([q.get(NOW), q.get(NOW)]);
  await q.get(NOW + 5000);
  assert.deepEqual(m.calls.map((c) => c.url).sort(), [CRAWL4AI_URL, FIRECRAWL_URL].sort());
});
