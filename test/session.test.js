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

  assert.match(md, /^# Guestpass session\n\n- Saved: 2026-11-12 21:05\n- Model: qwen\n\n---\n\n## User\n\ndraw a box\n\n## Assistant\n\nSure\.\n/);
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

test('thinking is a collapsed, quoted block above the reply, with its duration', () => {
  const md = sessionToMarkdown([
    { role: 'user', content: 'hm?' },
    { role: 'assistant', content: 'Answer.', reasoning: 'First idea.\n\nSecond </details> idea.', thinkingMs: 12400 },
    { role: 'assistant', content: 'No timing.', reasoning: 'x' },
  ], { savedAt });
  assert.match(md, /## Assistant\n\n<details>\n<summary>Thought for 12 seconds<\/summary>\n\n> First idea\.\n> \n> Second &lt;\/details> idea\.\n\n<\/details>\n\nAnswer\./);
  assert.match(md, /<summary>Thinking<\/summary>\n\n> x\n\n<\/details>\n\nNo timing\./);
});

test('formatDuration', async () => {
  const { formatDuration } = await import('../js/session.js');
  assert.deepEqual([400, 1000, 12400, 125000].map(formatDuration), ['1 second', '1 second', '12 seconds', '2m 5s']);
});

test('unparseable tool arguments are kept raw', () => {
  const md = sessionToMarkdown([{ role: 'assistant', tool_calls: [{ id: 'x', function: { name: 'patch', arguments: '{oops' } }] }], { savedAt });
  assert.match(md, /<summary>Tool call: patch<\/summary>\n\n```\n\{oops\n```/);
});
