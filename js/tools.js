// Tools the model can call. They run entirely in this page: HTML is rendered into sandboxed
// iframes, either inline in the chat or in a side pane.
import { getFrame, settle, formatLogs } from './frames.js';

const htmlParam = {
  type: 'string',
  description:
    'HTML to render. Either a fragment or a complete document. May contain <style> and <script> (inline or from CDNs such as https://cdn.jsdelivr.net). Runs in a sandboxed iframe: no localStorage/cookies, no access to the parent page.',
};

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'render_inline',
      description:
        'Render an interactive HTML/CSS/JS widget directly in the chat, as part of your reply. Good for small demos, charts, SVG drawings, diagrams, and UI snippets. Returns the widget id and any console output or errors after it loads.',
      parameters: {
        type: 'object',
        properties: {
          html: htmlParam,
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
        'Open a side pane next to the chat that shows a full web page or app (games, tools, larger visualizations, documents). Calling it again with the same id replaces that pane\'s content, which is how you apply fixes or updates. Returns any console output or errors after load.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable identifier, e.g. "snake-game". Reuse it to update the pane.' },
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
      name: 'close_pane',
      description: 'Close a side pane by id.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_console',
      description:
        'Read console output and errors from a widget or pane (by id) since it was last rendered, e.g. after the user has interacted with it.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
];

export const TOOL_SYSTEM_HINT =
  'You are running in a browser chat client that can render web content. When a visual, interactive demo, diagram, or small app would help, ' +
  'use render_inline (small, in the chat) or open_pane (larger, beside the chat) instead of only printing code. ' +
  'Check the returned console output and fix errors by re-rendering.';

let inlineCounter = 0;

/**
 * Executes a tool call. `ui` supplies the DOM side:
 *   ui.mountInline({id, title, html, height}) — adds a widget card to the current reply
 *   ui.panes — the pane manager (open/close/has)
 * Returns the string sent back to the model as the tool result.
 */
export async function runTool(name, rawArgs, ui) {
  let args;
  try {
    args = typeof rawArgs === 'string' ? (rawArgs.trim() ? JSON.parse(rawArgs) : {}) : rawArgs || {};
  } catch (e) {
    return `Error: arguments were not valid JSON (${e.message}). Call the tool again with valid JSON arguments.`;
  }

  switch (name) {
    case 'render_inline': {
      if (typeof args.html !== 'string' || !args.html.trim()) return 'Error: "html" is required.';
      const id = `inline-${++inlineCounter}`;
      ui.mountInline({ id, title: args.title, html: args.html, height: args.height });
      await settle(id);
      return `Rendered widget "${id}".\nConsole:\n${formatLogs(getFrame(id)?.logs || [])}`;
    }
    case 'open_pane': {
      if (typeof args.html !== 'string' || !args.html.trim()) return 'Error: "html" is required.';
      const id = sanitizeId(args.id) || `pane-${++inlineCounter}`;
      const replaced = ui.panes.has(id);
      ui.panes.open(id, args.title || id, args.html);
      await settle(id);
      return `${replaced ? 'Updated' : 'Opened'} pane "${id}".\nConsole:\n${formatLogs(getFrame(id)?.logs || [])}`;
    }
    case 'close_pane': {
      const id = sanitizeId(args.id);
      if (!ui.panes.has(id)) return `No pane with id "${id}". Open panes: ${ui.panes.ids().join(', ') || '(none)'}`;
      ui.panes.close(id);
      return `Closed pane "${id}".`;
    }
    case 'read_console': {
      const f = getFrame(sanitizeId(args.id));
      if (!f) return `No widget or pane with id "${args.id}".`;
      return formatLogs(f.logs);
    }
    default:
      return `Error: unknown tool "${name}".`;
  }
}

function sanitizeId(id) {
  return String(id ?? '').trim().replace(/[^\w.-]+/g, '-').slice(0, 64);
}
