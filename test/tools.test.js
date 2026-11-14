import { test } from 'node:test';
import assert from 'node:assert/strict';

// frames.js listens for frame messages at import; tools.js only needs that to not throw here.
globalThis.window ??= { addEventListener() {} };
const { runTool, TOOL_DEFS } = await import('../js/tools.js');

test('recall definition and dispatch', async () => {
  const def = TOOL_DEFS.find((d) => d.function.name === 'recall')?.function;
  assert.ok(def);
  assert.equal(def.parameters.required, undefined);
  assert.deepEqual(Object.keys(def.parameters.properties), ['id', 'search', 'page']);
  assert.equal(await runTool('recall', { id: 'r1' }, { recall: (a) => a.id }), 'r1');
});

test('page renders and edits reject copied history placeholders before touching a page', async () => {
  const { OMITTED_MARKER, compactHistory } = await import('../js/compact.js');
  const history = (name, args) => [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    { role: 'tool', tool_call_id: 'c', content: 'Edited "doom" (lines 1-2); reloaded.' },
  ];
  const page = compactHistory(history('inline', { id: 'doom', html: 'x'.repeat(20000) }), { window: 1800 });
  const edit = compactHistory(history('edit', { id: 'doom', start: 1, end: 2, new: 'x'.repeat(20000) }), { window: 1800 });
  const pageArgs = JSON.parse(page.messages[1].tool_calls[0].function.arguments);
  const editArgs = JSON.parse(edit.messages[1].tool_calls[0].function.arguments);
  assert.ok(pageArgs.html.includes(OMITTED_MARKER));
  assert.ok(editArgs.new.includes(OMITTED_MARKER));
  for (const [name, args] of [['inline', pageArgs], ['pane', pageArgs], ['edit', editArgs]]) {
    assert.match(await runTool(name, args, {}), /history placeholder, not page source/);
  }
});

test('edit rejects placeholder replacements even without an existing page', async () => {
  assert.match(await runTool('edit', { id: 'doom', start: 1, new: '[not page source: edit of lines 1–2]' }, {}), /history placeholder, not page source/);
});

const inlineDef = TOOL_DEFS.find((d) => d.function.name === 'inline').function;

test('inline requires an id and no longer takes a height', () => {
  assert.deepEqual(inlineDef.parameters.required, ['id', 'html']);
  assert.equal(inlineDef.parameters.properties.height, undefined);
});

test('inline without a usable id is refused instead of getting a made-up one', async () => {
  const mounted = [];
  const ui = { mountInline: (w) => mounted.push(w), inline: { has: () => false }, panes: { has: () => false } };
  for (const id of [undefined, '', '   ']) {
    assert.equal(await runTool('inline', { id, html: '<p>hi</p>' }, ui), 'Error: "id" is required.');
  }
  assert.equal(mounted.length, 0);
});
