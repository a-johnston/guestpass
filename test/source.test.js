import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit, applyLineEdit, numberLines, scriptSyntaxErrors } from '../js/source.js';

test('applyLineEdit replaces an inclusive line range (and deletes with empty text)', () => {
  const s = 'a\nb\nc\nd\ne';
  assert.deepEqual(applyLineEdit(s, 2, 3, 'B\nC2\nC3'), { source: 'a\nB\nC2\nC3\nd\ne', startLine: 2, endLine: 4 });
  assert.deepEqual(applyLineEdit(s, 2, 4, ''), { source: 'a\ne', startLine: 2, endLine: 2 });
  assert.equal(applyLineEdit(s, 5, 5, 'E\nF').source, 'a\nb\nc\nd\nE\nF', 'last line');
  assert.match(applyLineEdit(s, 4, 2, 'x').error, /end must be .* after start/);
  assert.match(applyLineEdit(s, 6, 6, 'x').error, /only 5 lines/);
  assert.match(applyLineEdit(s, 0, 1, 'x').error, /start/);
});

test('scriptSyntaxErrors finds broken classic inline scripts, with their page line', () => {
  const page = '<p>x</p>\n<script>\nlet ok = 1;\n</script>\n<script>\nlist.sort(a=>a[0]-b=>0);\n</script>';
  const errs = scriptSyntaxErrors(page);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].line, 5, 'line of the <script> tag');
  assert.ok(errs[0].message.length > 0);
  assert.deepEqual(scriptSyntaxErrors('<script>let ok = 1;</script>'), []);
});

test('scriptSyntaxErrors skips modules, JSON/templates, external scripts, and never runs code', () => {
  globalThis.__ran = false;
  const page = [
    '<script type="module">import x from "./x.js"; export default 1;</script>',
    '<script type="application/json">{"a": </script>',
    '<script src="https://cdn.example/lib.js"></script>',
    '<script>globalThis.__ran = true;</script>',
  ].join('\n');
  assert.deepEqual(scriptSyntaxErrors(page), []);
  assert.equal(globalThis.__ran, false, 'compiled, not executed');
});

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
  assert.match(applyEdit(src, '  \n ', 'x').error, /empty/);
});

test('applyEdit falls back to whitespace-insensitive matching, and says so', () => {
  const code = 'function f() {\n    let a = 1;\n    return a;\n}';
  const r = applyEdit(code, 'let a = 1;\n  return a;', 'let a = 2;\n    return a;'); // wrong indentation
  assert.equal(r.source, 'function f() {\n    let a = 2;\n    return a;\n}');
  assert.equal(r.loose, true);
  assert.deepEqual([r.startLine, r.endLine], [2, 3]);
  assert.equal(applyEdit(code, 'let a = 1;', 'let a = 3;').loose, undefined, 'exact matches are not flagged');
  assert.match(applyEdit('a  b\na b', 'a   b', 'x').error, /matches 2 places/, 'loose matching still requires uniqueness');
});

test('applyEdit points at the closest line when nothing matches', () => {
  const code = 'const speed = 4;\nconst turnRate = 0.05;\nfunction tick() {}';
  const r = applyEdit(code, 'const turn_rate = 0.05;', 'x');
  assert.match(r.error, /not found/);
  assert.match(r.error, /^old text not found \(closest: line 2, "const turnRate = 0\.05;"\); read the page/);
  assert.doesNotMatch(applyEdit(code, 'zzz qqq', 'x').error, /closest/, 'no hint when nothing is similar');
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
