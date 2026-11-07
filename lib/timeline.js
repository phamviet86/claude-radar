// Dựng từ tệp hội thoại ~/.claude/projects/<dự án>/<cliSessionId>.jsonl, chỉ đọc:
// - timeline (khi bạn mở một thread): mỗi lượt gồm lời bạn nhắn, các công cụ đã dùng (chỉ tên và số lần) và câu trả lời cuối;
// - tin nhắn mới nhất (cho dòng chữ trên thẻ): chỉ lấy một đoạn ngắn từ phần cuối tệp.
// Nội dung công cụ, suy nghĩ và kết quả công cụ không bao giờ được giữ lại.

const PROMPT_MAX = 700;
const REPLY_MAX = 1600;
export const MAX_TURNS = 60;
const LATEST_MAX = 240;

function clip(text, max) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Cắt ngắn nhưng giữ xuống dòng và danh sách (cho timeline, nơi giao diện vẽ markdown). */
function clipKeep(text, max) {
  const t = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  // ưu tiên cắt ở cuối một dòng; không có thì ở một khoảng trắng; không có nữa thì cắt thẳng
  let at = cut.lastIndexOf('\n');
  if (at < max * 0.6) at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/** Lời bạn nhắn thật (không phải thông báo hệ thống chèn vào). undefined = bỏ qua. */
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

const toolName = (n) => (typeof n === 'string' ? n.replace(/^mcp__.*__/, '') : 'tool');

/** Bỏ ký hiệu markdown để dòng chữ trên thẻ dễ đọc. */
function plain(text) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/^\s*(#{1,6}|[-*>]|\d+\.)\s+/gm, '').replace(/\*\*|__|`/g, '');
}

/**
 * Tin nhắn mới nhất của thread (của bạn hoặc của Claude), từ phần cuối của tệp hội thoại. null nếu không có.
 * @returns {{role: 'user'|'assistant', text: string, at: number} | null}
 */
export function latestMessage(text) {
  const lines = text.split('\n');
  let a;
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
 * @param {string} text nội dung tệp .jsonl
 * @returns {{turns: object[], omitted: number}} các lượt, mới nhất trước
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
