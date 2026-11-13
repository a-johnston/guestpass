import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionToMarkdown } from '../js/session.js';

const savedAt = new Date(2026, 10, 12, 21, 5);

test('renders header, turns, and one Assistant heading across tool rounds', () => {
  const md = sessionToMarkdown([
    { role: 'user', content: 'draw a box' },
    { role: 'assistant', content: 'Sure.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'render_inline', arguments: JSON.stringify({ id: 'box', html: '<div>box</div>' }) } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'Rendered widget "box".' },
    { role: 'assistant', content: 'Done!' },
    { role: 'user', content: 'thanks' },
  ], { model: 'qwen', savedAt });

  assert.match(md, /^# Chat Bridge session\n\n- Saved: 2026-11-12 21:05\n- Model: qwen\n\n---\n\n## User\n\ndraw a box\n\n## Assistant\n\nSure\.\n/);
  assert.equal(md.match(/## Assistant/g).length, 1, 'tool rounds stay in one assistant section');
  assert.match(md, /<summary>Tool call: render_inline · box<\/summary>\n\n```json\n\{\n  "id": "box"\n\}\n```\n\n```html\n<div>box<\/div>\n```\n\nResult:\n\n```\nRendered widget "box"\.\n```\n\n<\/details>/);
  assert.match(md, /Done!\n\n## User\n\nthanks\n$/);
});

test('fences grow past backticks in the content', () => {
  const md = sessionToMarkdown([
    { role: 'assistant', content: '', tool_calls: [{ id: 'c', function: { name: 'kv', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c', content: 'has ``` inside' },
  ], { savedAt });
  assert.match(md, /````\nhas ``` inside\n````/);
});

test('includes the system prompt as a quote, never connection details', () => {
  const md = sessionToMarkdown([{ role: 'user', content: 'hi' }], { system: 'Be brief.\nBe kind.', savedAt });
  assert.match(md, /\*\*System prompt:\*\*\n\n> Be brief\.\n> Be kind\.\n/);
  assert.doesNotMatch(md, /Model:/, 'model line omitted when unknown');
});

test('unparseable tool arguments are kept raw', () => {
  const md = sessionToMarkdown([{ role: 'assistant', tool_calls: [{ id: 'x', function: { name: 'patch', arguments: '{oops' } }] }], { savedAt });
  assert.match(md, /<summary>Tool call: patch<\/summary>\n\n```\n\{oops\n```/);
});
