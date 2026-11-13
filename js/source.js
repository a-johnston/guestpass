// Text operations behind the read and edit tools: a page's source treated as a single file.
// Pure, so it is unit tested under Node.

/**
 * Replaces the one occurrence of `oldText` in `source` with `newText` (taken literally).
 * If there is no exact match, retries treating any run of whitespace as equivalent (models often
 * get indentation or line breaks slightly wrong); such edits are flagged `loose`.
 * Returns {source, startLine, endLine, loose?} (1-based lines covering the new text), or {error}
 * when `oldText` is empty, missing, or matches more than once. Missing-text errors name the
 * closest line, so the model can correct its quote without re-reading everything.
 */
export function applyEdit(source, oldText, newText) {
  if (!oldText || !oldText.trim()) return { error: 'old text is empty; include the exact text to replace' };

  let at = -1;
  let length = oldText.length;
  let loose;
  const exact = source.split(oldText).length - 1;
  if (exact > 1) return { error: `old text matches ${exact} places; include more surrounding text so it matches once` };
  if (exact === 1) {
    at = source.indexOf(oldText);
  } else {
    const matches = [...source.matchAll(looseRegExp(oldText))];
    if (matches.length > 1) return { error: `old text matches ${matches.length} places; include more surrounding text so it matches once` };
    if (matches.length === 0) {
      const hint = closestLine(source, oldText);
      return { error: `old text not found${hint ? ` (closest: line ${hint.line}, "${hint.text.trim()}")` : ''}; read the page to see its current source` };
    }
    at = matches[0].index;
    length = matches[0][0].length;
    loose = true;
  }

  const updated = source.slice(0, at) + newText + source.slice(at + length);
  const startLine = source.slice(0, at).split('\n').length;
  const endLine = startLine + Math.max(0, newText.split('\n').length - 1 - (newText.endsWith('\n') ? 1 : 0));
  return loose ? { source: updated, startLine, endLine, loose } : { source: updated, startLine, endLine };
}

/**
 * Replaces lines start..end (1-based, inclusive) with `newText`; empty `newText` deletes them.
 * Lets a model make structural edits (drop a block, rewrite a function) by the line numbers `read`
 * shows, without quoting the old text. Returns {source, startLine, endLine} or {error}.
 */
export function applyLineEdit(source, start, end, newText) {
  const lines = source.split('\n');
  if (!Number.isInteger(start) || start < 1) return { error: 'start must be a line number (1 or more)' };
  if (!Number.isInteger(end) || end < start) return { error: 'end must be a line number at or after start' };
  if (start > lines.length) return { error: `the page has only ${lines.length} lines` };
  const last = Math.min(end, lines.length);
  const replacement = newText === '' ? [] : newText.replace(/\n$/, '').split('\n');
  lines.splice(start - 1, last - start + 1, ...replacement);
  return { source: lines.join('\n'), startLine: start, endLine: start + Math.max(0, replacement.length - 1) };
}

/**
 * Syntax errors in the page's classic inline scripts, as [{line, message}] where `line` is the
 * page line of the <script> tag. Each script is compiled with `new Function`, which parses but
 * never runs it. Module, JSON/template, and external scripts are skipped (Function can't parse
 * import/export, and the others aren't JavaScript to check).
 */
export function scriptSyntaxErrors(source) {
  const errors = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const m of source.matchAll(re)) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1]?.toLowerCase();
    if (type && !/^(text|application)\/(java|ecma)script$/.test(type)) continue;
    try {
      new Function(m[2]); // eslint-disable-line no-new-func -- compile only
    } catch (e) {
      if (e instanceof SyntaxError) errors.push({ line: source.slice(0, m.index).split('\n').length, message: e.message });
    }
  }
  return errors;
}

/** `text` as a regex where every run of whitespace matches any run of whitespace. */
function looseRegExp(text) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(text.trim().split(/\s+/).map(escape).join('\\s+'), 'g');
}

/** The source line sharing the most words with the first line of `oldText` (at least half), if any. */
function closestLine(source, oldText) {
  const firstLine = oldText.split('\n').find((l) => l.trim()) || '';
  const words = new Set(firstLine.match(/\w+/g) || []);
  if (!words.size) return null;
  let best = null;
  source.split('\n').forEach((text, i) => {
    const lineWords = new Set(text.match(/\w+/g) || []);
    let shared = 0;
    for (const w of words) if (lineWords.has(w)) shared++;
    const score = shared / words.size;
    if (score >= 0.5 && (!best || score > best.score)) best = { line: i + 1, text, score };
  });
  return best;
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
