import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from '../lib/timeline.js';

const line = (o) => JSON.stringify(o);
const T = (s) => `2026-11-07T10:00:${String(s).padStart(2, '0')}.000Z`;
const user = (s, content, extra = {}) => line({ type: 'user', timestamp: T(s), message: { role: 'user', content }, ...extra });
const asst = (s, content, extra = {}) => line({ type: 'assistant', timestamp: T(s), message: { role: 'assistant', content }, ...extra });

test('timeline: mỗi lượt gồm lời bạn nhắn, công cụ đã dùng và câu trả lời cuối', () => {
  const text = [
    user(0, 'sửa lỗi đăng nhập'),
    asst(2, [{ type: 'thinking', thinking: 'bí mật' }, { type: 'tool_use', name: 'Read', input: { file: '/a' } }]),
    user(3, [{ type: 'tool_result', content: 'nội dung tệp rất dài' }]),
    asst(5, [{ type: 'tool_use', name: 'Edit', input: {} }, { type: 'tool_use', name: 'Edit', input: {} }, { type: 'tool_use', name: 'mcp__srv__tim_kiem', input: {} }]),
    asst(8, [{ type: 'text', text: 'Đã sửa xong.' }]),
    user(30, 'chạy thử giúp'),
    asst(40, [{ type: 'text', text: 'Test đều qua.' }]),
  ].join('\n');
  const { turns, omitted } = parseTranscript(text);
  assert.equal(omitted, 0);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].prompt, 'chạy thử giúp'); // mới nhất trước
  assert.equal(turns[0].reply, 'Test đều qua.');
  assert.equal(turns[1].prompt, 'sửa lỗi đăng nhập');
  assert.equal(turns[1].reply, 'Đã sửa xong.');
  assert.deepEqual(turns[1].tools, [{ name: 'Edit', n: 2 }, { name: 'Read', n: 1 }, { name: 'tim_kiem', n: 1 }]);
  assert.equal(turns[1].durationMs, 8000);
});

test('timeline: không giữ suy nghĩ, kết quả công cụ hay nội dung công cụ', () => {
  const text = [user(0, 'hi'), asst(1, [{ type: 'thinking', thinking: 'MẬT-1' }, { type: 'tool_use', name: 'Bash', input: { command: 'MẬT-2' } }]), user(2, [{ type: 'tool_result', content: 'MẬT-3' }])].join('\n');
  assert.ok(!JSON.stringify(parseTranscript(text)).includes('MẬT'));
});

test('timeline: bỏ thread phụ, thông báo hệ thống, dòng hỏng; lệnh gạch chéo thành "Lệnh …"', () => {
  const text = [
    '{hỏng',
    user(0, '<system-reminder>ẩn</system-reminder>'),
    user(1, 'nhắn thật'),
    asst(2, [{ type: 'text', text: 'của thread phụ' }], { isSidechain: true }),
    user(3, 'thông báo', { isMeta: true }),
    user(4, '<command-name>/compact</command-name><command-args></command-args>'),
  ].join('\n');
  const { turns } = parseTranscript(text);
  assert.deepEqual(turns.map((t) => t.prompt), ['Command /compact', 'nhắn thật']);
  assert.equal(turns[1].reply, '');
});

test('timeline: cắt ngắn văn bản dài và giới hạn số lượt', () => {
  const long = 'x'.repeat(2000);
  const many = Array.from({ length: 5 }, (_, i) => user(i, `lượt ${i}`) + '\n' + asst(i, [{ type: 'text', text: long }])).join('\n');
  const { turns, omitted } = parseTranscript(many, 3);
  assert.equal(turns.length, 3);
  assert.equal(omitted, 2);
  assert.ok(turns[0].reply.length <= 1600);
  assert.equal(turns[0].prompt, 'lượt 4');
});

import { latestMessage } from '../lib/timeline.js';

test('latestMessage: lấy tin mới nhất, bỏ markdown, bỏ thread phụ và suy nghĩ', () => {
  const text = [
    user(0, 'làm giúp tôi'),
    asst(2, [{ type: 'text', text: '## Kết quả\n- **Đã sửa** `lib/a.js`\n```js\ncode\n```' }]),
    asst(5, [{ type: 'thinking', thinking: 'MẬT' }, { type: 'tool_use', name: 'Bash', input: {} }]),
    asst(6, [{ type: 'text', text: 'ẩn' }], { isSidechain: true }),
  ].join('\n');
  const m = latestMessage(text);
  assert.equal(m.role, 'assistant');
  assert.equal(m.text, 'Kết quả Đã sửa lib/a.js');
  assert.ok(!JSON.stringify(m).includes('MẬT'));
});

test('latestMessage: tin của bạn mới hơn thì hiện tin của bạn; rỗng thì null', () => {
  const text = [asst(1, [{ type: 'text', text: 'trả lời cũ' }]), user(9, 'câu hỏi mới')].join('\n');
  assert.deepEqual(latestMessage(text), { role: 'user', at: Date.parse(T(9)), text: 'câu hỏi mới' });
  assert.equal(latestMessage(''), null);
  assert.equal(latestMessage('{hỏng\n'), null);
});

test('latestMessage: cắt ngắn tin dài', () => {
  const m = latestMessage(asst(1, [{ type: 'text', text: 'a '.repeat(500) }]));
  assert.ok(m.text.length <= 240);
});

test('timeline: giữ xuống dòng và danh sách markdown, cắt ở ranh giới dòng', () => {
  const reply = '**Thay đổi:**\n- Một\n- Hai\n\n\n\nCuối';
  const { turns } = parseTranscript([user(0, 'dòng 1\r\ndòng 2'), asst(1, [{ type: 'text', text: reply }])].join('\n'));
  assert.equal(turns[0].prompt, 'dòng 1\ndòng 2');
  assert.equal(turns[0].reply, '**Thay đổi:**\n- Một\n- Hai\n\nCuối');
  const long = Array.from({ length: 400 }, (_, i) => `- mục số ${i}`).join('\n');
  const cut = parseTranscript([user(0, 'x'), asst(1, [{ type: 'text', text: long }])].join('\n')).turns[0].reply;
  assert.ok(cut.length <= 1600 && cut.endsWith('…'));
  assert.ok(/mục số \d+…$/.test(cut)); // cắt ở cuối một dòng, không giữa chừng
});

test('latestMessage: tin của bạn cũng bỏ ký hiệu danh sách markdown', () => {
  const m = latestMessage(user(0, 'ý chính:\n* cho to ra\n* hiển thị markdown'));
  assert.equal(m.text, 'ý chính: cho to ra hiển thị markdown');
});
