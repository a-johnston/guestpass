import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSSEParser, createAccumulator, createResponsesAccumulator } from '../js/stream.js';

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
  assert.deepEqual(acc.result(), { content: 'Hello', reasoning: 'hmm.', toolCalls: [], finishReason: 'stop', usage: null, timings: null });
});

test('accumulator picks up usage from either placement', () => {
  const usage = { prompt_tokens: 59, completion_tokens: 31, total_tokens: 90 };
  const onFinishChunk = createAccumulator(); // basalt / llama.cpp style
  onFinishChunk.apply({ choices: [{ delta: {}, finish_reason: 'stop' }], usage });
  assert.deepEqual(onFinishChunk.result().usage, usage);
  const separate = createAccumulator(); // OpenAI style: trailing chunk with empty choices
  separate.apply(delta({ content: 'x' }, 'stop'));
  separate.apply({ choices: [], usage });
  assert.deepEqual(separate.result().usage, usage);
  assert.equal(separate.result().content, 'x');
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

// Responses API events, as the proxy sends them.
const created = (id = 'resp_1') => ({ type: 'response.created', response: { id, status: 'in_progress' } });
const completed = (response) => ({ type: 'response.completed', response: { id: 'resp_1', store: true, status: 'completed', output: [], ...response } });

test('responses: text, reasoning, usage, timings', () => {
  const acc = createResponsesAccumulator();
  acc.apply(created());
  acc.apply({ type: 'response.reasoning_text.delta', item_id: 'rs_1', output_index: 0, delta: 'We' });
  acc.apply({ type: 'response.reasoning_text.delta', item_id: 'rs_1', output_index: 0, delta: ' need' });
  acc.apply({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, delta: 'Hel' });
  acc.apply({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, delta: 'lo' });
  acc.apply(completed({
    output: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'We need' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
    ],
    usage: { input_tokens: 103, output_tokens: 26, total_tokens: 129 },
    bridge: { finish_reason: 'stop', timings: { predicted_per_second: 85.2 } },
  }));
  assert.deepEqual(acc.result(), {
    content: 'Hello',
    reasoning: 'We need',
    toolCalls: [],
    finishReason: 'stop',
    usage: { prompt_tokens: 103, completion_tokens: 26, total_tokens: 129 },
    timings: { predicted_per_second: 85.2 },
    responseId: 'resp_1',
    stored: true,
  });
});

test('responses: reasoning summary deltas count as reasoning', () => {
  const acc = createResponsesAccumulator();
  acc.apply({ type: 'response.reasoning_summary_text.delta', delta: 'short' });
  assert.equal(acc.result().reasoning, 'short');
});

test('responses: tool call', () => {
  const acc = createResponsesAccumulator();
  acc.apply(created());
  acc.apply({ type: 'response.output_item.added', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_2', name: 'get_time', arguments: '' } });
  acc.apply({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"tz":' });
  acc.apply({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '"UTC"}' });
  acc.apply(completed({ output: [{ id: 'fc_1', type: 'function_call', call_id: 'call_2', name: 'get_time', arguments: '{"tz":"UTC"}' }] }));
  const r = acc.result();
  assert.deepEqual(r.toolCalls, [{ id: 'call_2', type: 'function', function: { name: 'get_time', arguments: '{"tz":"UTC"}' } }]);
  assert.equal(r.finishReason, 'tool_calls');
});

test('responses: tool call arguments only in output_item.done', () => {
  const acc = createResponsesAccumulator();
  acc.apply({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'c', name: 'n', arguments: '' } });
  acc.apply({ type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'c', name: 'n', arguments: '{"a":1}' } });
  assert.deepEqual(acc.result().toolCalls, [{ id: 'c', type: 'function', function: { name: 'n', arguments: '{"a":1}' } }]);
});

test('responses: incomplete', () => {
  const acc = createResponsesAccumulator();
  acc.apply({ type: 'response.output_text.delta', delta: 'cut' });
  acc.apply({ type: 'response.incomplete', response: { id: 'resp_1', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] } });
  assert.equal(acc.result().finishReason, 'length');
  assert.equal(acc.result().content, 'cut');
});

test('responses: store false is not chainable', () => {
  const acc = createResponsesAccumulator();
  acc.apply(created());
  acc.apply(completed({ store: false }));
  assert.equal(acc.result().stored, false);
  const noId = createResponsesAccumulator();
  noId.apply({ type: 'response.completed', response: { output: [] } });
  assert.equal(noId.result().stored, false);
});

test('responses: failure throws', () => {
  const acc = createResponsesAccumulator();
  assert.throws(
    () => acc.apply({ type: 'response.failed', response: { error: { message: 'boom', code: 'server_error' } } }),
    (e) => e instanceof Error && e.message === 'boom' && e.code === 'server_error',
  );
  assert.throws(() => acc.apply({ type: 'error', message: 'bad', code: 'x' }), (e) => e.message === 'bad' && e.code === 'x');
  assert.throws(() => acc.apply({ type: 'error', error: { message: 'nested' } }), /nested/);
});

test('responses: non-streaming body folds output', () => {
  const output = [
    { type: 'reasoning', content: [{ type: 'reasoning_text', text: 't' }] },
    { type: 'message', content: [{ type: 'output_text', text: 'hi' }] },
    { type: 'function_call', call_id: 'c', name: 'n', arguments: '{}' },
  ];
  const acc = createResponsesAccumulator();
  acc.apply({ type: 'response.completed', response: { id: 'r', output } });
  const r = acc.result();
  assert.deepEqual([r.content, r.reasoning, r.responseId, r.stored], ['hi', 't', 'r', true]);
  assert.deepEqual(r.toolCalls, [{ id: 'c', type: 'function', function: { name: 'n', arguments: '{}' } }]);

  const streamed = createResponsesAccumulator();
  streamed.apply({ type: 'response.reasoning_text.delta', delta: 't' });
  streamed.apply({ type: 'response.output_text.delta', delta: 'hi' });
  streamed.apply({ type: 'response.output_item.added', output_index: 2, item: { id: 'fc', type: 'function_call', call_id: 'c', name: 'n', arguments: '' } });
  streamed.apply({ type: 'response.function_call_arguments.delta', item_id: 'fc', delta: '{}' });
  streamed.apply({ type: 'response.completed', response: { id: 'r', output } });
  const s = streamed.result();
  assert.deepEqual([s.content, s.reasoning, s.toolCalls.length, s.toolCalls[0].function.arguments], ['hi', 't', 1, '{}'], 'not doubled');
});

test('responses: usage total falls back to input + output', () => {
  const acc = createResponsesAccumulator();
  acc.apply(completed({ usage: { input_tokens: 10, output_tokens: 5 } }));
  assert.deepEqual(acc.result().usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});

test('responses: a call only in the final output is kept after streamed text', () => {
  const acc = createResponsesAccumulator();
  acc.apply({ type: 'response.output_text.delta', delta: 'hi' });
  acc.apply({ type: 'response.completed', response: { id: 'r', output: [
    { type: 'message', content: [{ type: 'output_text', text: 'hi' }] },
    { type: 'function_call', call_id: 'c', name: 'n', arguments: '{}' },
  ] } });
  const r = acc.result();
  assert.deepEqual([r.content, r.toolCalls.length, r.finishReason], ['hi', 1, 'tool_calls']);
});
