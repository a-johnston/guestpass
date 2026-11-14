// Execute the actual app wiring without booting the DOM; only rendering and I/O are replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as content from '../js/content.js';
import * as compaction from '../js/compact.js';
import * as items from '../js/items.js';
import { assertWireHistory } from './helpers/history.js';
import { runRecall } from '../js/recall.js';
import { buildResponsesBody } from '../js/responses.js';
import { fallbackFor } from '../js/fallbacks.js';
import { chainRecovery } from '../js/api.js';
globalThis.window ??= { addEventListener() {} };
const tools = await import('../js/tools.js');
const source = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/\ninit\(\);\s*$/, '');
const reply = (extra = {}) => ({ content: 'done', reasoning: '', toolCalls: [], usage: { total_tokens: 700 }, finishReason: 'stop', stored: false, ...extra });
const node = () => ({ hidden: false, dataset: {}, setAttribute() {}, remove() {}, append() {}, classList: { contains: () => false } });
function app(responses = [], onTool = null) {
  const requests = [], notices = [], executed = [];
  let compactionRuns = 0;
  const context = vm.createContext({
    ...content, ...compaction, ...items, ...tools, runRecall, buildResponsesBody, fallbackFor, chainRecovery,
    compactHistory: (...args) => { compactionRuns++; return compaction.compactHistory(...args); },
    document: { getElementById: node }, createPaneManager: () => ({}), structuredClone, AbortController, performance,
    streamChat: async (req) => { requests.push(structuredClone(req.body)); const next = responses.shift(); if (next instanceof Error) throw next; return typeof next === 'function' ? await next() : next || reply(); },
    runTool: async (name, args, ui) => { executed.push(name); if (onTool) await onTool(name, args, executed.length); return name === 'recall' ? ui.recall(JSON.parse(args)) : 'ran'; },
    notices,
  });
  vm.runInContext(source + `
    setBusy = () => {}; followScroll = () => {}; addUserMessage = () => {};
    notice = (text) => { notices.push(text); return { append() {} }; };
    createAssistantView = () => ({ update() {}, remove() {}, finish() {}, thinkingMs() { return 0; }, addToolCall() { return { done() {} }; }, fail(e) { throw e; } });
    globalThis.app = { state, sendableHistory, adoptCompaction, buildRequest, runTurn, clearMedia, updateClearMedia, pushUser, el };
  `, context);
  return { ...context.app, requests, notices, executed, get compactionRuns() { return compactionRuns; } };
}
const history = () => [{ role: 'user', content: 'go' }, ...Array.from({ length: 10 }, () => ({ role: 'assistant', content: '', reasoning: 'First. ' + 'x'.repeat(3900) + '. Last.' }))];

