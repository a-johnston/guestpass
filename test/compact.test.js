import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, compactHistory, omittedHtml, clearedHtml, OMITTED_MARKER, COMPACTION, shouldCompact, learnWindow } from '../js/compact.js';
import { contentText, estimateTokens } from '../js/content.js';
import { assertWireHistory } from './helpers/history.js';

const opts = { window: 12000, thinkingMode: 'all', sendReasoning: true, tools: true };
const compact = (ms, extra = {}) => {
  const result = compactHistory(ms, { ...opts, ...extra });
  assertWireHistory(result.messages);
  return result;
};
const user = (content = 'go') => ({ role: 'user', content });
const thought = (n, suffix = '') => ({ role: 'assistant', reasoning: 'Thinking. ' + 'x'.repeat(n * 4 - 20) + '. Done.' + suffix, content: '' });
const call = (name, args, id, flags = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) }, ...flags });
const pair = (name, args, result, id, flags) => [
  { role: 'assistant', content: '', tool_calls: [call(name, args, id, flags)] },
  { role: 'tool', content: result, tool_call_id: id },
];
const image = (id) => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' }, meta: { kind: 'screenshot', pageId: id } });
function paired(ms) {
  const calls = ms.flatMap((m) => (m.tool_calls || []).map((c) => c.id));
  const results = ms.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  assert.equal(new Set(calls).size, calls.length);
  assert.deepEqual(calls.toSorted(), results.toSorted());
}

