import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesFrom, streamChat, isMissingRoute, chainError } from '../js/api.js';

test('vision from the model entry wins over /props', () => {
  const caps = capabilitiesFrom({ inputModalities: ['text'] }, { modalities: { vision: true } });
  assert.equal(caps.vision, false);
});

test('vision falls back to /props modalities, else unknown', () => {
  assert.equal(capabilitiesFrom({ inputModalities: null }, { modalities: { vision: true } }).vision, true);
  assert.equal(capabilitiesFrom({ inputModalities: null }, null).vision, null);
});

test('documents and basalt come from props.basalt', () => {
  const caps = capabilitiesFrom({}, { basalt: { version: '0.3.3', capabilities: ['answer_now', 'documents'] } });
  assert.deepEqual([caps.documents, caps.basalt], [true, true]);
  assert.deepEqual([capabilitiesFrom({}, {}).documents, capabilitiesFrom({}, {}).basalt], [false, false]);
});

test('basalt behind CORS: /v1/status identifies it and its version enables documents', () => {
  // Browsers can't read basalt's /props (it only sends CORS headers on /v1/*).
  const caps = capabilitiesFrom({}, null, { service: 'basalt', engine: '0.3.3' });
  assert.deepEqual([caps.basalt, caps.documents], [true, true]);
  assert.deepEqual([capabilitiesFrom({}, null, { service: 'basalt', engine: '0.3.10' }).documents], [true]);
  assert.deepEqual([capabilitiesFrom({}, null, { service: 'basalt', engine: '0.3.2' }).documents], [false], 'older basalt drops file parts silently');
  assert.deepEqual([capabilitiesFrom({}, null, { service: 'basalt', engine: '1.0.0' }).documents], [true]);
  assert.deepEqual([capabilitiesFrom({}, null, { service: 'other' }).basalt], [false]);
});

test('context length: model entry, then props n_ctx', () => {
  assert.equal(capabilitiesFrom({ contextLength: 4096 }, { default_generation_settings: { n_ctx: 8192 } }).contextLength, 4096);
  assert.equal(capabilitiesFrom({ contextLength: null }, { default_generation_settings: { n_ctx: 8192 } }).contextLength, 8192);
});

const err = (fields) => Object.assign(new Error(fields.message || 'x'), fields);
const NOT_FOUND_MSG = 'HTTP 404: Response not found (evicted, deleted, store:false, or server restarted). Resend the full input without previous_response_id.';

test('isMissingRoute: only a non-JSON 404/405', () => {
  assert.equal(isMissingRoute(err({ status: 404, apiError: false })), true);
  assert.equal(isMissingRoute(err({ status: 405, apiError: false })), true);
  assert.equal(isMissingRoute(err({ status: 404, apiError: true, code: 'model_not_found' })), false, "the proxy's unknown model");
  assert.equal(isMissingRoute(err({ status: 400, apiError: false })), false);
  assert.equal(isMissingRoute(new Error('network')), false);
});

test('chainError: not found vs unsupported', () => {
  assert.equal(chainError(err({ status: 404, apiError: true, code: 'previous_response_not_found', message: NOT_FOUND_MSG })), 'not_found');
  assert.equal(chainError(err({ status: 404, apiError: true, message: 'HTTP 404: previous_response_id resp_3 not found' })), 'not_found', 'by message, without a code');
  assert.equal(chainError(err({ status: 400, message: 'HTTP 400: previous_response_id is not supported; send the whole conversation' })), 'unsupported');
  assert.equal(chainError(err({ status: 500, message: 'previous_response_id' })), null);
  assert.equal(chainError(err({ status: 400, message: 'bad image' })), null);
});

/** Runs fn with fetch stubbed to answer `respond(url, init)`; records the requests. */
async function withFetch(respond, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return respond(url, init); };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

test('streamChat responses dialect', async () => {
  const body = sse([
    { type: 'response.created', response: { id: 'resp_7' } },
    { type: 'response.output_text.delta', delta: 'hey' },
    { type: 'response.completed', response: { id: 'resp_7', store: true, output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
  ]);
  await withFetch(() => new Response(body, { headers: { 'content-type': 'text/event-stream' } }), async (calls) => {
    const sent = { input: [], stream: true };
    const r = await streamChat({ baseUrl: 'http://x/v1', apiKey: 'k', body: sent, dialect: 'responses' });
    assert.ok(calls[0].url.endsWith('/responses'));
    assert.deepEqual(JSON.parse(calls[0].init.body), sent, 'body sent as is');
    assert.deepEqual([r.content, r.responseId, r.stored, r.usage.total_tokens], ['hey', 'resp_7', true, 4]);
  });
});

test('streamChat responses dialect: a JSON reply is the completed response', async () => {
  const json = { id: 'r1', store: true, output: [{ type: 'message', content: [{ type: 'output_text', text: 'whole' }] }] };
  await withFetch(() => Response.json(json), async () => {
    const r = await streamChat({ baseUrl: 'http://x/v1', body: { input: [] }, dialect: 'responses' });
    assert.deepEqual([r.content, r.responseId], ['whole', 'r1']);
  });
});

test('streamChat chat dialect is unchanged', async () => {
  const body = 'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  await withFetch(() => new Response(body, { headers: { 'content-type': 'text/event-stream' } }), async (calls) => {
    const r = await streamChat({ baseUrl: 'http://x/v1', body: { messages: [] } });
    assert.ok(calls[0].url.endsWith('/chat/completions'));
    assert.equal(JSON.parse(calls[0].init.body).stream, true);
    assert.equal(r.content, 'hi');
  });
});

test('streamChat error fields', async () => {
  const apiErr = '{"error":{"message":"nope","code":"previous_response_not_found"}}';
  await withFetch(() => new Response(apiErr, { status: 404 }), async () => {
    await assert.rejects(streamChat({ baseUrl: 'http://x/v1', body: {}, dialect: 'responses' }),
      (e) => e.status === 404 && e.code === 'previous_response_not_found' && e.apiError === true && e.message === 'HTTP 404: nope');
  });
  await withFetch(() => new Response('Not Found', { status: 404 }), async () => {
    await assert.rejects(streamChat({ baseUrl: 'http://x/v1', body: {}, dialect: 'responses' }),
      (e) => e.status === 404 && e.apiError === false && e.message === 'HTTP 404: Not Found');
  });
});
