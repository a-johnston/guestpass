// Tools the model can call. They run entirely in this page: HTML is rendered into sandboxed
// iframes, either inline in the chat or in a side pane. Widgets and panes share one id
// namespace; rendering an id that already exists replaces it.
import { getFrame, settle, formatLogs, patchFrame, updateKv } from './frames.js';

const htmlParam = {
  type: 'string',
  description:
    'HTML to render: a fragment or a complete document, with <style>/<script> inline or loaded from CDNs (e.g. https://cdn.jsdelivr.net). ' +
    'Runs in a sandboxed iframe with no cookies/localStorage and no access to the chat page. Available globals: ' +
    '`kv` — a key/value store shared live by every widget and pane (kv.get(k), kv.set(k, v), kv.delete(k), kv.all(), kv.subscribe((k, v) => …) which fires on every change; values must be JSON-serializable); ' +
    'and if the page defines `window.onPatch = (data) => result`, the patch tool can update it without a reload.',
};

const idParam = (what) => ({ type: 'string', description: `Id of the ${what}.` });

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'render_inline',
      description:
        'Render an interactive HTML/CSS/JS widget directly in the chat, as part of your reply. Good for small demos, charts, SVG drawings, diagrams, and UI snippets. ' +
        'Pass an id to be able to replace it later: rendering the same id again removes the earlier widget (use this when fixing a broken widget). ' +
        'Returns the widget id and any console output or errors after it loads.',
      parameters: {
        type: 'object',
        properties: {
          html: htmlParam,
          id: { type: 'string', description: 'Optional stable id, e.g. "sine-chart". Reuse it to replace the widget.' },
          title: { type: 'string', description: 'Short caption shown above the widget.' },
          height: { type: 'integer', description: 'Max height in pixels (default 480). The widget shrinks to fit shorter content.' },
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
        'Open a side pane next to the chat showing a full web page or app (games, tools, larger visualizations, documents). ' +
        'Calling it again with the same id reloads that pane with new content. For small live changes, prefer patch. ' +
        'Returns any console output or errors after load.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable id, e.g. "snake-game".' },
          title: { type: 'string', description: 'Tab title.' },
          html: htmlParam,
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
        'Send a JSON payload to a running widget or pane without reloading it. The page receives it through its `window.onPatch = (data) => …` handler; ' +
        'the handler\'s return value (or resolved promise value) is returned to you, along with any console output it produced.',
      parameters: {
        type: 'object',
        properties: {
          id: idParam('widget or pane'),
          data: { description: 'Any JSON value passed to window.onPatch.' },
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
        'Read the key/value store shared by all widgets and panes (the `kv` global inside them), optionally changing it first. ' +
        'Changes are pushed live to every open widget and pane, firing their kv.subscribe callbacks. Returns the whole store.',
      parameters: {
        type: 'object',
        properties: {
          set: { type: 'object', description: 'Keys to set; a null value deletes the key. Omit to just read.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'close',
      description: 'Close a side pane or remove an inline widget, by id.',
      parameters: { type: 'object', properties: { id: idParam('widget or pane') }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_console',
      description: 'Read console output and errors from a widget or pane since it was last rendered, e.g. after the user has interacted with it.',
      parameters: { type: 'object', properties: { id: idParam('widget or pane') }, required: ['id'] },
    },
  },
];

export const TOOL_SYSTEM_HINT =
  'You are running in a browser chat client that can render web content. When a visual, interactive demo, diagram, or small app would help, ' +
  'use render_inline (small, in the chat) or open_pane (larger, beside the chat) instead of only printing code. ' +
  'Check the returned console output and fix errors by re-rendering with the same id. ' +
  'Widgets and panes can talk to each other through the shared `kv` store, and you can update a running page with patch.';

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

function sanitizeId(id) {
  return String(id ?? '').trim().replace(/[^\w.-]+/g, '-').slice(0, 64);
}
