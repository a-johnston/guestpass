import { test } from 'node:test';
import assert from 'node:assert/strict';

// frames.js listens for frame messages at import; tools.js only needs that to not throw here.
globalThis.window ??= { addEventListener() {} };
const { runTool, TOOL_DEFS } = await import('../js/tools.js');

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
