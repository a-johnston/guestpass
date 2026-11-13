import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeConfig, decodeConfig, readShareFromHash, normalizeBaseUrl, buildShareLink, compactUrl, expandUrl, CODE } from '../js/config.js';

const roundTrip = (cfg) => decodeConfig(encodeConfig(cfg));

test('the tailscale example compresses to a slug-like fragment', () => {
  const enc = encodeConfig({ baseUrl: 'https://homebox.tail4f7e21.ts.net/v1', apiKey: '123' });
  assert.match(enc, /^[A-Za-z0-9_-]+$/, 'base64url alphabet only');
  assert.ok(enc.length <= 22, `${enc.length} chars: ${enc}`);
  assert.deepEqual(decodeConfig(enc), { baseUrl: 'https://homebox.tail4f7e21.ts.net/v1', apiKey: '123', system: '' });
});

test('round-trips a variety of configs', () => {
  const cases = [
    { baseUrl: 'https://homebox.tail4f7e21.ts.net/v1', apiKey: '123', system: '' },
    { baseUrl: 'http://localhost:11434/v1', apiKey: '', system: '' },
    { baseUrl: 'http://192.168.1.20:8080/v1', apiKey: 'sk-AbCdEf123_xyz', system: '' },
    { baseUrl: 'https://api.example.com/openai/v1', apiKey: 'Bearer-ish.KEY/with+odd=chars', system: '' },
    { baseUrl: 'https://llm.example.dev', apiKey: 'k', system: '' },
    { baseUrl: 'https://x.io/v1', apiKey: 'k', system: 'Réponds en français, s’il te plaît 🙂 — "quoted", (parens) & more!' },
    { baseUrl: 'https://x.io/v1', apiKey: '', system: 'Be brief.' },
  ];
  for (const c of cases) assert.deepEqual(roundTrip(c), c, JSON.stringify(c));
});

test('defaults: https and /v1 are implied; anything else is kept explicitly', () => {
  assert.equal(compactUrl('https://host.ts.net/v1'), 'host.ts.net');
  assert.equal(compactUrl('http://host:8080/v1'), 'http://host:8080');
  assert.equal(compactUrl('https://host/'), 'host/', 'a root path is written, so it is not mistaken for /v1');
  assert.equal(compactUrl('https://host/api/v1'), 'host/api/v1');
  assert.equal(expandUrl('host.ts.net'), 'https://host.ts.net/v1');
  assert.equal(expandUrl('host/'), 'https://host');
  assert.equal(expandUrl('http://host:8080'), 'http://host:8080/v1');
  assert.equal(expandUrl('host/api/v1'), 'https://host/api/v1');
});

test('long, punctuation-heavy text falls back to raw bytes when that is shorter', () => {
  const system = '!!! ??? ### $$$ %%% ^^^ &&& *** ((( ))) [[[ ]]] {{{ }}} <<< >>> ||| ~~~ ``` ;;; ,,, \'\'\' """'.repeat(3);
  const enc = encodeConfig({ baseUrl: 'https://x.io/v1', apiKey: 'k', system });
  assert.equal(decodeConfig(enc).system, system);
  const rawBytes = Buffer.byteLength(`x.io k ${system}`);
  assert.ok(enc.length <= Math.ceil(((rawBytes + 1) * 8) / 6) + 1, 'no worse than raw plus the marker');
});

test('the code is a valid prefix code with a long enough all-ones tail for padding', () => {
  const max = Math.max(...CODE.lengths);
  assert.ok(max >= 6, 'padding (up to 5 one-bits) can never complete a code');
  const kraft = CODE.lengths.reduce((s, l) => s + 2 ** -l, 0);
  assert.ok(Math.abs(kraft - 1) < 1e-12, `complete code (Kraft sum ${kraft})`);
});

test('decodeConfig rejects malformed fragments and non-http URLs', () => {
  assert.throws(() => decodeConfig('!!!'), /malformed/);
  assert.throws(() => decodeConfig(''), /malformed/);
  // Zero bits where 1-padding belongs: decodes some symbols, then leaves a non-ones tail.
  assert.throws(() => decodeConfig('A'), /malformed/);
  // An escape (ESC + 8 bits) cut short.
  const esc = encodeConfig({ baseUrl: 'https://x.io/v1', apiKey: '€' });
  assert.equal(decodeConfig(esc).apiKey, '€');
  assert.throws(() => decodeConfig(esc.slice(0, -2)), /malformed/);
  // Note: a link cut at an arbitrary point can still decode to a (wrong) host; there's no
  // checksum, by design. It then fails to connect, which is visible.
});

test('readShareFromHash decodes the whole fragment', () => {
  assert.equal(readShareFromHash(''), null);
  assert.equal(readShareFromHash('#'), null);
  const enc = encodeConfig({ baseUrl: 'https://x/v1', apiKey: 'k' });
  assert.deepEqual(readShareFromHash(`#${enc}`), { baseUrl: 'https://x/v1', apiKey: 'k', system: '' });
});

test('normalizeBaseUrl trims slashes and a pasted endpoint suffix', () => {
  assert.equal(normalizeBaseUrl(' https://x:1/v1/ '), 'https://x:1/v1');
  assert.equal(normalizeBaseUrl('https://x/v1/chat/completions'), 'https://x/v1');
  assert.equal(normalizeBaseUrl('https://x/v1/models'), 'https://x/v1');
});

test('buildShareLink replaces any existing hash', () => {
  const link = buildShareLink('https://me.github.io/guestpass/#old', { baseUrl: 'https://x/v1/', apiKey: 'k' });
  assert.equal(link, `https://me.github.io/guestpass/#${encodeConfig({ baseUrl: 'https://x/v1', apiKey: 'k' })}`);
});
