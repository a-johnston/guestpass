import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSSEParser, createAccumulator } from '../js/stream.js';

function collect(chunks) {
  const out = [];
  const p = createSSEParser((d) => out.push(d));
  for (const c of chunks) p.push(c);
  p.end();
  return out;
}

test('SSE parser reassembles lines split across chunks', () => {
  assert.deepEqual(collect(['data: {"a"', ':1}\n\nda', 'ta: {"b":2}\n\n']), ['{"a":1}', '{"b":2}']);
});

test('SSE parser handles CRLF, comments, [DONE], and missing space after colon', () => {
  assert.deepEqual(collect([': keepalive\r\n', 'data:{"x":1}\r\n\r\n', 'data: [DONE]\r\n\r\n']), ['{"x":1}']);
});

test('SSE parser flushes a final line with no trailing newline', () => {
  assert.deepEqual(collect(['data: {"z":0}']), ['{"z":0}']);
});

const delta = (d, finish = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

test('accumulator concatenates content and reasoning (both field spellings)', () => {
  const acc = createAccumulator();
  acc.apply(delta({ role: 'assistant', reasoning_content: 'hm' }));
  acc.apply(delta({ reasoning: 'm.' }));
  acc.apply(delta({ content: 'Hel' }));
  acc.apply(delta({ content: 'lo' }, 'stop'));
  assert.deepEqual(acc.result(), { content: 'Hello', reasoning: 'hmm.', toolCalls: [], finishReason: 'stop' });
});

test('accumulator assembles streamed tool calls by index', () => {
  const acc = createAccumulator();
  acc.apply(delta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'open_pane', arguments: '' } }] }));
  acc.apply(delta({ tool_calls: [{ index: 0, function: { arguments: '{"id":"p1",' } }] }));
  acc.apply(delta({ tool_calls: [{ index: 1, id: 'call_b', function: { name: 'close_pane', arguments: '{"id":"x"}' } }] }));
  acc.apply(delta({ tool_calls: [{ index: 0, function: { arguments: '"html":"<b>hi</b>"}' } }] }, 'tool_calls'));
  const { toolCalls } = acc.result();
  assert.deepEqual(toolCalls, [
    { id: 'call_a', type: 'function', function: { name: 'open_pane', arguments: '{"id":"p1","html":"<b>hi</b>"}' } },
    { id: 'call_b', type: 'function', function: { name: 'close_pane', arguments: '{"id":"x"}' } },
  ]);
});

test('accumulator handles tool calls without index, object arguments, and missing ids', () => {
  const acc = createAccumulator();
  acc.apply(delta({ tool_calls: [{ function: { name: 'a', arguments: { q: 1 } } }] }));
  acc.apply(delta({ tool_calls: [{ id: 'z', function: { name: 'b', arguments: '{}' } }] }));
  const { toolCalls } = acc.result();
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0].function.arguments, '{"q":1}');
  assert.ok(toolCalls[0].id, 'generates an id when the server omits one');
  assert.equal(toolCalls[1].id, 'z');
});

test('accumulator accepts a non-streamed response (message instead of delta)', () => {
  const acc = createAccumulator();
  acc.apply({ choices: [{ message: { role: 'assistant', content: 'whole' }, finish_reason: 'stop' }] });
  assert.equal(acc.result().content, 'whole');
});

test('accumulator throws on an in-stream error object', () => {
  const acc = createAccumulator();
  assert.throws(() => acc.apply({ error: { message: 'context length exceeded' } }), /context length/);
});
