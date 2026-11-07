// Timeline của một thread, dựng từ tệp hội thoại ~/.claude/projects/<dự án>/<cliSessionId>.jsonl.
// Chỉ đọc, chỉ khi bạn mở thread, và chỉ giữ phần rút gọn: mỗi lượt gồm lời bạn nhắn, các công cụ đã dùng (chỉ tên và số
// lần) và câu trả lời cuối của Claude. Nội dung công cụ, suy nghĩ và kết quả công cụ không bao giờ được giữ lại.

const PROMPT_MAX = 320;
const REPLY_MAX = 520;
export const MAX_TURNS = 60;

function clip(text, max) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
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
  if (cmd) return `Lệnh ${cmd[1]}`;
  if (text.trimStart().startsWith('<')) return undefined;
  return clip(text, PROMPT_MAX);
}

const toolName = (n) => (typeof n === 'string' ? n.replace(/^mcp__.*__/, '') : 'công cụ');

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
        cur = { at, end: at, prompt: p, tools: new Map(), reply: '' };
        turns.push(cur);
      } else if (cur) cur.end = Math.max(cur.end, at);
    } else if (j.type === 'assistant' && cur && Array.isArray(content)) {
      cur.end = Math.max(cur.end, at);
      for (const b of content) {
        if (b?.type === 'tool_use') cur.tools.set(toolName(b.name), (cur.tools.get(toolName(b.name)) ?? 0) + 1);
        else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) cur.reply = clip(b.text, REPLY_MAX);
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