test('allocate lends unused shares by weight', () => {
  const out = allocate({ a: 100, b: 1000, c: 1000 }, { a: 1, b: 1, c: 2 }, 1200);
  assert.equal(out.a, 100);
  assert.ok(Math.abs(out.b - 367) <= 1);
  assert.ok(Math.abs(out.c - 733) <= 1);
  assert.ok(Object.values(out).reduce((a, b) => a + b, 0) <= 1200);
  assert.deepEqual(allocate({ a: 1, b: 2 }, { a: 1, b: 2 }, 0), { a: 0, b: 0 });
});
test('newest first within a kind', () => {
  const out = compact([user(), ...Array.from({ length: 5 }, () => thought(1000))], { window: 7200 }).messages;
  const reasoning = out.filter((m) => m.reasoning_content).flatMap((m) => m.reasoning_content.split('\n\n'));
  assert.equal(reasoning.length, 5);
  reasoning.slice(0, 3).forEach((r, i) => assert.equal(r, `Thinking. [… recall r${i + 1}] Done.`));
  reasoning.slice(3).forEach((r) => assert.ok(r.length > 3900));
});
test('plan blocks', () => {
  const ms = [user(), thought(20000)];
  const out = compact(ms, { window: 24000 }).messages[1].reasoning_content;
  assert.equal(out, ms[1].reasoning.slice(0, 4000) + '\n[… recall r1 …]\n' + ms[1].reasoning.slice(-12000));
});
test('tool stubs', () => {
  const ms = [user(),
    ...pair('read', { id: 'doom', start: 10, end: 40 }, 'Lines 10-40 of 99\n' + 'x'.repeat(20000), 'read'),
    ...pair('edit', { id: 'doom', old: 'x'.repeat(20000), new: 'y'.repeat(20000) }, 'Edited "doom" (lines 40-52); reloaded.', 'edit'),
    ...pair('kv', {}, 'first\n' + 'x'.repeat(20000) + '\nlast', 'kv')];
  const out = compact(ms, { window: 1500 }).messages;
  assert.equal(out.find((m) => m.tool_call_id === 'read').content, '[read "doom" lines 10–40; stale, recall t2]');
  assert.deepEqual(JSON.parse(out.flatMap((m) => m.tool_calls || []).find((c) => c.id === 'edit').function.arguments), { id: 'doom', start: 40, end: 52, new: `${OMITTED_MARKER}: edit of lines 40–52, recall a3.0]` });
  assert.equal(out.find((m) => m.tool_call_id === 'kv').content, 'first\n[… recall t6]\nlast');
  const single = compact([user(), ...pair('edit', { id: 'doom', old: 'a'.repeat(20000), new: 'b' }, 'Edited "doom" (line 40); reloaded.', 'e')], { window: 1500 });
  assert.equal(JSON.parse(single.messages[1].tool_calls[0].function.arguments).start, 40);
});
test('pages', () => {
  const ms = [user(), ...pair('inline', { id: 'doom', html: 'a'.repeat(20000) }, 'ok', 'a', { superseded: true }),
    ...pair('pane', { id: 'b', html: 'b'.repeat(20000) }, 'ok', 'b', { cleared: true }),
    ...pair('inline', { id: 'doom', html: 'c'.repeat(20000) }, 'ok', 'c')];
  const calls = compact(ms, { window: 1800 }).messages.flatMap((m) => m.tool_calls || []);
  assert.deepEqual(calls.map((c) => JSON.parse(c.function.arguments).html), [omittedHtml('doom'), clearedHtml('b'), `${OMITTED_MARKER}: current source: read("doom")]`]);
});
test('only the latest screenshot per page is sent at compaction', () => {
  const ms = [user(), ...pair('screenshot', { id: 'doom' }, [image('doom')], 's1'),
    ...pair('screenshot', { id: 'other' }, [image('other')], 's2'),
    ...pair('screenshot', { id: 'doom' }, [image('doom')], 's3')];
  const out = compact(ms).messages;
  assert.deepEqual(out[2].content, [{ type: 'text', text: '[earlier screenshot of "doom", recall t2]' }]);
  assert.equal(out[4].content[0].type, 'image_url');
  assert.equal(out[6].content[0].type, 'image_url');
});
test('failed screenshot does not evict the latest successful image', () => {
  const ms = [user(), ...pair('screenshot', { id: 'doom' }, [image('doom')], 'good'), ...pair('screenshot', { id: 'doom' }, 'Error: capture failed', 'bad')];
  const out = compact(ms).messages;
  assert.equal(out[2].content[0].type, 'image_url');
  assert.equal(out[4].content, 'Error: capture failed');
});
test('cleared newest screenshots do not resurrect old screenshots', () => {
  const old = image('doom'), latest = image('doom'); latest.meta.cleared = true;
  const ms = [user(), ...pair('screenshot', { id: 'doom' }, [old], 's1'), ...pair('screenshot', { id: 'doom' }, [latest], 's2')];
  const out = compact(ms).messages;
  assert.equal(out.flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((p) => p.type === 'image_url').length, 0);
});
test('pairing across deterministic varied budgets and reused server ids', () => {
  for (const reuse of [false, true]) {
    const ms = [user(), ...Array.from({ length: 30 }, (_, i) => pair(i % 2 ? 'read' : 'edit', { id: 'doom', start: 1, end: 2, new: 'x'.repeat(4000) }, `result ${i}\n` + 'x'.repeat(4000), `c${reuse ? i % 3 : i}`)).flat()];
    for (let window = 500; window < 30000; window += 947) paired(compact(ms, { window }).messages);
  }
});
test('removing an old user merges adjacent assistant content and reasoning', () => {
  const ms = [user(), { role: 'assistant', content: 'before', reasoning: 'reason before' },
    user('x'.repeat(20000)), { role: 'assistant', content: 'after', reasoning: 'reason after' },
    user('latest'), { role: 'assistant', content: 'finish' }];
  const out = compact(ms, { window: 1200 }).messages;
  const merged = out.find((m) => m.content === 'before\n\nafter');
  assert.ok(merged);
  assert.equal(merged.reasoning_content, 'reason before\n\nreason after');
});
test('removing a call/result pair merges its surviving assistant text with the next reply', () => {
  const ms = [user(), ...pair('kv', { data: 'x'.repeat(20000) }, 'result', 'drop'),
    ...pair('read', { id: 'doom' }, 'source', 'keep')];
  ms[1].content = 'before'; ms[3].content = 'after';
  const out = compact(ms, { window: 1200 }).messages;
  const merged = out.find((m) => m.role === 'assistant');
  assert.equal(merged.content, 'before\n\nafter');
  assert.equal(merged.tool_calls[0].id, 'keep');
});
test('an old result with a reused id cannot answer an in-flight call', () => {
  const ms = [user(), ...pair('kv', {}, 'old result', 'call_0'), user('next'),
    { role: 'assistant', content: '', tool_calls: [call('kv', {}, 'call_0')] }];
  const pending = compact(ms);
  assert.equal(pending.upTo, 4);
  assert.equal(pending.messages.find((m) => m.role === 'tool').content, 'old result');
  ms.push({ role: 'tool', tool_call_id: 'call_0', content: 'new result' });
  const complete = compact(ms);
  assert.equal(complete.upTo, 6);
  assert.deepEqual(complete.messages.filter((m) => m.role === 'tool').map((m) => m.content), ['old result', 'new result']);
});
test('users', () => {
  const ms = [user('a'.repeat(20000)), thought(10), user('Middle. ' + 'b'.repeat(20000) + '. End.'), thought(10), user('c'.repeat(20000)), thought(10)];
  const out = compact(ms, { window: 40000 }).messages.filter((m) => m.role === 'user');
  assert.equal(out[0].content, ms[0].content);
  assert.match(out[1].content, /recall m2/);
  assert.equal(out[2].content, ms[4].content);
});
test('thinking modes', () => {
  const ms = [user(), thought(1000), user('next'), thought(1000)];
  assert.equal(compact(ms, { sendReasoning: false }).messages.some((m) => m.reasoning_content), false);
  const out = compact(ms, { thinkingMode: 'turn' }).messages;
  assert.equal(out.filter((m) => m.reasoning_content).length, 1);
  assert.equal(out.at(-1).reasoning_content, ms.at(-1).reasoning);
});
test('tools off stubs have no recall references', () => {
  const out = compact([user(), ...Array.from({ length: 5 }, () => thought(1000))], { window: 600, tools: false });
  assert.doesNotMatch(JSON.stringify(out), /recall/);
});
test('cut-off calls always use empty arguments even when stubbed', () => {
  const ms = [user(), ...pair('edit', {}, 'error'.repeat(200), 'cut', { cutOff: true }), thought(1000),
    ...pair('read', { id: 'doom' }, 'x'.repeat(8000), 'read'),
    ...pair('kv', {}, 'first\n' + 'x'.repeat(8000) + '\nlast', 'kv')];
  ms[1].tool_calls[0].function.arguments = '{"id":"a';
  const out = compact(ms, { window: 4800 }).messages.flatMap((m) => m.tool_calls || []);
  const cut = out.find((c) => c.id === 'cut');
  assert.ok(cut, 'the cut-off call survives stubbing');
  assert.equal(cut.function.arguments, '{}');
});
test('no shared objects', () => {
  const ms = [user(), ...pair('screenshot', { id: 'doom' }, [image('doom')], 's')];
  const out = compact(ms), saved = structuredClone(out);
  ms[1].tool_calls[0].function.arguments = '{}'; ms[1].tool_calls[0].cleared = true;
  ms[2].content[0].meta.cleared = true; ms[2].content[0].image_url.url = 'changed';
  assert.deepEqual(out, saved);
});
test('pending tool batches stay live until every result arrives', () => {
  const ms = [user(), thought(10), { role: 'assistant', content: '', tool_calls: [call('kv', {}, 'a'), call('kv', {}, 'b')] }, { role: 'tool', tool_call_id: 'a', content: 'ok' }];
  const out = compact(ms);
  assert.equal(out.upTo, 2);
  paired(out.messages);
  ms.push({ role: 'tool', tool_call_id: 'b', content: 'ok' });
  assert.equal(compact(ms).upTo, 5);
});
test('upTo and estimates', () => {
  const ms = [user(), thought(10), user('last')];
  const out = compact(ms);
  assert.equal(out.upTo, 2);
  assert.equal(out.messages.length, 2);
  assert.equal(out.before, estimateTokens([{ role: 'user', content: 'go' }, { role: 'assistant', content: '', reasoning_content: ms[1].reasoning }]));
  assert.equal(out.after, estimateTokens(out.messages));
  assert.equal(compact(ms.slice(0, 2)).upTo, 2);
});
test('shouldCompact scales comparable estimates and requires both marks', () => {
  const input = { used: 80000, max: 131072, held: 80000, compacted: 40000 };
  assert.equal(shouldCompact(input), true);
  assert.equal(shouldCompact({ ...input, used: 70000 }), false);
  assert.equal(shouldCompact({ ...input, compacted: 72000 }), false);
  assert.equal(shouldCompact({ ...input, max: null }), false);
  assert.equal(shouldCompact({ ...input, used: null }), false);
  assert.equal(shouldCompact({ used: 80, max: 100, held: 40, compacted: 40 }), false);
  assert.equal(shouldCompact({ used: 80, max: 100, held: 40, compacted: 30 }), true);
  assert.equal(shouldCompact({ used: 80, max: 100, held: 0, compacted: 60 }), true);
});
test('learnWindow learns a length limit and invalidates output caps with a floor', () => {
  let win = learnWindow({ max: null, floor: 0 }, { finishReason: 'length', used: 131000 });
  assert.deepEqual(win, { max: 131000, floor: 0 });
  assert.deepEqual(learnWindow(win, { finishReason: 'length', used: 5000 }), win, 'a smaller output cap must not shrink a known window');
  win = learnWindow(win, { finishReason: 'stop', used: 140000 });
  assert.deepEqual(win, { max: null, floor: 140000 });
  assert.deepEqual(learnWindow(win, { finishReason: 'length', used: 20000 }), win);
  assert.deepEqual(learnWindow(win, { finishReason: 'stop', used: 5000 }), win);
  assert.deepEqual(learnWindow(win, { finishReason: 'length', used: null }), win);
});
test('deterministic and constants', () => {
  const ms = [user(), thought(20000)];
  assert.deepEqual(compact(ms), compact(ms));
  assert.equal(COMPACTION.nominalWindow, 131072);
  assert.equal(COMPACTION.weights.reasoning, 8000);
});

