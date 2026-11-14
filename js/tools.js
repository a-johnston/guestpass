// Tools the model can call. They run entirely in this page: HTML is rendered into sandboxed
// iframes, either inline in the chat or in a side pane. Widgets and panes ("pages") share one
// id namespace; rendering an id that already exists replaces it.
//
// The definitions and TOOL_SYSTEM_HINT are sent with every request and there is no compaction,
// so they are deliberately terse (~840 tokens on a Qwen template, of which ~540 is the template's
// fixed tool wrapper). Facts shared by all pages live once in the hint; descriptions state only
// what a model can't infer. Measure before growing them.
import { getFrame, settle, formatLogs, patchFrame, updateKv, captureFrame } from './frames.js';
import { applyEdit, applyLineEdit, numberLines, scriptSyntaxErrors } from './source.js';
import { compressImage, IMAGE_QUALITY } from './media.js';

const idParam = { type: 'string', description: 'Page id' };
const htmlParam = { type: 'string', description: 'Fragment or full document' };
const fn = (name, description, properties, required) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, ...(required ? { required } : {}) } },
});

export const TOOL_DEFS = [
  fn('inline', 'Render an HTML widget in the chat.', {
    id: idParam,
    title: { type: 'string' },
    html: htmlParam,
  }, ['id', 'html']),
  fn('pane', 'Open HTML in a pane beside the chat.', {
    id: { type: 'string' },
    title: { type: 'string' },
    html: htmlParam,
  }, ['id', 'html']),
  fn('patch', 'Update a page in place with a payload. Returns result, fails if no window.onPatch.', {
    id: idParam,
    data: { description: 'JSON' },
  }, ['id', 'data']),
  fn('kv', 'Read the shared store, optionally setting keys first (null deletes). Returns the whole store.', {
    set: { type: 'object' },
  }),
  fn('edit', "Replace text in a page's source and reload it: old must match exactly once, or give start/end to replace those lines. Edits that would break a script are rejected.", {
    id: idParam,
    old: { type: 'string' },
    new: { type: 'string' },
    start: { type: 'integer' },
    end: { type: 'integer' },
  }, ['id', 'new']),
  fn('read', "A page's current source with line numbers. Without id, lists open pages.", {
    id: idParam,
    start: { type: 'integer' },
    end: { type: 'integer' },
  }),
  fn('close', 'Close a page.', { id: idParam }, ['id']),
  fn('read_console', "A page's console output that you haven't seen yet.", {
    id: idParam,
    wait: { type: 'integer', description: 'ms to wait for new output (max 5000)' },
  }, ['id']),
];

/** Only offered when the model may be able to see images. */
export const SCREENSHOT_DEF = fn('screenshot', 'See a page as an image, as the user sees it.', { id: idParam }, ['id']);

/** The tool list for a request: screenshot is left out once the model is known not to see images. */
export function toolDefs({ vision }) {
  return vision === false ? TOOL_DEFS : [...TOOL_DEFS, SCREENSHOT_DEF];
}

export const TOOL_SYSTEM_HINT = 'Your tools can render web pages here: use them when a visual or interactive result helps. ' +
  'Pages are sandboxed iframes: no storage or access to the chat; CDN scripts work. ' +
  "fetch() only reaches CORS-enabled servers: if blocked, don't retry. " +
  'In pages: kv is a store shared live by all pages and the kv tool (get(k), set(k, v), delete(k), all(); subscribe((k, v) => …) fires on every change). ' +
  'Defining window.onPatch = (data) => result lets the patch tool update a page in place. ' +
  'Inline and pane pages share one id namespace: reusing an id replaces the existing one. ' +
  'Each page is a single-file app: build large ones incrementally, starting small and then using edit. ' +
  'inline, pane, edit, and patch return console output.';

/** Tools that render a page (and so can supersede an earlier render of the same id). */
export const RENDER_TOOLS = new Set(['inline', 'pane']);

/**
 * What a superseded render's HTML is replaced with in the history sent to the model. Worded so it
 * can't pass for source: a model once copied the old placeholder back in as a page's HTML.
 */
export const OMITTED_MARKER = '[not page source';
export const omittedHtml = (id) =>
  `${OMITTED_MARKER}: omitted from history after a later render of "${id}". Use read("${id}") for the current source.]`;

/** Page HTML after "Clear media"; keeps OMITTED_MARKER so checkHtml rejects it as source. */
export const clearedHtml = (id) =>
  `${OMITTED_MARKER}: cleared from history. Use read("${id}") for the current source.]`;

function checkHtml(html) {
  if (typeof html !== 'string' || !html.trim()) return 'Error: "html" is required.';
  if (html.includes(OMITTED_MARKER)) {
    return 'Error: that html contains a history placeholder, not page source. Use read(id) to get the current source.';
  }
  return null;
}

const MAX_RESULT_CHARS = 8000;
const MAX_READ_CHARS = 20000; // ~5k tokens: most single-file apps in one or two reads
const MAX_CONSOLE_WAIT_MS = 5000;
let autoId = 0;

