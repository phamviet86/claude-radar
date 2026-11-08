// Quotas panel. OPT-IN: with FIRECRAWL_API_KEY unset this module makes no network call and reads no key.
// Providers:
// - Claude: local token estimate from transcripts (lib/usage.js); never calls the network.
// - Firecrawl: GET https://api.firecrawl.dev/v2/team/credit-usage with the key (documented endpoint, read-only), only when the key is set.
// - Crawl4AI Cloud: GET https://api.crawl4ai.com/v1/billing/balance with the key (read-only; found in the console's API reference), only when CRAWL4AI_API_KEY is set.
//   The same API has routes that spend money or change limits (/v1/billing/topup, /subscribe, /settings): they are never called.
// Keys are read from the environment on the server only: never logged, never put in a card, never sent to the browser,
// never written to disk. Each external provider is called at most once per TTL (errors are cached too); no retries.
import { ClaudeUsage, readLimits, usageFile } from './usage.js';

export const FIRECRAWL_URL = 'https://api.firecrawl.dev/v2/team/credit-usage';
export const FIRECRAWL_ENV = 'FIRECRAWL_API_KEY';
export const CRAWL4AI_URL = 'https://api.crawl4ai.com/v1/billing/balance';
export const CRAWL4AI_ENV = 'CRAWL4AI_API_KEY';
export const LOW_FRACTION = 0.2;
const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 8_000;

/**
 * @typedef {{percent: number, resetsAt: number, reset: boolean}} PlanWindow
 * @typedef {'ok' | 'estimate' | 'needs-key' | 'unavailable' | 'error'} QuotaState
 * @typedef {{
 *   id: string, label: string, state: QuotaState, note: string, link?: string, env?: string,
 *   used?: number, limit?: number, remaining?: number, unit?: string, periodEnd?: string | null,
 *   plan?: {at: number, fiveHour: PlanWindow | null, week: PlanWindow | null},
 *   windows?: {label: string, used: number}[], rows?: {label: string, value: string}[], low?: boolean, fetchedAt?: number,
 * }} QuotaCard
 */

/**
 * Card for Firecrawl from the response body. Anything unexpected becomes an error card.
 * @param {unknown} body
 * @param {number} now
 * @returns {QuotaCard}
 */
export function shapeFirecrawl(body, now) {
  const base = { id: 'firecrawl', label: 'Firecrawl', link: 'https://www.firecrawl.dev/app/usage', env: FIRECRAWL_ENV, unit: 'credits', fetchedAt: now };
  const d = /** @type {any} */ (body)?.data;
  if (!d || typeof d.remainingCredits !== 'number' || typeof d.planCredits !== 'number') {
    return { ...base, state: 'error', note: 'Unexpected response format.' };
  }
  const limit = d.planCredits;
  const remaining = d.remainingCredits;
  return {
    ...base, state: 'ok', note: '', remaining, limit, used: Math.max(0, limit - remaining),
    periodEnd: typeof d.billingPeriodEnd === 'string' ? d.billingPeriodEnd : null,
    low: limit > 0 && remaining / limit < LOW_FRACTION,
  };
}

/**
 * Card for Crawl4AI Cloud from the balance response. Amounts come in "mc" (1000 mc = 1 credit). The response states no plan
 * limit we can rely on, so the bar total is derived (see below) and there is no "low" flag.
 * @param {unknown} body
 * @param {number} now
 * @returns {QuotaCard}
 */
export function shapeCrawl4ai(body, now) {
  const base = { id: 'crawl4ai', label: 'Crawl4AI Cloud', link: 'https://crawl4ai.com/dashboard/', env: CRAWL4AI_ENV, unit: 'credits', fetchedAt: now };
  const b = /** @type {any} */ (body);
  const ok = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isFinite(v);
  if (!b || !ok(b.free_mc) || !ok(b.credit_mc)) return { ...base, state: 'error', note: 'Unexpected response format.' };
  const cr = (/** @type {number} */ mc) => (mc / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 });
  /** @type {{label: string, value: string}[]} */
  const rows = [{ label: `Free credits${typeof b.free_period === 'string' ? ` (${b.free_period})` : ''}`, value: cr(b.free_mc) }, { label: 'Bought credits', value: cr(b.credit_mc) }];
  if (ok(b.spend_month_mc)) rows.push({ label: 'Spent this month', value: cr(b.spend_month_mc) });
  // the response has no plan limit we can rely on: the bar's total is what this month offered = spent + free left + bought left
  const spent = ok(b.spend_month_mc) ? b.spend_month_mc : 0;
  const remaining = (b.free_mc + b.credit_mc) / 1000;
  return { ...base, state: 'ok', note: typeof b.tier === 'string' && b.tier ? `Tier: ${b.tier}` : '', rows, remaining, used: spent / 1000, limit: remaining + spent / 1000 };
}

