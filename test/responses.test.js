import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toResponsesInput, toResponsesTools, buildResponsesBody } from '../js/responses.js';

const IMG = 'data:image/webp;base64,AA';
const PDF = 'data:application/pdf;base64,AA';

test('user text and parts', () => {
  assert.deepEqual(toResponsesInput([{ role: 'user', content: 'hi' }]), [
    { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ]);
  assert.deepEqual(toResponsesInput([{
    role: 'user',
    content: [
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: IMG } },
      { type: 'file', file: { filename: 'a.pdf', file_data: PDF } },
    ],
  }]), [{
    role: 'user',
    content: [
      { type: 'input_text', text: 'look' },
      { type: 'input_image', image_url: IMG },
      { type: 'input_file', filename: 'a.pdf', file_data: PDF },
    ],
  }]);
});

test('assistant with reasoning, text and tool calls', () => {
  const call = { id: 'call_1', type: 'function', function: { name: 'inline', arguments: '{"id":"x"}' } };
  assert.deepEqual(toResponsesInput([{ role: 'assistant', reasoning_content: 'plan', content: 'ok', tool_calls: [call] }]), [
    { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'plan' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
    { type: 'function_call', call_id: 'call_1', name: 'inline', arguments: '{"id":"x"}' },
  ]);
  assert.deepEqual(toResponsesInput([{ role: 'assistant', content: '', tool_calls: [call] }]), [
    { type: 'function_call', call_id: 'call_1', name: 'inline', arguments: '{"id":"x"}' },
  ], 'empty content: no assistant message item, no reasoning item');
});

test('tool result string', () => {
  assert.deepEqual(toResponsesInput([{ role: 'tool', tool_call_id: 'call_1', content: 'done' }]), [
    { type: 'function_call_output', call_id: 'call_1', output: 'done' },
  ]);
});

test('tool result with screenshot goes out as an output array', () => {
  const content = [{ type: 'text', text: 'shot' }, { type: 'image_url', image_url: { url: IMG } }];
  assert.deepEqual(toResponsesInput([{ role: 'tool', tool_call_id: 'call_1', content }]), [{
    type: 'function_call_output',
    call_id: 'call_1',
    output: [{ type: 'input_text', text: 'shot' }, { type: 'input_image', image_url: IMG }],
  }]);
});

test('slice starting with tool results converts without the call it answers', () => {
  assert.deepEqual(toResponsesInput([{ role: 'tool', tool_call_id: 'call_9', content: 'r' }]), [
    { type: 'function_call_output', call_id: 'call_9', output: 'r' },
  ]);
});

test('system messages are not input', () => {
  assert.deepEqual(toResponsesInput([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]), [
    { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ]);
});

const TOOL = { type: 'function', function: { name: 'kv', description: 'd', parameters: { type: 'object' } } };
const FLAT = { type: 'function', name: 'kv', description: 'd', parameters: { type: 'object' } };

test('tools flatten', () => {
  assert.deepEqual(toResponsesTools([TOOL]), [FLAT]);
});

test('body', () => {
  assert.deepEqual(buildResponsesBody({
    instructions: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [TOOL], model: 'm', previousResponseId: 'resp_1',
  }), {
    model: 'm',
    instructions: 'sys',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    tools: [FLAT],
    previous_response_id: 'resp_1',
    stream: true,
  });
  assert.deepEqual(buildResponsesBody({ messages: [{ role: 'user', content: 'hi' }] }), {
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    stream: true,
  });
  assert.deepEqual(Object.keys(buildResponsesBody({ instructions: '', tools: [], messages: [] })), ['input', 'stream']);
});
