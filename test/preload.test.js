import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = 'js/main.js';

/** Static imports reachable from the entry, as root-relative paths. Dynamic import() is not followed. */
function staticGraph(entry) {
  const seen = new Set();
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const source = readFileSync(join(root, path), 'utf8');
    for (const [, spec] of source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]/gm)) {
      visit(relative(root, normalize(join(root, dirname(path), spec))));
    }
  };
  visit(entry);
  seen.delete(entry);
  return seen;
}

test('index.html preloads exactly the static module graph, so it loads in one round trip', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const preloaded = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(preloaded).size, preloaded.length, 'duplicate modulepreload');
  assert.deepEqual(preloaded.toSorted(), [...staticGraph(ENTRY)].toSorted());
});

test('highlight.js stays off the initial load', () => {
  assert.ok(!staticGraph(ENTRY).has('vendor/highlight.min.js'));
});
