import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeContent, coalesceMessages, contentText, prepareHistory, fence, userContent, clearableSummary, markCleared, estimateTokens } from '../js/content.js';

const URL = 'data:image/webp;base64,AAAA';
const img = (name, extra = {}) => ({ type: 'image_url', image_url: { url: URL }, meta: { kind: 'attachment', name, bytes: 27, mime: 'image/webp', ...extra } });
const shot = (pageId) => ({ type: 'image_url', image_url: { url: URL }, meta: { kind: 'screenshot', name: 'shot', pageId, bytes: 27, mime: 'image/webp' } });
const sent = (url = URL) => ({ type: 'image_url', image_url: { url } }); // what the server receives
const file = (name, extra = {}) => ({ type: 'file', file: { filename: name, file_data: 'data:text/plain;base64,YQ==' }, meta: { kind: 'attachment', name, bytes: 28, mime: 'text/plain', ...extra } });
const ON = { vision: true, documents: true, toolImages: true };
const call = (id) => ({ id, type: 'function', function: { name: 'screenshot', arguments: '{}' } });

test('mergeContent joins strings and promotes to parts', () => {
  assert.equal(mergeContent('a', 'b'), 'a\n\nb');
  assert.deepEqual(mergeContent('a', [img('x.png')]), [{ type: 'text', text: 'a' }, img('x.png')]);
  assert.deepEqual(mergeContent([img('x.png')], 'b'), [img('x.png'), { type: 'text', text: 'b' }]);
});

test('coalesceMessages preserves assistant text, reasoning, calls and content parts', () => {
  const ms = [
    { role: 'assistant', content: 'first', reasoning_content: 'reason one' },
    { role: 'assistant', content: [img('x.png'), { type: 'text', text: 'second' }], reasoning_content: 'reason two', tool_calls: [call('a'), call('b')] },
    { role: 'tool', tool_call_id: 'a', content: 'a result' },
    { role: 'tool', tool_call_id: 'b', content: 'b result' },
    { role: 'assistant', content: 'after tools' },
  ];
  const saved = structuredClone(ms);
  const out = coalesceMessages(ms);
  assert.deepEqual(out.map((m) => m.role), ['assistant', 'tool', 'tool', 'assistant']);
  assert.equal(contentText(out[0].content), 'first\n\nsecond');
  assert.equal(out[0].content[1].type, 'image_url');
  assert.equal(out[0].reasoning_content, 'reason one\n\nreason two');
  assert.deepEqual(out[0].tool_calls.map((c) => c.id), ['a', 'b']);
  assert.deepEqual(ms, saved);
});

test('userContent: text alone stays a string; attachments make parts', () => {
  assert.equal(userContent('hi'), 'hi');
  assert.deepEqual(userContent('hi', [img('x.png')]), [{ type: 'text', text: 'hi' }, img('x.png')]);
  assert.deepEqual(userContent('', [img('x.png')]), [img('x.png')]);
});

test('contentText with placeholders', () => {
  assert.equal(contentText([{ type: 'text', text: 'see' }, img('x.png'), shot('app')], { placeholders: true }),
    'see\n\n[image: x.png]\n\n[screenshot of "app"]');
  assert.equal(contentText([{ type: 'text', text: 'see' }, file('a.py')]), 'see');
  assert.equal(contentText('plain'), 'plain');
});

test('fence grows past backticks in the text', () => {
  assert.equal(fence('a ``` b'), '````\na ``` b\n````');
});

test('strips meta and leaves the input untouched', () => {
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'hi' }, img('x.png')] }];
  const out = prepareHistory(msgs, ON);
  assert.deepEqual(out, [{ role: 'user', content: [{ type: 'text', text: 'hi' }, sent()] }]);
  assert.ok(msgs[0].content[1].meta, 'local copy keeps meta');
});

test('prepareHistory sends every screenshot between compactions', () => {
  const msgs = [
    { role: 'assistant', content: '', tool_calls: [call('c1'), call('c2'), call('c3')] },
    { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'one' }, shot('app')] },
    { role: 'tool', tool_call_id: 'c2', content: [{ type: 'text', text: 'two' }, shot('b')] },
    { role: 'tool', tool_call_id: 'c3', content: [{ type: 'text', text: 'three' }, shot('app')] },
  ];
  const out = prepareHistory(msgs, ON);
  assert.deepEqual(out[1].content, [{ type: 'text', text: 'one' }, sent()]);
  assert.deepEqual(out[2].content, [{ type: 'text', text: 'two' }, sent()]);
  assert.deepEqual(out[3].content, [{ type: 'text', text: 'three' }, sent()]);
});