// Removed ranges and notes are part of one existing user message, never a new role turn.
test('stub overflow removes the oldest and reports contiguous runs', () => {
  const ms = [user(), thought(10), thought(10), ...Array.from({ length: 200 }, () => thought(1000))];
  const out = compact(ms, { window: 1800 });
  const block = contentText(out.messages[0].content);
  assert.match(block, /Messages 3–\d+ compacted \(\d+ items\): recall id "index:3-\d+" lists them\./);
  const stubs = out.messages.flatMap((m) => [...(m.reasoning_content || '').matchAll(/\[… recall r\d+\]/g)]);
  assert.ok(stubs.length > 10 && stubs.length < 45);
  const split = [user(), ...Array.from({ length: 40 }, () => thought(1000)), user('keep this'), ...Array.from({ length: 100 }, () => thought(1000))];
  const lines = contentText(compact(split, { window: 1200 }).messages[0].content).split('\n').filter((l) => l.startsWith('Messages'));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Messages 1–40/);
  assert.match(lines[1], /Messages 42–/);
});
test('removal keeps pairs', () => {
  const ms = [user(), ...Array.from({ length: 200 }, (_, i) => pair('read', { id: 'doom' }, 'x'.repeat(4000), `c${i}`)).flat()];
  const out = compact(ms, { window: 1500 });
  assert.ok(out.messages.length < ms.length / 2);
  paired(out.messages);
  assert.match(contentText(out.messages[0].content), /Compacted history/);
});
test('alternation after removal and dropped reasoning', () => {
  const out = compact([user(), thought(10), user('next'), thought(1000)], { sendReasoning: false });
  for (let i = 1; i < out.messages.length; i++) assert.ok(out.messages[i].role !== 'user' || out.messages[i - 1].role !== 'user');
  assert.equal(out.messages[0].content, 'go\n\nnext');
});
test('notes block: compacted only, newest deduplicated, overflow linked', () => {
  const ms = [user(), thought(1000, '\nKey: repeat\nKey: oldest'), thought(1000, '\nKey: repeat\nImportant: newer'), thought(10, '\nKey: kept')];
  const block = contentText(compact(ms, { window: 900 }).messages[0].content);
  assert.match(block, /Notes \(newest first\):/);
  assert.equal(block.match(/- Key: repeat/g)?.length, 1);
  assert.ok(block.indexOf('Important: newer') < block.indexOf('Key: repeat'));
  assert.doesNotMatch(block, /Key: kept/);
  const many = [user(), ...Array.from({ length: 50 }, (_, i) => thought(1000, `\nKey: note ${i} ` + 'note '.repeat(35)))];
  const overflow = contentText(compact(many, { window: 1800 }).messages[0].content);
  assert.match(overflow, /\[\d+ older notes: recall id "notes"\]/);
  assert.match(overflow, /Key: note 49/);
});
test('many disjoint removed ranges cannot defeat the total budget', () => {
  const ms = Array.from({ length: 500 }, () => [user(), thought(1000)]).flat();
  const out = compact(ms, { window: 3000 });
  assert.ok(out.after <= 1000, `compacted ${out.after} tokens, target 1000`);
  assert.match(contentText(out.messages[0].content), /recall id "index:/);
  assert.equal(out.messages.filter((m) => m.role === 'user').map((m) => contentText(m.content)).join('').match(/go/g).length, 500);
  paired(out.messages);
});
test('no block when nothing removed and no compacted notes', () => {
  assert.equal(compact([user(), thought(10)]).messages[0].content, 'go');
});
