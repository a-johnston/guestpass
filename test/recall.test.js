import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRecall } from '../js/recall.js';
const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' }, meta: { kind: 'screenshot', pageId: 'doom' } };
const ms = [
  { role: 'user', content: 'build a game' },
  { role: 'assistant', reasoning: 'Key: old\nThe wall textures render.', content: 'Key: new\nDone.' },
  { role: 'user', content: 'next' },
  { role: 'assistant', tool_calls: [{ id: 'p', type: 'function', function: { name: 'pane', arguments: JSON.stringify({ id: 'doom', html: '<p>wall tex</p>' }) } }] },
  { role: 'tool', tool_call_id: 'p', content: 'rendered' },
  { role: 'assistant', tool_calls: [{ id: 's', type: 'function', function: { name: 'screenshot', arguments: '{"id":"doom"}' } }] },
  { role: 'tool', tool_call_id: 's', content: [{ type: 'text', text: 'a screenshot' }, image] },
];
test('by id: original reasoning, text, arguments, results, images', () => {
  assert.match(runRecall(ms, { id: 'r1' }), /Key: old\nThe wall textures render\./);
  assert.match(runRecall(ms, { id: 'm0' }), /build a game/);
  assert.match(runRecall(ms, { id: 'm1' }), /Key: new\nDone\./);
  assert.match(runRecall(ms, { id: 'a3.0' }), /<p>wall tex<\/p>/);
  assert.match(runRecall(ms, { id: 't4' }), /rendered/);
  const shot = runRecall(ms, { id: 't6' });
  assert.match(shot.text, /a screenshot/);
  assert.deepEqual(shot.images, [{ dataUrl: image.image_url.url, meta: image.meta }]);
});
test('reused server call ids do not change recall result addresses', () => {
  const reused = structuredClone(ms);
  reused[3].tool_calls[0].id = 'call_0'; reused[4].tool_call_id = 'call_0';
  reused[5].tool_calls[0].id = 'call_0'; reused[6].tool_call_id = 'call_0';
  assert.match(runRecall(reused, { id: 't4' }), /rendered/);
  assert.deepEqual(runRecall(reused, { id: 't6' }).images, [{ dataUrl: image.image_url.url, meta: image.meta }]);
});
test('paging: every result is at most 16000 characters', () => {
  const huge = structuredClone(ms);
  huge[3].tool_calls[0].function.arguments = JSON.stringify({ id: 'doom', html: 'x'.repeat(40000) });
  const first = runRecall(huge, { id: 'a3.0' });
  assert.match(first, /^Item a3\.0 \(page "doom", message 3\), page 1 of 3:/);
  assert.match(first, /… continue with page=2$/);
  assert.ok(first.length <= 16000);
  const last = runRecall(huge, { id: 'a3.0', page: 3 });
  assert.doesNotMatch(last, /continue with/);
  assert.ok(last.length < 16000 && last.includes('xxxx'));
  assert.match(runRecall(huge, { id: 'a3.0', page: 99 }), /^Error:/);
});
test('search: snippets, regex, pagination, no matches', () => {
  const history = Array.from({ length: 25 }, () => ({ role: 'assistant', reasoning: 'The wall textures render.' }));
  const first = runRecall(history, { search: 'wall\\s+tex' });
  assert.match(first, /^Hits for \/wall\\s\+tex\/i, page 1:/);
  assert.match(first, /r12 \(reasoning, message 12\): …The wall textures render\.…/);
  assert.equal(first.split('\n').filter((l) => /^r\d+ /.test(l)).length, 20);
  assert.match(first, /continue with page=2/);
  assert.equal(runRecall(history, { search: 'wall', page: 2 }).split('\n').filter((l) => /^r\d+ /.test(l)).length, 5);
  assert.equal(runRecall(ms, { search: 'nonesuch' }), 'No matches for /nonesuch/i.');
});
test('notes newest first and deduplicated', () => {
  const history = [...ms, { role: 'assistant', reasoning: 'Key: old\nPreserve: latest' }];
  const out = runRecall(history, { id: 'notes' });
  assert.equal(out.match(/Key: old/g).length, 1);
  assert.ok(out.indexOf('Preserve: latest') < out.indexOf('Key: old'));
  assert.ok(out.indexOf('Key: old') < out.indexOf('Key: new'));
});
test('index by message range', () => {
  const out = runRecall(ms, { id: 'index:3-5' });
  assert.match(out, /a3\.0 page: /);
  assert.match(out, /a5\.0 shot: /);
  assert.doesNotMatch(out, /m0 user:/);
});
test('errors are strings, not exceptions', () => {
  assert.match(runRecall(ms, { search: '(' }), /^Error: invalid regex /);
  assert.equal(runRecall(ms, { id: 'zz9' }), 'Error: no item "zz9". Use an id from a stub, "notes", "index:A-B", or search.');
  assert.equal(runRecall(ms, {}), 'Error: give "id" or "search".');
  assert.match(runRecall(ms, { id: 'm0', page: -1 }), /^Error:/);
});
test('oversized original page ids cannot overflow the display header', () => {
  const huge = structuredClone(ms);
  huge[3].tool_calls[0].function.arguments = JSON.stringify({ id: 'x'.repeat(20000), html: 'source' });
  const result = runRecall(huge, { id: 'a3.0' });
  assert.ok(result.length <= 16000, `returned ${result.length} chars`);
  assert.match(result, /continue with page=2/);
});
test('long single-word indexes and many notes stay paged', () => {
  const history = Array.from({ length: 200 }, (_, i) => ({ role: 'assistant', reasoning: `Key: ${i} ` + 'x'.repeat(20000) }));
  for (const args of [{ id: 'notes' }, { id: 'index:0-199' }, { search: 'x' }]) {
    const out = runRecall(history, args);
    assert.ok(out.length <= 16000);
    assert.match(out, /continue with page=2/);
  }
});
