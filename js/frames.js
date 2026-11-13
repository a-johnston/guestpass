// Registry of sandboxed iframes that render model-authored HTML.
//
// Frames get `sandbox="allow-scripts ..."` WITHOUT allow-same-origin, so their origin is
// opaque: they cannot read this page's DOM, JS state (incl. the API key), or storage.
import { buildSrcdoc } from './srcdoc.js';

const SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads';
const MAX_LOGS = 200;
const MAX_LOG_CHARS = 2000;

/** @type {Map<string, {id:string, iframe:HTMLIFrameElement, html:string, logs:{level:string,text:string}[], ready:boolean, waiters:Function[], onResize?:Function}>} */
const frames = new Map();

window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.__chatBridge !== 1) return;
  for (const f of frames.values()) {
    if (f.iframe.contentWindow !== e.source) continue;
    if (m.type === 'console') {
      f.logs.push({ level: String(m.level), text: String(m.text).slice(0, MAX_LOG_CHARS) });
      if (f.logs.length > MAX_LOGS) f.logs.splice(0, f.logs.length - MAX_LOGS);
    } else if (m.type === 'ready') {
      f.ready = true;
      f.waiters.splice(0).forEach((w) => w());
    } else if (m.type === 'resize' && typeof m.height === 'number') {
      f.onResize?.(m.height);
    }
    return;
  }
});

/** Creates (or replaces) the frame for `id`. The caller attaches the iframe to the DOM. */
export function createFrame(id, html, { onResize, title } = {}) {
  removeFrame(id);
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', SANDBOX);
  iframe.setAttribute('allow', 'fullscreen; clipboard-write');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.title = title || id;
  iframe.srcdoc = buildSrcdoc(html);
  frames.set(id, { id, iframe, html, logs: [], ready: false, waiters: [], onResize });
  return iframe;
}

export function getFrame(id) {
  return frames.get(id);
}

export function removeFrame(id) {
  const f = frames.get(id);
  if (!f) return;
  f.waiters.splice(0).forEach((w) => w());
  f.iframe.remove();
  frames.delete(id);
}

/** Waits for the frame to finish loading (or time out), then a short quiet period for async errors. */
export async function settle(id, { timeout = 5000, quiet = 700 } = {}) {
  const f = frames.get(id);
  if (!f) return;
  if (!f.ready) {
    await new Promise((resolve) => {
      f.waiters.push(resolve);
      setTimeout(resolve, timeout);
    });
  }
  await new Promise((r) => setTimeout(r, quiet));
}

export function formatLogs(logs, { onlySince = 0 } = {}) {
  const entries = logs.slice(onlySince);
  if (!entries.length) return '(no console output)';
  return entries.map((l) => `[${l.level}] ${l.text}`).join('\n');
}
