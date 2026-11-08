// Quotas panel. OPT-IN: with FIRECRAWL_API_KEY unset this module makes no network call and reads no key.
// Providers:
// - Claude: local token estimate from transcripts (lib/usage.js); never calls the network.
// - Firecrawl: GET https://api.firecrawl.dev/v2/team/credit-usage with the key (documented endpoint, read-only), only when the key is set.
// - Crawl4AI Cloud: its docs list no REST balance endpoint (only the OAuth MCP "balance" tool), so it is "unavailable".
// - Perplexity: no balance API (the web console only), so it is a link card.
// Keys are read from the environment on the server only: never logged, never put in a card, never sent to the browser,
// never written to disk. Each external provider is called at most once per TTL (errors are cached too); no retries.
import { ClaudeUsage } from './usage.js';

export const FIRECRAWL_URL = 'https://api.firecrawl.dev/v2/team/credit-usage';
export const FIRECRAWL_ENV = 'FIRECRAWL_API_KEY';
export const LOW_FRACTION = 0.2;
const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 8_000;

/**
 * @typedef {'ok' | 'estimate' | 'needs-key' | 'unavailable' | 'error'} QuotaState
 * @typedef {{
 *   id: string, label: string, state: QuotaState, note: string, link?: string, env?: string,
 *   used?: number, limit?: number, remaining?: number, unit?: string, periodEnd?: string | null,
 *   windows?: {label: string, used: number}[], low?: boolean, fetchedAt?: number,
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
 * @param {{fiveHour: number, week: number}} u
 * @param {number} now
 * @returns {QuotaCard}
 */
export function shapeClaude(u, now) {
  return {
    id: 'claude', label: 'Claude', state: 'estimate', unit: 'tokens', fetchedAt: now,
    note: 'Estimate from local transcripts (input + output + cache creation). Plan limits are only shown on claude.ai.',
    link: 'https://claude.ai/settings/usage',
    windows: [{ label: 'Last 5 hours', used: u.fiveHour }, { label: 'Last 7 days', used: u.week }],
  };
}

const CRAWL4AI = /** @type {QuotaCard} */ ({
  id: 'crawl4ai', label: 'Crawl4AI Cloud', state: 'unavailable',
  note: 'No REST balance endpoint with an API key is documented (only the OAuth MCP "balance" tool).',
});
const PERPLEXITY = /** @type {QuotaCard} */ ({
  id: 'perplexity', label: 'Perplexity', state: 'unavailable', link: 'https://console.perplexity.ai/project/billing',
  note: 'No API for the balance: open the billing page in the console.',
});

export class QuotaService {
  /**
   * @param {{env?: Record<string, string | undefined>, fetch?: typeof fetch, claude?: {estimate: (now: number) => {fiveHour: number, week: number, warnings?: string[]}},
   *   projectsDir?: string, ttlMs?: number, timeoutMs?: number}} [opts]
   */
  constructor(opts = {}) {
    this.env = opts.env ?? process.env;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.claude = opts.claude ?? new ClaudeUsage({ projectsDir: opts.projectsDir });
    this.ttlMs = opts.ttlMs ?? TTL_MS;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    /** @type {{at: number, card: QuotaCard} | null} */
    this.firecrawl = null;
    /** @type {Promise<QuotaCard> | null} */
    this.inflight = null;
  }

  #key() {
    return this.env[FIRECRAWL_ENV]?.trim() || '';
  }

  /** @param {number} now */
  async #firecrawl(now) {
    const key = this.#key();
    if (!key) return { id: 'firecrawl', label: 'Firecrawl', state: /** @type {const} */ ('needs-key'), env: FIRECRAWL_ENV, note: 'Chưa bật' };
    if (this.firecrawl && now - this.firecrawl.at < this.ttlMs && now >= this.firecrawl.at) return this.firecrawl.card;
    this.inflight ??= this.#call(key, now).finally(() => (this.inflight = null));
    return this.inflight;
  }

  /**
   * @param {string} key
   * @param {number} now
   * @returns {Promise<QuotaCard>}
   */
  async #call(key, now) {
    /** @type {QuotaCard} */
    let card;
    try {
      const res = await this.fetch(FIRECRAWL_URL, {
        method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) card = { ...shapeFirecrawl(null, now), note: res.status === 401 || res.status === 403 ? `Key rejected (HTTP ${res.status}).` : `HTTP ${res.status} from Firecrawl.` };
      else card = shapeFirecrawl(await res.json(), now);
    } catch (e) {
      // never put the raw error in the card: it could echo the request. Only a fixed phrase.
      const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      card = { ...shapeFirecrawl(null, now), note: timeout ? 'Firecrawl did not answer in time.' : 'Could not reach Firecrawl.' };
    }
    card.note = redact(card.note, key);
    this.firecrawl = { at: now, card };
    return card;
  }

  /** @param {number} now */
  async get(now = Date.now()) {
    const u = this.claude.estimate(now);
    const providers = [shapeClaude(u, now), await this.#firecrawl(now), CRAWL4AI, PERPLEXITY];
    return {
      enabled: Boolean(this.#key()),
      envNames: [FIRECRAWL_ENV],
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