test('sendable history only grows between frozen compactions', () => {
  const a = app(); a.state.messages = history();
  a.adoptCompaction('quiet');
  const sent = JSON.stringify(a.sendableHistory(0, true));
  a.state.messages[1].reasoning = 'changed locally';
  a.state.messages.push({ role: 'user', content: 'next' }, { role: 'assistant', content: 'live' });
  const grown = a.sendableHistory(0, true);
  assert.equal(JSON.stringify(grown.slice(0, -2)), sent);
  assert.equal(grown.at(-1).content, 'live');
  assert.equal(a.state.chainHead, null);
});
test('live history has no sliding trims and a trailing user stays live', () => {
  const a = app(); a.state.thinkingMode = 'turn';
  a.state.messages = [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', reasoning: 'old' }, { role: 'user', content: 'next' }];
  assert.equal(a.sendableHistory(0, true)[1].reasoning_content, 'old');
  a.adoptCompaction('quiet');
  assert.equal(a.state.compaction.upTo, 2);
  a.pushUser('merged');
  assert.match(content.contentText(a.sendableHistory(0, true).at(-1).content), /next\n\nmerged/);
});
test('frozen and live user boundaries merge without mutating the snapshot', () => {
  const a = app(); a.state.sendReasoning = false;
  a.state.messages = [{ role: 'user', content: 'first' }, { role: 'assistant', content: '', reasoning: 'not sent' }];
  a.adoptCompaction('quiet');
  const frozen = JSON.stringify(a.state.compaction);
  a.pushUser('second');
  const history = a.sendableHistory(0, true);
  assert.equal(history.length, 1);
  assert.equal(content.contentText(history[0].content), 'first\n\nsecond');
  assert.equal(JSON.stringify(a.state.compaction), frozen);
});
test('full sends repair reused ids but chained tool results keep the server id', () => {
  const a = app();
  const call = (name) => ({ id: 'call_0', type: 'function', function: { name, arguments: '{}' } });
  a.state.messages = [
    { role: 'user', content: 'first' }, { role: 'assistant', content: '', tool_calls: [call('kv')] },
    { role: 'tool', tool_call_id: 'call_0', content: 'first result' },
    { role: 'user', content: 'second' }, { role: 'assistant', content: '', tool_calls: [call('read')] },
    { role: 'tool', tool_call_id: 'call_0', content: 'second result' },
  ];
  const sent = a.sendableHistory(0, true);
  assertWireHistory(sent);
  assert.equal(sent[2].content, 'first result');
  assert.equal(sent[5].content, 'second result');
  a.state.chainHead = { id: 'server-response', sent: 5, held: 100 };
  const chained = a.buildRequest().body;
  assert.equal(chained.previous_response_id, 'server-response');
  assert.equal(chained.input[0].call_id, 'call_0');
  a.adoptCompaction('quiet');
  const frozen = JSON.stringify(a.state.compaction);
  a.state.messages.push({ role: 'user', content: 'third' }, { role: 'assistant', content: '', tool_calls: [call('kv')] },
    { role: 'tool', tool_call_id: 'call_0', content: 'third result' });
  assertWireHistory(a.sendableHistory(0, true));
  assert.equal(JSON.stringify(a.state.compaction), frozen);
});
test('a reused id in a later stored reply starts a fresh uniquely paired chain', async () => {
  const call = (name) => ({ id: 'call_0', type: 'function', function: { name, arguments: '{}' } });
  const a = app([
    reply({ toolCalls: [call('kv')], stored: true, responseId: 'first' }),
    reply({ toolCalls: [call('read')], stored: true, responseId: 'second' }),
    reply(),
  ]);
  a.state.messages = [{ role: 'user', content: 'go' }];
  await a.runTurn();
  assert.equal(a.requests[1].previous_response_id, 'first');
  assert.equal(a.requests[1].input[0].call_id, 'call_0');
  assert.equal(a.requests[2].previous_response_id, undefined);
  const calls = a.requests[2].input.filter((i) => i.type === 'function_call').map((i) => i.call_id);
  const results = a.requests[2].input.filter((i) => i.type === 'function_call_output').map((i) => i.call_id);
  assert.equal(new Set(calls).size, 2);
  assert.deepEqual(results, calls);
});
test('a reply with duplicate batch ids forces a full paired resend instead of chaining', async () => {
  const calls = ['kv', 'read'].map((name) => ({ id: 'call_0', type: 'function', function: { name, arguments: '{}' } }));
  const a = app([reply({ toolCalls: calls, stored: true, responseId: 'duplicate-batch' }), reply()]);
  a.state.messages = [{ role: 'user', content: 'go' }];
  await a.runTurn();
  assert.equal(a.requests[1].previous_response_id, undefined);
  const input = a.requests[1].input;
  const callIds = input.filter((i) => i.type === 'function_call').map((i) => i.call_id);
  const resultIds = input.filter((i) => i.type === 'function_call_output').map((i) => i.call_id);
  assert.equal(new Set(callIds).size, 2);
  assert.deepEqual(resultIds, callIds);
});
test('frozen and live assistant boundaries merge without changing the frozen prefix', () => {
  const a = app();
  a.state.messages = [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'before', reasoning: 'first reason' }];
  a.adoptCompaction('quiet');
  const frozen = JSON.stringify(a.state.compaction);
  a.state.messages.push({ role: 'assistant', content: 'after', reasoning: 'second reason' });
  const sent = a.sendableHistory(0, true);
  assertWireHistory(sent);
  assert.equal(sent[1].content, 'before\n\nafter');
  assert.equal(sent[1].reasoning_content, 'first reason\n\nsecond reason');
  assert.equal(JSON.stringify(a.state.compaction), frozen);
});
test('automatic compaction also runs without Responses chaining', async () => {
  const a = app(); a.state.api.dialect = 'chat'; a.state.messages = history();
  a.state.context = { used: 10000, max: 12000, reported: true, floor: 0 };
  await a.runTurn();
  assert.ok(a.state.compaction);
  assert.match(a.notices[0], /^Compacted the history sent to the model:/);
  assert.ok(a.requests[0].messages.reduce((n, m) => n + (m.reasoning_content?.length || 0), 0) < 20000);
});
test('length: learn window, skip broken call, sanitize resend, continue once', async () => {
  const broken = { id: 'cut', type: 'function', function: { name: 'edit', arguments: '{"id":"a' } };
  const a = app([reply({ toolCalls: [broken], finishReason: 'length', usage: { total_tokens: 3000 }, stored: true, responseId: 'r1' }), reply()]);
  a.state.messages = history();
  await a.runTurn();
  assert.equal(a.state.context.max, 3000);
  assert.equal(a.requests.length, 2);
  assert.equal(a.executed.length, 0);
  assert.equal(a.requests[1].previous_response_id, undefined);
  for (const item of a.requests[1].input.filter((i) => i.type === 'function_call')) assert.doesNotThrow(() => JSON.parse(item.arguments));
  assert.ok(a.state.messages.find((m) => m.tool_calls)?.tool_calls[0].cutOff);
  assert.match(a.state.messages.find((m) => m.role === 'tool').content, /^Error: this call was cut off at the context limit and was not run\. Make it again\.$/);
  assert.match(a.notices.find((n) => n.startsWith('Reached')), /context limit at 3k/);
});
test('length without tools adds nudge and retries only once per turn', async () => {
  const cut = reply({ finishReason: 'length', usage: { total_tokens: 3000 } });
  const a = app([cut, cut]); a.state.messages = [{ role: 'user', content: 'go' }];
  await a.runTurn();
  assert.equal(a.requests.length, 2);
  assert.equal(a.state.messages.filter((m) => m.role === 'user').length, 2);
  assert.equal(a.state.messages.findLast((m) => m.role === 'user').content, 'Your previous reply was cut off at the context limit. Older history has been compacted; continue where you left off.');
});
test('length well below a known window is an output cap, not a context-limit retry', async () => {
  for (const reported of [true, false]) {
    const a = app([reply({ finishReason: 'length', usage: { total_tokens: 5000 } })]);
    a.state.messages = [{ role: 'user', content: 'go' }];
    a.state.context = { used: 1000, max: 131072, reported, floor: 0 };
    await a.runTurn();
    assert.equal(a.requests.length, 1);
    assert.equal(a.state.context.max, 131072);
    assert.equal(a.state.compaction, null);
    assert.equal(a.notices.length, 0);
    assert.equal(a.state.messages.filter((m) => m.role === 'user').length, 1);
  }
});
test('length without fresh usage cannot reuse a stale full-window count', async () => {
  const a = app([reply({ finishReason: 'length', usage: null })]);
  a.state.messages = [{ role: 'user', content: 'go' }];
  a.state.context = { used: 131072, max: 131072, reported: true, floor: 0 };
  await a.runTurn();
  assert.equal(a.requests.length, 1);
  assert.equal(a.notices.length, 0);
});
test('length near a known context window still compacts and continues', async () => {
  const a = app([reply({ finishReason: 'length', usage: { total_tokens: 120000 } }), reply()]);
  a.state.messages = [{ role: 'user', content: 'go' }];
  a.state.context = { used: 1000, max: 131072, reported: true, floor: 0 };
  await a.runTurn();
  assert.equal(a.requests.length, 2);
  assert.ok(a.notices.some((n) => n.startsWith('Reached the context limit')));
});
test('output-capped calls still get safe arguments without a context-limit claim', async () => {
  const a = app([reply({ finishReason: 'length', usage: { total_tokens: 5000 }, toolCalls: [
    { id: 'cap', type: 'function', function: { name: 'edit', arguments: '{"id":"a' } },
  ] }), reply()]);
  a.state.messages = [{ role: 'user', content: 'go' }];
  a.state.context = { used: 1000, max: 131072, reported: true, floor: 0 };
  await a.runTurn();
  assert.equal(a.executed.length, 0);
  assert.equal(a.state.compaction, null);
  assert.equal(a.notices.length, 0);
  assert.match(a.state.messages.find((m) => m.role === 'tool').content, /cut off at the output limit/);
  assert.equal(a.requests[1].input.find((i) => i.type === 'function_call').arguments, '{}');
});
test('learned output cap invalidated, reported window untouched', async () => {
  for (const reported of [false, true]) {
    const a = app([reply({ usage: { total_tokens: 5000 } })]);
    a.state.messages = [{ role: 'user', content: 'go' }];
    a.state.context = { max: 3000, used: 100, floor: 0, reported };
    await a.runTurn();
    assert.equal(a.state.context.max, reported ? 3000 : null);
    assert.equal(a.state.context.floor, reported ? 0 : 5000);
  }
});
test('tools fallback recomputes frozen stubs without recall references', async () => {
  const error = Object.assign(new Error('tools param requires --jinja flag'), { status: 500 });
  const a = app([error, reply()]); a.state.messages = history(); a.state.context.max = 6000;
  a.adoptCompaction('quiet');
  assert.match(JSON.stringify(a.state.compaction.messages), /recall/);
  await a.runTurn();
  assert.equal(a.state.toolsSupported, false);
  assert.doesNotMatch(JSON.stringify(a.requests[1]), /recall/);
});
test('manual compaction in a partially completed multi-call batch keeps all pairs live', async () => {
  const calls = ['a', 'b'].map((id) => ({ id, type: 'function', function: { name: 'kv', arguments: '{}' } }));
  const a = app([reply({ toolCalls: calls, stored: true, responseId: 'before-compact' }), reply()], (name, args, n) => {
    if (n === 2) {
      assert.equal(a.state.messages.at(-1).tool_call_id, 'a');
      a.clearMedia();
      assert.equal(a.state.messages[a.state.compaction.upTo].tool_calls[0].id, 'a');
    }
  });
  a.state.messages = history(); a.state.context.max = 6000;
  await a.runTurn();
  assert.equal(a.requests[1].previous_response_id, undefined);
  const input = a.requests[1].input;
  const called = input.filter((i) => i.type === 'function_call').map((i) => i.call_id).sort();
  const answered = input.filter((i) => i.type === 'function_call_output').map((i) => i.call_id).sort();
  assert.deepEqual(called, ['a', 'b']);
  assert.deepEqual(answered, called);
});
test('manual compaction during streaming cannot resurrect the old chain', async () => {
  const a = app([() => { a.clearMedia(); return reply({ stored: true, responseId: 'old' }); }]);
  a.state.messages = history();
  await a.runTurn();
  assert.equal(a.state.chainHead, null);
});
test('Compact button skips full compaction analysis while media is clearable', () => {
  const a = app();
  a.state.messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(1000000) }, meta: { kind: 'attachment', bytes: 750000 } }] }];
  a.updateClearMedia();
  assert.equal(a.el.clearMedia.hidden, false);
  assert.equal(a.compactionRuns, 0);
});
test('Compact button does not count the unfreezable live suffix as savings', () => {
  const a = app(); a.state.messages = [{ role: 'user', content: 'x'.repeat(8000) }];
  a.updateClearMedia();
  assert.equal(a.el.clearMedia.hidden, true);
});
test('manual button compacts text-only histories and recall sees full originals', async () => {
  const a = app([reply({ toolCalls: [{ id: 'rec', type: 'function', function: { name: 'recall', arguments: '{"id":"r1"}' } }] }), reply()]);
  a.state.messages = history(); a.state.context.max = 6000;
  a.updateClearMedia(); assert.equal(a.el.clearMedia.hidden, false);
  a.clearMedia(); assert.ok(a.state.compaction);
  assert.match(a.notices[0], /^Compacted the history sent/);
  await a.runTurn();
  const result = a.state.messages.find((m) => m.role === 'tool');
  assert.match(result.content, /x{100}/);
});
