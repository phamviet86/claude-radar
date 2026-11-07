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
  assert.deepEqual(turns.map((t) => t.prompt), ['Lệnh /compact', 'nhắn thật']);
  assert.equal(turns[1].reply, '');
});

test('timeline: cắt ngắn văn bản dài và giới hạn số lượt', () => {
  const long = 'x'.repeat(2000);
  const many = Array.from({ length: 5 }, (_, i) => user(i, `lượt ${i}`) + '\n' + asst(i, [{ type: 'text', text: long }])).join('\n');
  const { turns, omitted } = parseTranscript(many, 3);
  assert.equal(turns.length, 3);
  assert.equal(omitted, 2);
  assert.ok(turns[0].reply.length <= 520);
  assert.equal(turns[0].prompt, 'lượt 4');
});
