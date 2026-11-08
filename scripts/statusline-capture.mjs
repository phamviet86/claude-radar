#!/usr/bin/env node
// Claude Code status line command: saves the plan limits (5-hour and 7-day percent used) for Claude Radar and prints a short line.
// Claude Code sends a JSON on stdin; only `rate_limits` is kept (percentages and reset times, nothing else) and it is written
// to one small file (see usageFile in lib/usage.js). It never touches the network and never throws: a status line must not break.
// Setup: see "Plan limits" in the README.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { extractRateLimits, usageFile } from '../lib/usage.js';

try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const lim = extractRateLimits(JSON.parse(raw));
  if (lim) {
    const file = usageFile();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, at: Date.now(), fiveHour: lim.fiveHour, week: lim.week }), { mode: 0o600 });
    renameSync(tmp, file);
    const p = (/** @type {{percent: number} | null} */ w) => (w ? `${Math.round(w.percent)}%` : '-');
    process.stdout.write(`5h ${p(lim.fiveHour)} · 7d ${p(lim.week)}`);
  }
} catch {
  /* expected: odd input; print nothing */
}
