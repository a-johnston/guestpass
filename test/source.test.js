import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit, numberLines } from '../js/source.js';

const src = '<h1>Title</h1>\n<p>one</p>\n<p>two</p>\n<script>\n  let n = 1;\n</script>';

test('applyEdit replaces a unique match and reports the changed lines', () => {
  const r = applyEdit(src, '<p>two</p>', '<p>TWO</p>\n<p>three</p>');
  assert.equal(r.source, '<h1>Title</h1>\n<p>one</p>\n<p>TWO</p>\n<p>three</p>\n<script>\n  let n = 1;\n</script>');
  assert.deepEqual([r.startLine, r.endLine], [3, 4]);
});

test('applyEdit takes replacement text literally ($ patterns are not special)', () => {
  assert.equal(applyEdit('a X b', 'X', '$& $1 $$').source, 'a $& $1 $$ b');
});

test('applyEdit can delete (empty new text)', () => {
  const r = applyEdit(src, '<p>one</p>\n', '');
  assert.equal(r.source.split('\n')[1], '<p>two</p>');
  assert.deepEqual([r.startLine, r.endLine], [2, 2]);
});

test('applyEdit errors: not found, ambiguous, empty old', () => {
  assert.match(applyEdit(src, '<p>four</p>', 'x').error, /not found/);
  assert.match(applyEdit(src, '<p>', 'x').error, /matches 2 places/);
  assert.match(applyEdit(src, '', 'x').error, /empty/);
});

test('numberLines numbers the whole source or an inclusive 1-based range', () => {
  assert.equal(numberLines('a\nb\nc'), '1| a\n2| b\n3| c');
  assert.equal(numberLines(src, 4, 5), '4| <script>\n5|   let n = 1;');
  assert.equal(numberLines('x\n'.repeat(12).trimEnd(), 9, 10), ' 9| x\n10| x', 'pads to the widest number shown');
});

test('numberLines clamps out-of-range requests and says what exists', () => {
  assert.equal(numberLines('a\nb', 2, 99), '2| b');
  assert.match(numberLines('a\nb', 5, 9), /only 2 lines/);
});
