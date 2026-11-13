import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeConfig, decodeConfig, readShareFromHash, normalizeBaseUrl, buildShareLink } from '../js/config.js';

test('round-trips a config including non-ASCII text', () => {
  const cfg = { v: 1, baseUrl: 'https://llm.example.com:8443/v1', apiKey: 'sk-abc', model: 'qwen', system: 'Réponds en français 🙂' };
  assert.deepEqual(decodeConfig(encodeConfig(cfg)), cfg);
});

test('encoding is base64url (no +, /, or = padding)', () => {
  const enc = encodeConfig({ v: 1, baseUrl: 'https://x/v1', apiKey: '???>>>~~~', system: 'ÿÿÿ' });
  assert.match(enc, /^[A-Za-z0-9_-]+$/);
});

test('readShareFromHash returns null when there is no c param', () => {
  assert.equal(readShareFromHash(''), null);
  assert.equal(readShareFromHash('#'), null);
  assert.equal(readShareFromHash('#other=1'), null);
});

test('readShareFromHash decodes the c param among others', () => {
  const enc = encodeConfig({ v: 1, baseUrl: 'https://x/v1' });
  assert.deepEqual(readShareFromHash(`#foo=1&c=${enc}`), { v: 1, baseUrl: 'https://x/v1' });
});

test('decodeConfig rejects garbage and missing baseUrl', () => {
  assert.throws(() => decodeConfig('!!!not-base64!!!'));
  assert.throws(() => decodeConfig(encodeConfig({ v: 1 })), /baseUrl/);
  assert.throws(() => decodeConfig(encodeConfig({ v: 99, baseUrl: 'https://x' })), /version/);
});

test('normalizeBaseUrl trims slashes and a pasted /chat/completions suffix', () => {
  assert.equal(normalizeBaseUrl(' https://x:1/v1/ '), 'https://x:1/v1');
  assert.equal(normalizeBaseUrl('https://x/v1/chat/completions'), 'https://x/v1');
  assert.equal(normalizeBaseUrl('https://x/v1/models'), 'https://x/v1');
});

test('buildShareLink drops empty optional fields and any existing hash', () => {
  const link = buildShareLink('https://me.github.io/chat-bridge/#old', { baseUrl: 'https://x/v1', apiKey: '', model: 'm', system: '' });
  assert.ok(link.startsWith('https://me.github.io/chat-bridge/#c='));
  assert.deepEqual(readShareFromHash(new URL(link).hash), { v: 1, baseUrl: 'https://x/v1', model: 'm' });
});
