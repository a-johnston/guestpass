import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSrcdoc, BOOTSTRAP_MARKER } from '../js/srcdoc.js';

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

test('does not mistake <header> for <head>', () => {
  const out = buildSrcdoc('<header>nav</header><main>m</main>');
  assert.ok(bootIndex(out) < out.indexOf('<header>'));
  assert.match(out, /^<!DOCTYPE html>/);
});
