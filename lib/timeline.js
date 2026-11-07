// Built from the transcript ~/.claude/projects/<project>/<cliSessionId>.jsonl, read-only:
// - timeline (when you open a thread): each turn has your message, the tools used (name and count only) and the final answer;
// - latest message (for the line on a card): only a short excerpt from the end of the file.
// Tool contents, thinking and tool results are never kept.

const PROMPT_MAX = 700;
const REPLY_MAX = 1600;
export const MAX_TURNS = 60;
const LATEST_MAX = 240;

/**
 * @param {string} text
 * @param {number} max
 */
function clip(text, max) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * Clip but keep line breaks and lists (for the timeline, where the page renders markdown).
 * @param {string} text
 * @param {number} max
 */
function clipKeep(text, max) {
  const t = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  // prefer cutting at the end of a line; otherwise at a space; otherwise cut straight
  let at = cut.lastIndexOf('\n');
  if (at < max * 0.6) at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/**
 * Your real message (not a system notice injected into the transcript). undefined = skip.
 * @param {unknown} content
 */
function promptText(content) {
  let text;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((b) => b?.type === 'tool_result')) return undefined;
    text = content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  }
  if (!text?.trim()) return undefined;
  const cmd = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(text);
  if (cmd) return `Command ${cmd[1]}`;
  if (text.trimStart().startsWith('<')) return undefined;
  return text;
}

/** @param {unknown} n */
const toolName = (n) => (typeof n === 'string' ? n.replace(/^mcp__.*__/, '') : 'tool');

/**
 * Strip markdown marks so the line on a card reads easily.
 * @param {string} text
 */
function plain(text) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/^\s*(#{1,6}|[-*>]|\d+\.)\s+/gm, '').replace(/\*\*|__|`/g, '');
}

/**
 * Latest message of a thread (yours or Claude's), from the end of its transcript. null if there is none.
 * @param {string} text
 * @returns {import('./model.js').LatestMessage | null}
 */
export function latestMessage(text) {
  const lines = text.split('\n');
  /** @type {import('./model.js').LatestMessage | undefined} */
  let a;
  /** @type {import('./model.js').LatestMessage | undefined} */
  let u;
  for (let i = lines.length - 1; i >= 0 && !(a && u); i--) {
    if (!lines[i].trim()) continue;
    let j;
    try {
      j = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!j || j.isSidechain) continue;
    const at = Date.parse(j.timestamp);
    if (!Number.isFinite(at)) continue;
    const content = j.message?.content;
    if (!a && j.type === 'assistant' && Array.isArray(content)) {
      const t = [...content].reverse().find((b) => b?.type === 'text' && typeof b.text === 'string' && plain(b.text).trim());
      if (t) a = { role: 'assistant', at, text: clip(plain(t.text), LATEST_MAX) };
    } else if (!u && j.type === 'user' && !j.isMeta) {
      const p = promptText(content);
      if (p !== undefined && plain(p).trim()) u = { role: 'user', at, text: clip(plain(p), LATEST_MAX) };
    }
  }
  if (a && u) return a.at >= u.at ? a : u;
  return a ?? u ?? null;
}

/**
 * @param {string} text contents of the .jsonl file
 * @returns {{turns: object[], omitted: number}} the turns, newest first
 */
export function parseTranscript(text, maxTurns = MAX_TURNS) {
  const turns = [];
  let cur;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (!j || j.isSidechain) continue;
    const at = Date.parse(j.timestamp);
    if (!Number.isFinite(at)) continue;
    const content = j.message?.content;
    if (j.type === 'user') {
      const p = j.isMeta ? undefined : promptText(content);
      if (p !== undefined) {
        cur = { at, end: at, prompt: clipKeep(p, PROMPT_MAX), tools: new Map(), reply: '' };
        turns.push(cur);
      } else if (cur) cur.end = Math.max(cur.end, at);
    } else if (j.type === 'assistant' && cur && Array.isArray(content)) {
      cur.end = Math.max(cur.end, at);
      for (const b of content) {
        if (b?.type === 'tool_use') cur.tools.set(toolName(b.name), (cur.tools.get(toolName(b.name)) ?? 0) + 1);
        else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) cur.reply = clipKeep(b.text, REPLY_MAX);
      }
    }
  }
  const out = turns.map((t) => ({
    at: t.at, end: t.end, durationMs: t.end - t.at, prompt: t.prompt, reply: t.reply,
    tools: [...t.tools].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n })),
  }));
  out.reverse();
  return { turns: out.slice(0, maxTurns), omitted: Math.max(0, out.length - maxTurns) };
}
