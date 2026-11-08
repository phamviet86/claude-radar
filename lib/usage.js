// Local estimate of Claude token use, from the transcripts ~/.claude/projects/*/<id>.jsonl (read-only, no network).
// It is an ESTIMATE: Claude's real plan bars are internal to Claude and have no public endpoint. Tokens counted per
// assistant message = input + output + cache creation (cache reads are left out). Windows are rolling: the last 5 hours
// and the last 7 days, not the plan's own reset times.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const FIVE_HOURS = 5 * 3600_000;
export const SEVEN_DAYS = 7 * 24 * 3600_000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** @typedef {{at: number, tokens: number}} UsageEntry */

/**
 * Token entries of one transcript. A streamed message can appear on several lines: the last one wins.
 * @param {string} text contents of the .jsonl file
 * @returns {UsageEntry[]}
 */
export function parseUsage(text) {
  /** @type {Map<string, UsageEntry>} */
  const seen = new Map();
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const u = j?.type === 'assistant' ? j.message?.usage : undefined;
    const at = Date.parse(j?.timestamp);
    if (!u || !Number.isFinite(at)) continue;
    const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    const tokens = num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens);
    const id = j.message?.id ? `${j.message.id}:${j.requestId ?? ''}` : `#${n++}`;
    seen.set(id, { at, tokens });
  }
  return [...seen.values()];
}

/**
 * @param {UsageEntry[]} entries
 * @param {number} now
 */
export function windows(entries, now) {
  let fiveHour = 0;
  let week = 0;
  for (const e of entries) {
    if (e.at > now) continue;
    if (e.at >= now - SEVEN_DAYS) week += e.tokens;
    if (e.at >= now - FIVE_HOURS) fiveHour += e.tokens;
  }
  return { fiveHour, week };
}

export class ClaudeUsage {
  /** @param {{projectsDir?: string, ttlMs?: number}} [opts] */
  constructor(opts = {}) {
    this.projectsDir = opts.projectsDir ?? join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'), 'projects');
    this.ttlMs = opts.ttlMs ?? 60_000;
    /** @type {Map<string, {mtimeMs: number, size: number, entries: UsageEntry[]}>} */
    this.files = new Map();
    /** @type {{at: number, value: {fiveHour: number, week: number, files: number, warnings: string[]}} | null} */
    this.last = null;
  }

  /** @param {number} now */
  estimate(now) {
    if (this.last && now - this.last.at < this.ttlMs && now >= this.last.at) return this.last.value;
    const warnings = [];
    const entries = [];
    const live = new Set();
    /** @type {import('node:fs').Dirent[]} */
    let projects = [];
    try {
      projects = readdirSync(this.projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      warnings.push(`No Claude transcripts found in ${this.projectsDir}.`);
    }
    for (const p of projects) {
      let names = [];
      try {
        names = readdirSync(join(this.projectsDir, p.name)).filter((n) => n.endsWith('.jsonl'));
      } catch {
        continue; // expected: the folder vanished or cannot be read
      }
      for (const n of names) {
        const file = join(this.projectsDir, p.name, n);
        try {
          const st = statSync(file);
          if (st.mtimeMs < now - SEVEN_DAYS) continue; // untouched for 7 days: nothing in the window
          if (st.size > MAX_FILE_BYTES) {
            warnings.push('A very large transcript was skipped in the token estimate.');
            continue;
          }
          live.add(file);
          let hit = this.files.get(file);
          if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
            hit = { mtimeMs: st.mtimeMs, size: st.size, entries: parseUsage(readFileSync(file, 'utf8')) };
            this.files.set(file, hit);
          }
          for (const e of hit.entries) entries.push(e);
        } catch {
          /* expected: the file vanished or cannot be read */
        }
      }
    }
    for (const f of [...this.files.keys()]) if (!live.has(f)) this.files.delete(f);
    const value = { ...windows(entries, now), files: live.size, warnings };
    this.last = { at: now, value };
    return value;
  }
}
