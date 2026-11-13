// Tools the model can call. They run entirely in this page: HTML is rendered into sandboxed
// iframes, either inline in the chat or in a side pane. Widgets and panes share one id
// namespace; rendering an id that already exists replaces it.
//
// Wording notes: facts about the page environment (sandbox, kv, onPatch) live once in
// TOOL_SYSTEM_HINT rather than in each html parameter; tool descriptions state contracts
// (what is returned, scope, failure modes) rather than lists of use cases.
import { getFrame, settle, formatLogs, patchFrame, updateKv } from './frames.js';

const idParam = { type: 'string', description: 'Id of the widget or pane.' };

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'render_inline',
      description:
        'Render HTML as a widget inside the chat. Returns its id and the console output after load. ' +
        'Rendering an existing id replaces that widget; this is how to fix a broken one.',
      parameters: {
        type: 'object',
        properties: {
          html: { type: 'string', description: 'A fragment or a full document.' },
          id: { type: 'string', description: 'Optional stable id; reuse it to replace the widget.' },
          title: { type: 'string', description: 'Caption shown above the widget.' },
          height: { type: 'integer', description: 'Max height in px (default 480); shorter content shrinks to fit.' },
        },
        required: ['html'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_pane',
      description:
        'Open a full page in a pane beside the chat, for apps, games and larger views. ' +
        'Opening an existing id reloads that pane. Returns the console output after load.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable id; reuse it to reload the pane.' },
          title: { type: 'string', description: 'Optional tab title (defaults to the id).' },
          html: { type: 'string', description: 'A fragment or a full document.' },
        },
        required: ['id', 'html'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'patch',
      description:
        'Send JSON to one page\'s window.onPatch without reloading it. Returns the handler\'s return value plus any console output it produced. ' +
        'Fails if the page defines no window.onPatch; nothing is installed by default. ' +
        'Use patch to drive or query one page; use kv for state that several pages react to.',
      parameters: {
        type: 'object',
        properties: {
          id: idParam,
          data: { description: 'Any JSON value; passed to window.onPatch.' },
        },
        required: ['id', 'data'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kv',
      description:
        'Read the shared key/value store, optionally setting keys first. Writes reach every open page through kv.subscribe. Returns the whole store.',
      parameters: {
        type: 'object',
        properties: {
          set: { type: 'object', description: 'Keys to set; null deletes a key. Omit to only read.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'close',
      description: 'Close a pane or remove a widget. It stops receiving kv updates; the store itself is unchanged.',
      parameters: { type: 'object', properties: { id: idParam }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_console',
      description:
        'Console output and errors from a page since it was last rendered, e.g. after the user interacted with it. ' +
        'Shows console traffic only; to observe a page\'s state changes, have it log them.',
      parameters: { type: 'object', properties: { id: idParam }, required: ['id'] },
    },
  },
];

export const TOOL_SYSTEM_HINT = `You are in a browser chat client that can render web pages: render_inline puts a widget in the chat, open_pane opens a larger page beside it. When a visual or interactive result would help, use them instead of only printing code, and check the console output they return.

Page environment (every widget and pane):
- Sandboxed iframe: no cookies or localStorage, no access to the chat page. Scripts and styles may load from CDNs (e.g. https://cdn.jsdelivr.net).
- kv: a key/value store shared live by all open pages and the kv tool. kv.get(k), kv.set(k, v), kv.delete(k), kv.all(). kv.subscribe((k, v) => …) fires on every change, including writes from other pages and the kv tool; v is undefined on delete. Values must be JSON-serializable. New pages start with the current contents. This is how pages talk to each other.
- window.onPatch: a page that defines window.onPatch = (data) => result can be updated in place with the patch tool. Pages that don't define it reject patches.
- Widgets and panes share one id namespace.`;

const MAX_RESULT_CHARS = 8000;
let autoId = 0;

/**
 * Executes a tool call. `ui` supplies the DOM side:
 *   ui.mountInline({id, title, html, height}) — adds a widget card to the current reply, replacing any widget with that id
 *   ui.inline — {has(id), remove(id)} for inline widgets
 *   ui.panes — the pane manager (open/close/has/ids)
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
    case 'render_inline': {
      if (typeof args.html !== 'string' || !args.html.trim()) return 'Error: "html" is required.';
      const id = sanitizeId(args.id) || `widget-${++autoId}`;
      const replaced = ui.inline.has(id) || ui.panes.has(id);
      if (ui.panes.has(id)) ui.panes.close(id);
      ui.mountInline({ id, title: args.title, html: args.html, height: args.height });
      await settle(id);
      return `${replaced ? 'Replaced' : 'Rendered'} widget "${id}".\nConsole:\n${consoleOf(id)}`;
    }
    case 'open_pane': {
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
