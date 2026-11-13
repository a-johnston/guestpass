// Tools the model can call. They run entirely in this page: HTML is rendered into sandboxed
// iframes, either inline in the chat or in a side pane. Widgets and panes ("pages") share one
// id namespace; rendering an id that already exists replaces it.
//
// The definitions and TOOL_SYSTEM_HINT are sent with every request and there is no compaction,
// so they are deliberately terse (~840 tokens on a Qwen template, of which ~540 is the template's
// fixed tool wrapper). Facts shared by all pages live once in the hint; descriptions state only
// what a model can't infer. Measure before growing them.
import { getFrame, settle, formatLogs, patchFrame, updateKv } from './frames.js';
import { applyEdit, numberLines } from './source.js';

const idParam = { type: 'string', description: 'Page id' };
const htmlParam = { type: 'string', description: 'Fragment or full document' };
const fn = (name, description, properties, required) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, ...(required ? { required } : {}) } },
});

export const TOOL_DEFS = [
  fn('inline', 'Render an HTML widget in the chat.', {
    html: htmlParam,
    id: { type: 'string', description: 'optional' },
    title: { type: 'string' },
    height: { type: 'integer', description: 'Max px (default 480)' },
  }, ['html']),
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
  fn('edit', "Replace text in a page's source and reload it. old must match exactly once.", {
    id: idParam,
    old: { type: 'string' },
    new: { type: 'string' },
  }, ['id', 'old', 'new']),
  fn('read', "A page's current source with line numbers.", {
    id: idParam,
    start: { type: 'integer' },
    end: { type: 'integer' },
  }, ['id']),
  fn('close', 'Close a page.', { id: idParam }, ['id']),
  fn('read_console', "A page's logged console output since it rendered.", { id: idParam }, ['id']),
];

export const TOOL_SYSTEM_HINT = 'Your tools can render web pages here: use them when a visual or interactive result helps. ' +
  'Pages are sandboxed iframes: no storage or access to the chat; CDN scripts work. ' +
  "fetch() only reaches CORS-enabled servers: if blocked, don't retry. " +
  'In pages: kv is a store shared live by all pages and the kv tool (get, set, delete, all; subscribe((k, v) => …) fires on every change). ' +
  'Defining window.onPatch = (data) => result lets the patch tool update a page in place. ' +
  'Inline and pane pages share one id namespace: reusing an id replaces the existing one. ' +
  'Each page is a single-file app: build large ones incrementally, starting small and then using edit. ' +
  'inline, pane, edit, and patch return console output.';

/** Tools that render a page (and so can supersede an earlier render of the same id). */
export const RENDER_TOOLS = new Set(['inline', 'pane']);

const MAX_RESULT_CHARS = 8000;
let autoId = 0;

/**
 * Executes a tool call. `ui` supplies the DOM side:
 *   ui.mountInline({id, title, html, height}) — adds a widget card to the current reply, replacing any widget with that id
 *   ui.inline — {has(id), remove(id)} for inline widgets
 *   ui.panes — the pane manager (open/close/has/ids)
 *   ui.canRerender(id) / ui.rerender(id, html) — reload a widget or pane in place with new source (edit)
 * Returns the string sent back to the model as the tool result.
 */
export async function runTool(name, rawArgs, ui) {
  let args;
  try {
    args = typeof rawArgs === 'string' ? (rawArgs.trim() ? JSON.parse(rawArgs) : {}) : rawArgs || {};
  } catch (e) {
    return `Error: arguments were not valid JSON (${e.message}). Call the tool again with valid JSON arguments.`;
  }
  const consoleOf = (id, since = 0) => formatLogs(getFrame(id)?.logs || [], { onlySince: since });

  switch (name) {
    case 'inline': {
      if (typeof args.html !== 'string' || !args.html.trim()) return 'Error: "html" is required.';
      const id = sanitizeId(args.id) || `widget-${++autoId}`;
      const replaced = ui.inline.has(id) || ui.panes.has(id);
      if (ui.panes.has(id)) ui.panes.close(id);
      ui.mountInline({ id, title: args.title, html: args.html, height: args.height });
      await settle(id);
      return `${replaced ? 'Replaced' : 'Rendered'} widget "${id}".\nConsole:\n${consoleOf(id)}`;
    }
    case 'pane': {
      if (typeof args.html !== 'string' || !args.html.trim()) return 'Error: "html" is required.';
      const id = sanitizeId(args.id) || `pane-${++autoId}`;
      const replaced = ui.panes.has(id) || ui.inline.has(id);
      if (ui.inline.has(id)) ui.inline.remove(id);
      ui.panes.open(id, args.title || id, args.html);
      await settle(id);
      return `${replaced ? 'Reloaded' : 'Opened'} pane "${id}".\nConsole:\n${consoleOf(id)}`;
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
      const f = getFrame(sanitizeId(args.id));
      if (!f) return `No widget or pane with id "${args.id}".`;
      return truncate(formatLogs(f.logs));
    }
    case 'edit': {
      const id = sanitizeId(args.id);
      const f = getFrame(id);
      if (!f || !ui.canRerender(id)) return `Error: no widget or pane with id "${id}".`;
      if (typeof args.old !== 'string' || typeof args.new !== 'string') return 'Error: "old" and "new" must be strings.';
      const r = applyEdit(f.html, args.old, args.new);
      if (r.error) return `Error: ${r.error}.`;
      ui.rerender(id, r.source);
      await settle(id);
      const where = r.startLine === r.endLine ? `line ${r.startLine}` : `lines ${r.startLine}-${r.endLine}`;
      return `Edited "${id}" (${where}); reloaded.\nConsole:\n${consoleOf(id)}`;
    }
    case 'read': {
      const id = sanitizeId(args.id);
      const f = getFrame(id);
      if (!f) return `Error: no widget or pane with id "${id}".`;
      const out = numberLines(f.html, args.start, args.end);
      return out.length > MAX_RESULT_CHARS
        ? `${out.slice(0, MAX_RESULT_CHARS)}\n… (truncated; read a smaller range with start/end)`
        : out;
    }
    default:
      return `Error: unknown tool "${name}".`;
  }
}

function truncate(s) {
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}\n… (truncated)` : s;
}

export function sanitizeId(id) {
  return String(id ?? '').trim().replace(/[^\w.-]+/g, '-').slice(0, 64);
}
