// Text operations behind the read and edit tools: a page's source treated as a single file.
// Pure, so it is unit tested under Node.

/**
 * Replaces the one occurrence of `oldText` in `source` with `newText` (taken literally).
 * Returns {source, startLine, endLine} (1-based lines covering the new text, for the tool
 * result), or {error} when `oldText` is empty, missing, or matches more than once.
 */
export function applyEdit(source, oldText, newText) {
  if (!oldText) return { error: 'old text is empty; include the exact text to replace' };
  const at = source.indexOf(oldText);
  if (at === -1) return { error: 'old text not found; read the page to see its current source' };
  const count = source.split(oldText).length - 1;
  if (count > 1) return { error: `old text matches ${count} places; include more surrounding text so it matches once` };
  const updated = source.slice(0, at) + newText + source.slice(at + oldText.length);
  const startLine = source.slice(0, at).split('\n').length;
  const endLine = startLine + Math.max(0, newText.split('\n').length - 1 - (newText.endsWith('\n') ? 1 : 0));
  return { source: updated, startLine, endLine };
}

/** Line-numbered source, optionally an inclusive 1-based range (clamped to what exists). */
export function numberLines(source, start = 1, end = Infinity) {
  const lines = source.split('\n');
  const from = Math.max(1, Math.floor(start) || 1);
  const to = Math.min(lines.length, Math.floor(end) || lines.length);
  if (from > lines.length) return `(the page has only ${lines.length} lines)`;
  const width = String(to).length;
  return lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(width)}| ${l}`).join('\n');
}