/**
 * Executes a tool call. `ui` supplies the DOM side:
 *   ui.mountInline({id, title, html}) — adds a widget card to the current reply, replacing any widget with that id
 *   ui.inline — {has(id), remove(id), expand(id)} for inline widgets
 *   ui.panes — the pane manager (open/close/has/ids)
 *   ui.canRerender(id) / ui.rerender(id, html) — reload a widget or pane in place with new source (edit)
 *   ui.imageMime() — the format screenshots are encoded in
 * Returns the string sent back to the model as the tool result, or {text, images} when the
 * result includes images (each {dataUrl, meta}, see content.js).
 */
export async function runTool(name, rawArgs, ui) {
  let args;
  try {
    args = typeof rawArgs === 'string' ? (rawArgs.trim() ? JSON.parse(rawArgs) : {}) : rawArgs || {};
  } catch (e) {
    return `Error: arguments were not valid JSON (${e.message}). Call the tool again with valid JSON arguments.`;
  }
  // Console output shown in a tool result counts as read, so read_console then reports only newer lines.
  const consoleOf = (id, since = 0) => {
    const f = getFrame(id);
    if (!f) return '(no console output)';
    f.readCursor = f.logs.length;
    return formatLogs(f.logs, { onlySince: since });
  };

  switch (name) {
    case 'inline': {
      const bad = checkHtml(args.html);
      if (bad) return bad;
      // No made-up ids: an anonymous draft followed by a named final render left both on screen.
      const id = sanitizeId(args.id);
      if (!id) return 'Error: "id" is required.';
      // Never silently swap a page's kind: replacing a pane with a widget lost a whole app once.
      if (ui.panes.has(id)) return `Error: "${id}" is open as a pane. Use pane to replace it, or close it first.`;
      const replaced = ui.inline.has(id);
      ui.mountInline({ id, title: args.title, html: args.html });
      await settle(id);
      return `${replaced ? 'Replaced' : 'Rendered'} widget "${id}".\nConsole:\n${consoleOf(id)}`;
    }
    case 'pane': {
      const bad = checkHtml(args.html);
      if (bad) return bad;
      const id = sanitizeId(args.id) || `pane-${++autoId}`;
      if (ui.inline.has(id)) return `Error: "${id}" is an inline widget. Use inline to replace it, or close it first.`;
      const replaced = ui.panes.has(id);
      ui.panes.open(id, args.title || ui.panes.titleOf(id) || id, args.html);
      await settle(id);
      return `${replaced ? 'Replaced the source of' : 'Opened'} pane "${id}".\nConsole:\n${consoleOf(id)}`;
    }
    case 'patch': {
      const id = sanitizeId(args.id);
      const before = getFrame(id)?.logs.length ?? 0;
      const { ok, value } = await patchFrame(id, args.data ?? null);
      await new Promise((r) => setTimeout(r, 150)); // let console output from the handler arrive
      const shown = typeof value === 'string' ? value : JSON.stringify(value);
      return ok
        ? truncate(`Patched "${id}". onPatch returned: ${shown ?? 'undefined'}\nConsole:\n${consoleOf(id, before)}`)
        : truncate(`Error: patch failed: ${shown}\nConsole:\n${consoleOf(id, before)}`);
    }
    case 'kv': {
      if (args.set != null && (typeof args.set !== 'object' || Array.isArray(args.set))) return 'Error: "set" must be an object.';
      return truncate(JSON.stringify(updateKv(args.set || {}), null, 1));
    }
    case 'close': {
      const id = sanitizeId(args.id);
      if (ui.panes.has(id)) { ui.panes.close(id); return `Closed pane "${id}".`; }
      if (ui.inline.has(id)) { ui.inline.remove(id); return `Removed widget "${id}".`; }
      return `No widget or pane with id "${id}". Open panes: ${ui.panes.ids().join(', ') || '(none)'}`;
    }
    case 'read_console': {
      const id = sanitizeId(args.id);
      const f = getFrame(id);
      if (!f) return `No widget or pane with id "${args.id}".`;
      // Only what's new since the last look (render/edit/patch results count as a look), so
      // polling a page that reports on a timer isn't buried in old lines. `wait` holds the call
      // until something new arrives, since output from timers lands after the page has loaded.
      const waitMs = Math.min(Math.max(Number(args.wait) || 0, 0), MAX_CONSOLE_WAIT_MS);
      const deadline = Date.now() + waitMs;
      while (f.logs.length <= (f.readCursor || 0) && Date.now() < deadline && getFrame(id) === f) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const seen = f.readCursor || 0;
      const fresh = f.logs.slice(seen);
      f.readCursor = f.logs.length;
      const note = seen ? `(${seen} earlier line${seen === 1 ? '' : 's'} already read)\n` : '';
      return truncate(`${note}${fresh.length ? formatLogs(fresh) : `(no new console output${waitMs ? ` after ${waitMs} ms` : ''})`}`);
    }
    case 'edit': {
      const id = sanitizeId(args.id);
      const f = getFrame(id);
      if (!f || !ui.canRerender(id)) return `Error: no widget or pane with id "${id}".`;
      if (typeof args.new !== 'string') return 'Error: "new" must be a string.';
      const byLines = args.old == null && (args.start != null || args.end != null);
      if (!byLines && typeof args.old !== 'string') return 'Error: give "old" (text to replace) or "start"/"end" (lines to replace).';
      const r = byLines
        ? applyLineEdit(f.html, Number(args.start), Number(args.end ?? args.start), args.new)
        : applyEdit(f.html, args.old, args.new);
      if (r.error) return `Error: ${r.error}.`;
      // Refuse edits that would leave a script unparseable: the page keeps working and the model
      // fixes its edit, instead of reloading a broken page and learning from the console.
      const before = scriptSyntaxErrors(f.html).length;
      const after = scriptSyntaxErrors(r.source);
      if (after.length > before) {
        const e = after[after.length - 1];
        return `Error: edit not applied, it would break the <script> at line ${e.line}: ${e.message}. The page is unchanged.`;
      }
      ui.rerender(id, r.source);
      await settle(id);
      const where = r.startLine === r.endLine ? `line ${r.startLine}` : `lines ${r.startLine}-${r.endLine}`;
      const loose = r.loose ? ', matched ignoring whitespace' : '';
      return `Edited "${id}" (${where}${loose}); reloaded.\nConsole:\n${consoleOf(id)}`;
    }
    case 'read': {
      if (args.id == null || args.id === '') {
        const pages = ui.listPages();
        return pages.length
          ? pages.map((p) => `${p.id} (${p.kind}${p.title && p.title !== p.id ? `, "${p.title}"` : ''}, ${p.lines} lines)`).join('\n')
          : '(no open pages)';
      }
      const id = sanitizeId(args.id);
      const f = getFrame(id);
      if (!f) return `Error: no widget or pane with id "${id}". Open pages: ${ui.listPages().map((p) => p.id).join(', ') || '(none)'}`;
      return readSource(f.html, args.start, args.end);
    }
    case 'screenshot': {
      const id = sanitizeId(args.id);
      const isPane = ui.panes.has(id);
      if (!getFrame(id) || !(isPane || ui.inline.has(id))) return `Error: no widget or pane with id "${id}".`;
      if (!isPane) ui.inline.expand(id); // "as the user sees it": a collapsed widget is shown first
      if (isPane) {
        ui.panes.focus(id); // a pane behind another tab has no layout to draw
        // Let it lay out. Background browser tabs never run animation frames, hence the timer.
        await Promise.race([
          new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
          new Promise((r) => setTimeout(r, 100)),
        ]);
      }
      const shot = await captureFrame(id, { viewport: isPane });
      if (!shot.ok) return `Error: screenshot failed: ${shot.error}`;
      let img;
      try {
        img = await compressImage(shot.dataUrl, { mime: ui.imageMime(), quality: IMAGE_QUALITY });
      } catch (e) {
        return `Error: screenshot failed: ${e.message}`;
      }
      const ext = img.mime === 'image/webp' ? 'webp' : 'jpg';
      const caveat = shot.hasCanvas ? ' WebGL canvases may be blank unless created with preserveDrawingBuffer: true.' : '';
      return {
        text: `Screenshot of "${id}" (${img.width}×${img.height}).${caveat}`,
        images: [{
          dataUrl: img.dataUrl,
          meta: { kind: 'screenshot', name: `${id}.${ext}`, pageId: id, bytes: img.bytes, mime: img.mime, width: img.width, height: img.height },
        }],
      };
    }
    default:
      return `Error: unknown tool "${name}".`;
  }
}

/**
 * Numbered source for read: says where it is in the file, and if it must stop early (to keep a
 * single result from flooding the context) it stops at a line boundary and says where to resume.
 */
function readSource(html, start, end) {
  const total = html.split('\n').length;
  const from = Math.max(1, Math.floor(start) || 1);
  if (from > total) return `(the page has only ${total} lines)`;
  const to = Math.min(total, Math.floor(end) || total);
  const lines = numberLines(html, from, to).split('\n');
  const kept = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > MAX_READ_CHARS && kept.length) break;
    kept.push(line);
    size += line.length + 1;
  }
  const shownTo = from + kept.length - 1;
  const header = `Lines ${from}-${shownTo} of ${total}`;
  const more = shownTo < to ? `\n… stopped at line ${shownTo} to limit size; continue with start=${shownTo + 1}` : '';
  return `${header}\n${kept.join('\n')}${more}`;
}

function truncate(s) {
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}\n… (truncated)` : s;
}

export function sanitizeId(id) {
  return String(id ?? '').trim().replace(/[^\w.-]+/g, '-').slice(0, 64);
}