test('cleared media becomes placeholders', () => {
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'look' }, img('x.png')] },
    { role: 'assistant', content: 'ok' },
  ];
  markCleared(msgs, new Set(['inline', 'pane']));
  msgs.push({ role: 'user', content: [{ type: 'text', text: 'and' }, img('y.png')] });
  const out = prepareHistory(msgs, ON);
  assert.equal(out[0].content, 'look\n\n[image: x.png — cleared from history]');
  assert.deepEqual(out[2].content, [{ type: 'text', text: 'and' }, sent()]);
});

test('an attachment merged into a cleared message is still sent', () => {
  // A turn that failed before any reply leaves the user message last; the next send merges into it.
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'look' }, img('x.png')] }];
  markCleared(msgs, new Set(['inline', 'pane']));
  msgs[0].content = mergeContent(msgs[0].content, [img('y.png')]);
  assert.deepEqual(prepareHistory(msgs, ON)[0].content,
    [{ type: 'text', text: 'look' }, { type: 'text', text: '[image: x.png — cleared from history]' }, sent()]);
  assert.equal(clearableSummary(msgs, { renderTools: new Set(), charsPerToken: 4 }).items, 1, 'the new image counts as clearable');
});

test('markCleared marks page renders but not other tool calls', () => {
  const render = { id: 'r', type: 'function', function: { name: 'inline', arguments: '{"html":"<p>x</p>"}' } };
  const msgs = [{ role: 'assistant', content: '', tool_calls: [render, call('s')] }];
  markCleared(msgs, new Set(['inline', 'pane']));
  assert.deepEqual([msgs[0].tool_calls[0].cleared, msgs[0].tool_calls[1].cleared], [true, undefined]);
});

test('vision off replaces images', () => {
  const out = prepareHistory([{ role: 'user', content: [img('x.png')] }], { ...ON, vision: false });
  assert.equal(out[0].content, "[image: x.png — not sent, this model can't see images]");
});

test('vision unknown still sends images', () => {
  const out = prepareHistory([{ role: 'user', content: [img('x.png')] }], { ...ON, vision: null });
  assert.deepEqual(out[0].content, [sent()]);
});

test('documents off inlines text files and drops others', () => {
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'read' }, file('notes.py', { text: 'a = 1' }), file('spec.pdf', { mime: 'application/pdf' })] }];
  const out = prepareHistory(msgs, { ...ON, documents: false });
  assert.equal(out[0].content, "read\n\nnotes.py:\n```\na = 1\n```\n\n[file: spec.pdf — not sent, this server can't read it]");
});

test('documents on sends file parts without meta', () => {
  const out = prepareHistory([{ role: 'user', content: [file('notes.py', { text: 'a = 1' })] }], ON);
  assert.deepEqual(out[0].content, [{ type: 'file', file: { filename: 'notes.py', file_data: 'data:text/plain;base64,YQ==' } }]);
});

test('fallback keeps tool messages contiguous', () => {
  const msgs = [
    { role: 'assistant', content: '', tool_calls: [call('c1'), call('c2')] },
    { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'Screenshot of "a".' }, shot('a')] },
    { role: 'tool', tool_call_id: 'c2', content: [{ type: 'text', text: 'Screenshot of "b".' }, shot('b')] },
  ];
  const out = prepareHistory(msgs, { ...ON, toolImages: false });
  assert.deepEqual(out.map((m) => m.role), ['assistant', 'tool', 'tool', 'user']);
  assert.equal(out[1].content, 'Screenshot of "a".\n(Image attached in the next message.)');
  assert.equal(out[2].content, 'Screenshot of "b".\n(Image attached in the next message.)');
  assert.deepEqual(out[3].content, [{ type: 'text', text: 'Images returned by the tool calls above:' }, sent(), sent()]);
  assert.equal(out[1].tool_call_id, 'c1');
});

test('fallback merges into a following user message', () => {
  const msgs = [
    { role: 'assistant', content: '', tool_calls: [call('c1')] },
    { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'Shot.' }, shot('a')] },
    { role: 'user', content: 'next' },
  ];
  const out = prepareHistory(msgs, { ...ON, toolImages: false });
  assert.deepEqual(out.map((m) => m.role), ['assistant', 'tool', 'user']);
  assert.deepEqual(out[2].content, [{ type: 'text', text: 'Images returned by the tool calls above:' }, sent(), { type: 'text', text: 'next' }]);
});

