import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headline, parseTranscript } from '../lib/timeline.js';

const line = (o) => JSON.stringify(o);
const T = (s) => `2026-11-07T10:00:${String(s).padStart(2, '0')}.000Z`;
const user = (s, content, extra = {}) => line({ type: 'user', timestamp: T(s), message: { role: 'user', content }, ...extra });
const asst = (s, content, extra = {}) => line({ type: 'assistant', timestamp: T(s), message: { role: 'assistant', content }, ...extra });

test('timeline: each turn has your message, the tools used and the final answer', () => {
  const text = [
    user(0, 'fix the login bug'),
    asst(2, [{ type: 'thinking', thinking: 'secret' }, { type: 'tool_use', name: 'Read', input: { file: '/a' } }]),
    user(3, [{ type: 'tool_result', content: 'very long file contents' }]),
    asst(5, [{ type: 'tool_use', name: 'Edit', input: {} }, { type: 'tool_use', name: 'Edit', input: {} }, { type: 'tool_use', name: 'mcp__srv__tim_kiem', input: {} }]),
    asst(8, [{ type: 'text', text: 'Fixed.' }]),
    user(30, 'please run it'),
    asst(40, [{ type: 'text', text: 'All tests pass.' }]),
  ].join('\n');
  const { turns, omitted } = parseTranscript(text);
  assert.equal(omitted, 0);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].prompt, 'please run it'); // newest first
  assert.equal(turns[0].reply, 'All tests pass.');
  assert.equal(turns[1].prompt, 'fix the login bug');
  assert.equal(turns[1].reply, 'Fixed.');
  assert.deepEqual(turns[1].tools, [{ name: 'Edit', n: 2 }, { name: 'Read', n: 1 }, { name: 'tim_kiem', n: 1 }]);
  assert.equal(turns[1].durationMs, 8000);
});

test('timeline: keeps no thinking, tool results or tool contents', () => {
  const text = [user(0, 'hi'), asst(1, [{ type: 'thinking', thinking: 'MẬT-1' }, { type: 'tool_use', name: 'Bash', input: { command: 'MẬT-2' } }]), user(2, [{ type: 'tool_result', content: 'MẬT-3' }])].join('\n');
  assert.ok(!JSON.stringify(parseTranscript(text)).includes('MẬT'));
});

test('timeline: skips side threads, system notices and broken lines; slash commands become "Command …"', () => {
  const text = [
    '{broken',
    user(0, '<system-reminder>hidden</system-reminder>'),
    user(1, 'real message'),
    asst(2, [{ type: 'text', text: 'from a side thread' }], { isSidechain: true }),
    user(3, 'notice', { isMeta: true }),
    user(4, '<command-name>/compact</command-name><command-args></command-args>'),
  ].join('\n');
  const { turns } = parseTranscript(text);
  assert.deepEqual(turns.map((t) => t.prompt), ['Command /compact', 'real message']);
  assert.equal(turns[1].reply, '');
});

test('timeline: clips long text and limits the number of turns', () => {
  const long = 'x'.repeat(2000);
  const many = Array.from({ length: 5 }, (_, i) => user(i, `turn ${i}`) + '\n' + asst(i, [{ type: 'text', text: long }])).join('\n');
  const { turns, omitted } = parseTranscript(many, 3);
  assert.equal(turns.length, 3);
  assert.equal(omitted, 2);
  assert.ok(turns[0].reply.length <= 1600);
  assert.equal(turns[0].prompt, 'turn 4');
});

import { latestMessage } from '../lib/timeline.js';

test('latestMessage: takes the latest message, strips markdown, skips side threads and thinking', () => {
  const text = [
    user(0, 'do this for me'),
    asst(2, [{ type: 'text', text: '## Result\n- **Fixed** `lib/a.js`\n```js\ncode\n```' }]),
    asst(5, [{ type: 'thinking', thinking: 'MẬT' }, { type: 'tool_use', name: 'Bash', input: {} }]),
    asst(6, [{ type: 'text', text: 'hidden' }], { isSidechain: true }),
  ].join('\n');
  const m = latestMessage(text);
  assert.equal(m.role, 'assistant');
  assert.equal(m.text, 'Result Fixed lib/a.js');
  assert.ok(!JSON.stringify(m).includes('MẬT'));
});

test('latestMessage: your message shows if it is newer; empty gives null', () => {
  const text = [asst(1, [{ type: 'text', text: 'old answer' }]), user(9, 'new question')].join('\n');
  assert.deepEqual(latestMessage(text), { role: 'user', at: Date.parse(T(9)), text: 'new question' });
  assert.equal(latestMessage(''), null);
  assert.equal(latestMessage('{broken\n'), null);
});

test('latestMessage: clips a long message', () => {
  const m = latestMessage(asst(1, [{ type: 'text', text: 'a '.repeat(500) }]));
  assert.ok(m.text.length <= 240);
});

test('timeline: keeps line breaks and markdown lists, cuts at a line boundary', () => {
  const reply = '**Changes:**\n- One\n- Two\n\n\n\nEnd';
  const { turns } = parseTranscript([user(0, 'line 1\r\nline 2'), asst(1, [{ type: 'text', text: reply }])].join('\n'));
  assert.equal(turns[0].prompt, 'line 1\nline 2');
  assert.equal(turns[0].reply, '**Changes:**\n- One\n- Two\n\nEnd');
  const long = Array.from({ length: 400 }, (_, i) => `- item ${i}`).join('\n');
  const cut = parseTranscript([user(0, 'x'), asst(1, [{ type: 'text', text: long }])].join('\n')).turns[0].reply;
  assert.ok(cut.length <= 1600 && cut.endsWith('…'));
  assert.ok(/item \d+…$/.test(cut)); // cut at the end of a line, not in the middle
});

test('latestMessage: your message also loses markdown list marks', () => {
  const m = latestMessage(user(0, 'key points:\n* make it bigger\n* show markdown'));
  assert.equal(m.text, 'key points: make it bigger show markdown');
});

test('headline: first non-empty line of a reply without markdown marks, clipped', () => {
  assert.equal(headline('\n## Fixed the login bug\n- more detail below'), 'Fixed the login bug');
  assert.equal(headline('**Done.** All tests pass.'), 'Done. All tests pass.');
  assert.equal(headline(''), '');
  assert.ok(headline('x'.repeat(500)).length <= 140);
  const { turns } = parseTranscript([user(0, 'go'), asst(1, [{ type: 'text', text: '## Result\n- fixed' }])].join('\n'));
  assert.equal(turns[0].headline, 'Result');
});
