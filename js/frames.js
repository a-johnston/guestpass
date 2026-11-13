// Registry of sandboxed iframes that render model-authored HTML, plus the key/value store
// they share.
//
// Frames get `sandbox="allow-scripts ..."` WITHOUT allow-same-origin, so their origin is
// opaque: they cannot read this page's DOM, JS state (incl. the API key), or storage. The
// only channel between frames is this page relaying postMessage traffic (kv, patches).
import { buildSrcdoc } from './srcdoc.js';

// allow-pointer-lock: games want mouse-look; it needs a user gesture and Esc always releases it.
const SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock';
const MAX_LOGS = 200;
const MAX_LOG_CHARS = 2000;
const PATCH_TIMEOUT_MS = 5000;

/** Shared store, owned by the parent page; every frame gets a snapshot at creation + live updates. */
const kvStore = {};

/** @type {Map<string, {id:string, iframe:HTMLIFrameElement, html:string, logs:{level:string,text:string}[], ready:boolean, waiters:Function[], onResize?:Function}>} */
const frames = new Map();
const pendingPatches = new Map();
let patchSeq = 0;

window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.__guestpass !== 1) return;
  for (const f of frames.values()) {
    if (f.iframe.contentWindow !== e.source) continue;
    switch (m.type) {
      case 'console':
        f.logs.push({ level: String(m.level), text: String(m.text).slice(0, MAX_LOG_CHARS) });
        if (f.logs.length > MAX_LOGS) f.logs.splice(0, f.logs.length - MAX_LOGS);
        break;
      case 'ready':
        f.ready = true;
        f.waiters.splice(0).forEach((w) => w());
        break;
      case 'resize':
        if (typeof m.height === 'number') f.onResize?.(m.height);
        break;
      case 'kv-set':
        applyKv(String(m.key), m.value, !!m.deleted, e.source);
        break;
      case 'patch-result': {
        const p = pendingPatches.get(m.reqId);
        if (p) { pendingPatches.delete(m.reqId); p(m); }
        break;
      }
    }
    return;
  }
});

function post(f, msg) {
  try { f.iframe.contentWindow?.postMessage({ ...msg, __guestpass: 1 }, '*'); } catch {}
}

/** Updates the store and relays the change to every frame except `origin` (which applied it already). */
function applyKv(key, value, deleted, origin = null) {
  if (deleted) delete kvStore[key];
  else kvStore[key] = value;
  for (const f of frames.values()) {
    if (f.iframe.contentWindow !== origin) post(f, { type: 'kv', key, value, deleted });
  }
}

/** Merges `changes` into the store (null/undefined deletes a key) and returns a copy of it. */
export function updateKv(changes = {}) {
  for (const [k, v] of Object.entries(changes)) applyKv(k, v ?? null, v == null);
  return readKv();
}

export function readKv() {
  return structuredClone(kvStore);
}

/** Creates (or replaces) the frame for `id`. The caller attaches the iframe to the DOM. */
export function createFrame(id, html, { onResize, title } = {}) {
  removeFrame(id);
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', SANDBOX);
  iframe.setAttribute('allow', 'fullscreen; clipboard-write');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.title = title || id;
  iframe.srcdoc = buildSrcdoc(html, { kv: kvStore });
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

/** Sends `data` to the frame's window.onPatch and resolves to {ok, value} (value = return or error). */
export async function patchFrame(id, data) {
  const f = frames.get(id);
  if (!f) return { ok: false, value: `no widget or pane with id "${id}"` };
  if (!f.ready) await settle(id, { quiet: 0 });
  const reqId = ++patchSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingPatches.delete(reqId);
      resolve({ ok: false, value: `no reply within ${PATCH_TIMEOUT_MS / 1000}s (is onPatch stuck or awaiting forever?)` });
    }, PATCH_TIMEOUT_MS);
    pendingPatches.set(reqId, (m) => { clearTimeout(timer); resolve({ ok: !!m.ok, value: m.value }); });
    post(f, { type: 'patch', reqId, data });
  });
}

export function formatLogs(logs, { onlySince = 0 } = {}) {
  const entries = logs.slice(onlySince);
  if (!entries.length) return '(no console output)';
  return entries.map((l) => `[${l.level}] ${l.text}`).join('\n');
}