test('fallback leaves tool messages without images alone', () => {
  const msgs = [
    { role: 'assistant', content: '', tool_calls: [call('c1')] },
    { role: 'tool', tool_call_id: 'c1', content: 'Rendered.' },
  ];
  assert.deepEqual(prepareHistory(msgs, { ...ON, toolImages: false }), msgs);
});

const RENDER = new Set(['inline', 'pane']);
const sized = (part, bytes, width, height) => ({ ...part, meta: { ...part.meta, bytes, width, height } });
const summaryMsgs = () => [
  { role: 'user', content: [{ type: 'text', text: 'look' }, sized(img('x.png'), 30000, 800, 600)] },
  { role: 'assistant', content: '', tool_calls: [{ id: 'r', type: 'function', function: { name: 'inline', arguments: JSON.stringify({ html: 'x'.repeat(4000) }) } }] },
  { role: 'tool', tool_call_id: 'r', content: 'Rendered.' },
  { role: 'assistant', content: '', tool_calls: [call('s1'), call('s2')] },
  { role: 'tool', tool_call_id: 's1', content: [{ type: 'text', text: 'one' }, sized(shot('a'), 20000, 1024, 768)] },
  { role: 'tool', tool_call_id: 's2', content: [{ type: 'text', text: 'two' }, sized(shot('a'), 21000, 1024, 768)] },
];

test('clearableSummary counts sendable media and live page HTML', () => {
  const s = clearableSummary(summaryMsgs(), { renderTools: RENDER, charsPerToken: 4 });
  assert.deepEqual(s, { bytes: 30000 + 4000 + 21000, tokens: 475 + 1000 + 768, items: 3 });
});

test('clearableSummary skips superseded page HTML', () => {
  const msgs = summaryMsgs();
  msgs[1].tool_calls[0].superseded = true;
  const s = clearableSummary(msgs, { renderTools: RENDER, charsPerToken: 4 });
  assert.deepEqual(s, { bytes: 30000 + 21000, tokens: 475 + 768, items: 2 });
});

test('clearableSummary counts text files by their text', () => {
  const msgs = [{ role: 'user', content: [file('a.py', { bytes: 500, text: 'x'.repeat(400) }), file('b.pdf', { bytes: 9000, mime: 'application/pdf' })] }];
  assert.deepEqual(clearableSummary(msgs, { renderTools: RENDER, charsPerToken: 4 }), { bytes: 9500, tokens: 100, items: 2 });
});

test('nothing already cleared counts', () => {
  const msgs = summaryMsgs();
  markCleared(msgs, RENDER);
  assert.deepEqual(clearableSummary(msgs, { renderTools: RENDER, charsPerToken: 4 }), { bytes: 0, tokens: 0, items: 0 });
});

test('estimateTokens: text by chars, images at their 1 MP cap, tool calls and reasoning', () => {
  assert.equal(estimateTokens([{ role: 'user', content: 'abcdefgh' }], { charsPerToken: 4 }), 2);
  assert.equal(estimateTokens([{ role: 'user', content: [
    { type: 'text', text: 'abcd' },
    { type: 'image_url', image_url: { url: 'data:image/webp;base64,AAAA' } },
  ] }], { charsPerToken: 4 }), 1025);
  assert.equal(estimateTokens([{
    role: 'assistant', content: '', reasoning_content: 'abcd',
    tool_calls: [{ id: 'c', type: 'function', function: { name: 'n', arguments: 'abcdefgh' } }],
  }], { charsPerToken: 4 }), 3);
  // 16 base64 chars decode to 12 bytes: 3 tokens at 4 chars per token.
  assert.equal(estimateTokens([{ role: 'user', content: [
    { type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,AAAAAAAAAAAAAAAA' } },
  ] }], { charsPerToken: 4 }), 3);
  assert.equal(estimateTokens([{ role: 'user', content: 'abcdefgh' }]), 2, 'defaults to 4 chars per token');
});

test('prepareHistory strips local call fields and sanitizes cut-off arguments', () => {
  const c = { id: 'c', type: 'function', function: { name: 'edit', arguments: '{"id":"a' }, superseded: true, cleared: true, cutOff: true };
  const msgs = [{ role: 'assistant', content: '', tool_calls: [c] }];
  assert.deepEqual(prepareHistory(msgs)[0].tool_calls, [{ id: 'c', type: 'function', function: { name: 'edit', arguments: '{}' } }]);
  assert.equal(c.function.arguments, '{"id":"a');
});
