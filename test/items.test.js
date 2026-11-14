import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyItems, toolKind, findNotes, headTail } from '../js/items.js';

const call = (name, id) => ({ id, type: 'function', function: { name, arguments: '{"id":"doom"}' } });
test('ids and kinds', () => {
  const items = historyItems([
    { role: 'user', content: 'go' },
    { role: 'assistant', reasoning: 'r', content: 'c', tool_calls: [call('read', 'c0'), call('edit', 'c1')] },
    { role: 'tool', tool_call_id: 'c0', content: 'source' },
    { role: 'tool', tool_call_id: 'c1', content: 'edited' },
  ]);
  assert.deepEqual(items.map(({ id, kind, resultId }) => [id, kind, resultId]), [
    ['m0', 'user', undefined], ['r1', 'reasoning', undefined], ['m1', 'text', undefined],
    ['a1.0', 'read', 't2'], ['a1.1', 'edit', 't3'],
  ]);
  assert.equal(items[3].text, '{"id":"doom"}\nsource');
  assert.deepEqual(['inline', 'pane', 'screenshot', 'recall', 'kv'].map(toolKind), ['page', 'page', 'shot', 'recall', 'other']);
});
test('reused call ids match the first unclaimed result after each call', () => {
  const messages = [
    { role: 'tool', tool_call_id: 'call_0', content: 'orphan before any call' },
    { role: 'assistant', tool_calls: [call('read', 'call_0'), call('edit', 'other'), call('read', 'call_0')] },
    { role: 'tool', tool_call_id: 'other', content: 'edit result' },
    { role: 'tool', tool_call_id: 'call_0', content: 'first read' },
    { role: 'tool', tool_call_id: 'call_0', content: 'second read' },
    { role: 'assistant', tool_calls: [call('kv', 'call_0')] },
  ];
  const items = historyItems(messages);
  assert.deepEqual(items.map((i) => i.resultId), ['t3', 't2', 't4', undefined]);
  assert.match(items[0].text, /first read$/);
  assert.match(items[2].text, /second read$/);
});
test('wire-id normalization is paired, append-stable and leaves local history alone', async () => {
  const { normalizeToolIds } = await import('../js/items.js');
  assert.equal(typeof normalizeToolIds, 'function');
  const messages = [
    { role: 'assistant', tool_calls: [call('kv', 'call_0')] },
    { role: 'tool', tool_call_id: 'call_0', content: 'first' },
    { role: 'assistant', tool_calls: [call('kv', 'call_0')] },
    { role: 'tool', tool_call_id: 'call_0', content: 'second' },
  ];
  const saved = structuredClone(messages);
  const before = normalizeToolIds(messages);
  assert.notEqual(before[0].tool_calls[0].id, before[2].tool_calls[0].id);
  assert.equal(before[2].tool_calls[0].id, before[3].tool_call_id);
  const collision = before[2].tool_calls[0].id;
  const grown = normalizeToolIds([...messages,
    { role: 'assistant', tool_calls: [call('kv', collision)] },
    { role: 'tool', tool_call_id: collision, content: 'third' },
  ]);
  assert.deepEqual(grown.slice(0, 4), before);
  assert.notEqual(grown[4].tool_calls[0].id, collision);
  assert.equal(grown[4].tool_calls[0].id, grown[5].tool_call_id);
  assert.deepEqual(messages, saved);
  assert.deepEqual(normalizeToolIds([{ role: 'tool', tool_call_id: 'call_0', content: 'chained result' }]), [{ role: 'tool', tool_call_id: 'call_0', content: 'chained result' }]);
});
test('notes share one newest-first, deduplicated collector for compaction and recall', async () => {
  const { collectNotes } = await import('../js/items.js');
  assert.equal(typeof collectNotes, 'function');
  const items = historyItems([
    { role: 'user', content: 'Key: user text is not an assistant finding' },
    { role: 'assistant', reasoning: 'Key: old\nKey: repeat', content: 'Important: middle' },
    { role: 'assistant', reasoning: 'Key: repeat\nPreserve: newest' },
  ]);
  assert.deepEqual(collectNotes(items), ['Preserve: newest', 'Key: repeat', 'Important: middle', 'Key: old']);
});
test('history item limits use the shared compaction configuration', async () => {
  const { COMPACTION } = await import('../js/compaction-config.js');
  assert.equal(historyItems([{ role: 'assistant', reasoning: 'x'.repeat(COMPACTION.planTokens * 4) }])[0].kind, 'reasoning');
  assert.equal(historyItems([{ role: 'assistant', reasoning: 'x'.repeat(COMPACTION.planTokens * 4 + 1) }])[0].kind, 'plan');
  assert.equal(findNotes('Key: ' + 'x'.repeat(COMPACTION.noteChars * 2))[0].length, COMPACTION.noteChars);
});
test('plan threshold', () => {
  assert.deepEqual(historyItems([{ role: 'assistant', reasoning: 'x'.repeat(8000) }, { role: 'assistant', reasoning: 'x'.repeat(8001) }]).map((i) => i.kind), ['reasoning', 'plan']);
});
test('screenshot item', () => {
  const [item] = historyItems([
    { role: 'assistant', tool_calls: [call('screenshot', 's')] },
    { role: 'tool', tool_call_id: 's', content: [{ type: 'text', text: 'shot' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' }, meta: { pageId: 'doom' } }] },
  ]);
  assert.equal(item.pageId, 'doom');
  assert.equal(item.tokens, 1024 + Math.round(('{"id":"doom"}' + 'shot').length / 4));
});
test('notes', () => {
  assert.deepEqual(findNotes('x\nKey: grid is 16x16\n- important: use raycasting\n> Preserve: a\nnot Key: this'), ['Key: grid is 16x16', 'important: use raycasting', 'Preserve: a']);
  assert.equal(findNotes('Key: ' + 'a'.repeat(300))[0].length, 200);
  assert.ok(findNotes('Key: ' + 'a'.repeat(300))[0].endsWith('…'));
});
test('headTail', () => {
  assert.deepEqual(headTail('The wall textures render. Then more. Then I am done; give a short summary.'), { head: 'The wall textures render.', tail: 'Then I am done; give a short summary.' });
  assert.deepEqual(headTail('One sentence.'), { head: 'One sentence.', tail: '' });
  const { head } = headTail(Array(50).fill('word').join(' ') + '.');
  assert.equal(head.split(/\s+/).length, 30);
  assert.ok(head.endsWith('…'));
});
