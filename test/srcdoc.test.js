import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSrcdoc, kvLiteral, BOOTSTRAP_MARKER } from '../js/srcdoc.js';

test('kv snapshot is injected and cannot close the script tag', () => {
  const kv = { evil: '</script><script>alert(1)</script>', n: 1, line: 'a b' };
  const out = buildSrcdoc('<p>x</p>', { kv });
  const boot = out.slice(out.indexOf(BOOTSTRAP_MARKER));
  assert.equal(boot.indexOf('</script>'), boot.lastIndexOf('</script>'), 'only the bootstrap\'s own closing tag');
  assert.deepEqual(JSON.parse(kvLiteral(kv)), kv, 'escaped literal still round-trips');
});

const bootIndex = (s) => s.indexOf(BOOTSTRAP_MARKER);

test('wraps a fragment in a full standards-mode document with the bootstrap in head', () => {
  const out = buildSrcdoc('<p>hi</p>');
  assert.match(out, /^<!DOCTYPE html>/i);
  assert.ok(bootIndex(out) > 0 && bootIndex(out) < out.indexOf('<p>hi</p>'));
  assert.ok(out.indexOf('</head>') < out.indexOf('<p>hi</p>'));
});

test('injects right after <head> in a full document, keeping the doctype first', () => {
  const doc = '<!doctype html>\n<html lang="en"><head><title>t</title><script>boom()</script></head><body></body></html>';
  const out = buildSrcdoc(doc);
  assert.match(out, /^<!doctype html>/);
  assert.ok(bootIndex(out) > out.indexOf('<head>'));
  assert.ok(bootIndex(out) < out.indexOf('boom()'), 'bootstrap must run before page scripts');
});

test('injects after <html> when a document has no <head>', () => {
  const out = buildSrcdoc('<!DOCTYPE html><html><body><script>x()</script></body></html>');
  assert.ok(bootIndex(out) > out.indexOf('<html>') && bootIndex(out) < out.indexOf('x()'));
});

test('injection keeps line numbers: code on line N of the page is still on line N', () => {
  const lineOf = (doc, needle) => doc.slice(0, doc.indexOf(needle)).split('\n').length;
  const fragment = '<p>a</p>\n<p>b</p>\n<script>boom()</script>';
  assert.equal(lineOf(buildSrcdoc(fragment), 'boom()'), 3);
  const full = '<!doctype html>\n<html>\n<head>\n<title>x</title>\n</head>\n<body>\n<script>bang()</script>';
  assert.equal(lineOf(buildSrcdoc(full, { kv: { a: 'multi\nline' } }), 'bang()'), 7);
  const noHead = '<!DOCTYPE html>\n<html>\n<body>\n<script>pow()</script>';
  assert.equal(lineOf(buildSrcdoc(noHead), 'pow()'), 4);
});

test('does not mistake <header> for <head>', () => {
  const out = buildSrcdoc('<header>nav</header><main>m</main>');
  assert.ok(bootIndex(out) < out.indexOf('<header>'));
  assert.match(out, /^<!DOCTYPE html>/);
});