/**
 * Claude card. With limits captured from the status line (percent used and reset times, as on claude.ai/settings/usage)
 * it shows those; without them, only the local token estimate (no percentage: the plan limit is not public).
 * @param {{fiveHour: number, week: number}} u
 * @param {number} now
 * @param {{at: number, fiveHour: PlanWindow | null, week: PlanWindow | null} | null} [plan]
 * @returns {QuotaCard}
 */
export function shapeClaude(u, now, plan = null) {
  return {
    id: 'claude', label: 'Claude', state: plan ? 'ok' : 'estimate', unit: 'tokens', fetchedAt: now,
    note: plan
      ? 'Plan limits captured from the Claude Code status line. Tokens are a local estimate (input + output + cache creation).'
      : 'Estimate from local transcripts (input + output + cache creation). For the plan percentages, set up the status line capture (see README).',
    link: 'https://claude.ai/settings/usage',
    windows: [{ label: 'Last 5 hours', used: u.fiveHour }, { label: 'Last 7 days', used: u.week }],
    ...(plan ? { plan } : {}),
  };
}

/** External providers that have a read-only balance endpoint with a key. */
const EXTERNAL = [
  { id: 'firecrawl', label: 'Firecrawl', env: FIRECRAWL_ENV, url: FIRECRAWL_URL, shape: shapeFirecrawl },
  { id: 'crawl4ai', label: 'Crawl4AI Cloud', env: CRAWL4AI_ENV, url: CRAWL4AI_URL, shape: shapeCrawl4ai },
];

export class QuotaService {
  /**
   * @param {{env?: Record<string, string | undefined>, fetch?: typeof fetch, claude?: {estimate: (now: number) => {fiveHour: number, week: number, warnings?: string[]}},
   *   limits?: (now: number) => ReturnType<typeof readLimits>, projectsDir?: string, ttlMs?: number, timeoutMs?: number}} [opts]
   */
  constructor(opts = {}) {
    this.env = opts.env ?? process.env;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.claude = opts.claude ?? new ClaudeUsage({ projectsDir: opts.projectsDir });
    this.limits = opts.limits ?? ((/** @type {number} */ now) => readLimits(usageFile(this.env), now));
    this.ttlMs = opts.ttlMs ?? TTL_MS;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    /** @type {Map<string, {at: number, card: QuotaCard}>} */
    this.cache = new Map();
    /** @type {Map<string, Promise<QuotaCard>>} */
    this.inflight = new Map();
  }

  /** @param {typeof EXTERNAL[number]} p */
  #key(p) {
    return this.env[p.env]?.trim() || '';
  }

  /**
   * @param {typeof EXTERNAL[number]} p
   * @param {number} now
   * @returns {Promise<QuotaCard>}
   */
  async #external(p, now) {
    const key = this.#key(p);
    if (!key) return { id: p.id, label: p.label, state: 'needs-key', env: p.env, note: 'Chưa bật' };
    const hit = this.cache.get(p.id);
    if (hit && now - hit.at < this.ttlMs && now >= hit.at) return hit.card;
    let call = this.inflight.get(p.id);
    if (!call) {
      call = this.#call(p, key, now).finally(() => this.inflight.delete(p.id));
      this.inflight.set(p.id, call);
    }
    return call;
  }

  /**
   * @param {typeof EXTERNAL[number]} p
   * @param {string} key
   * @param {number} now
   * @returns {Promise<QuotaCard>}
   */
  async #call(p, key, now) {
    /** @type {QuotaCard} */
    let card;
    try {
      const res = await this.fetch(p.url, {
        method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) card = { ...p.shape(null, now), note: res.status === 401 || res.status === 403 ? `Key rejected (HTTP ${res.status}).` : `HTTP ${res.status} from ${p.label}.` };
      else card = p.shape(await res.json(), now);
    } catch (e) {
      // never put the raw error in the card: it could echo the request. Only a fixed phrase.
      const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      card = { ...p.shape(null, now), note: timeout ? `${p.label} did not answer in time.` : `Could not reach ${p.label}.` };
    }
    card.note = redact(card.note, key);
    this.cache.set(p.id, { at: now, card });
    return card;
  }

  /** @param {number} now */
  async get(now = Date.now()) {
    const u = this.claude.estimate(now);
    const external = await Promise.all(EXTERNAL.map((p) => this.#external(p, now)));
    const providers = [shapeClaude(u, now, this.limits(now)), ...external];
    return {
      enabled: EXTERNAL.some((p) => this.#key(p)),
      envNames: EXTERNAL.map((p) => p.env),
      low: providers.some((p) => p.low),
      providers,
      warnings: u.warnings ?? [],
    };
  }
}

/**
 * @param {string} text
 * @param {string} secret
 */
export function redact(text, secret) {
  return secret ? text.split(secret).join('[key]') : text;
}
