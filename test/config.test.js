import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeConfig, decodeConfig, readShareFromHash, normalizeBaseUrl, buildShareLink } from '../js/config.js';

const b64 = (s) => Buffer.from(s).toString('base64url');

test('payload is "baseUrl apiKey" as unpadded base64url', () => {
  const enc = encodeConfig({ baseUrl: 'https://box.tail1234.ts.net:8443/v1', apiKey: 'sk-abc123' });
  assert.equal(Buffer.from(enc, 'base64url').toString(), 'https://box.tail1234.ts.net:8443/v1 sk-abc123');
  assert.match(enc, /^[A-Za-z0-9_-]+$/, 'no +, /, or = padding');
});

test('trailing empty fields are omitted', () => {
  assert.equal(Buffer.from(encodeConfig({ baseUrl: 'https://x/v1' }), 'base64url').toString(), 'https://x/v1');
  assert.equal(Buffer.from(encodeConfig({ baseUrl: 'https://x/v1', apiKey: '', system: 'hi' }), 'base64url').toString(), 'https://x/v1  hi');
});

test('round-trips, including a system prompt with spaces and non-ASCII', () => {
  const cfg = { baseUrl: 'https://x:1/v1', apiKey: 'sk-1', system: 'Réponds en français, s’il te plaît 🙂' };
  assert.deepEqual(decodeConfig(encodeConfig(cfg)), cfg);
  assert.deepEqual(decodeConfig(encodeConfig({ baseUrl: 'https://x/v1', system: 'a b' })), { baseUrl: 'https://x/v1', apiKey: '', system: 'a b' });
  assert.deepEqual(decodeConfig(encodeConfig({ baseUrl: 'https://x/v1' })), { baseUrl: 'https://x/v1', apiKey: '', system: '' });
});

test('decodes with or without base64 padding', () => {
  const padded = Buffer.from('https://x/v1 k').toString('base64');
  assert.ok(padded.endsWith('='));
  assert.equal(decodeConfig(padded).apiKey, 'k');
});

test('rejects garbage and non-http URLs', () => {
  assert.throws(() => decodeConfig('!!!not-base64!!!'), /malformed/);
  assert.throws(() => decodeConfig(b64('not a url')), /server URL/);
  assert.throws(() => decodeConfig(b64('javascript:alert(1) k')), /server URL/);
  assert.throws(() => decodeConfig(Buffer.from([0xff, 0xfe]).toString('base64url')), /malformed/);
});

test('readShareFromHash decodes the whole fragment', () => {
  assert.equal(readShareFromHash(''), null);
  assert.equal(readShareFromHash('#'), null);
  assert.deepEqual(readShareFromHash(`#${b64('https://x/v1 k')}`), { baseUrl: 'https://x/v1', apiKey: 'k', system: '' });
  assert.throws(() => readShareFromHash('#garbage!!'), /malformed/);
});

test('normalizeBaseUrl trims slashes and a pasted endpoint suffix', () => {
  assert.equal(normalizeBaseUrl(' https://x:1/v1/ '), 'https://x:1/v1');
  assert.equal(normalizeBaseUrl('https://x/v1/chat/completions'), 'https://x/v1');
  assert.equal(normalizeBaseUrl('https://x/v1/models'), 'https://x/v1');
});

test('buildShareLink replaces any existing hash', () => {
  const link = buildShareLink('https://me.github.io/guestpass/#old', { baseUrl: 'https://x/v1/', apiKey: 'k' });
  assert.equal(link, `https://me.github.io/guestpass/#${b64('https://x/v1 k')}`);
});
