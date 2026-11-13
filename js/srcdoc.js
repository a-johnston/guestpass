// Builds the srcdoc for sandboxed frames. A small bootstrap script is injected before any
// model-authored code. It:
//   - reports console output, errors, load, and size changes to the parent via postMessage
//   - exposes `window.kv`, a key/value store shared by every frame (seeded from `kv` here)
//   - calls `window.onPatch(data)` when the parent sends a patch, returning its result
// Pure string work, so it is unit tested under Node.

export const BOOTSTRAP_MARKER = 'data-guestpass-bootstrap';

const bootstrap = (kvJson) => `<script ${BOOTSTRAP_MARKER}>(function () {
  function send(m) { m.__guestpass = 1; try { parent.postMessage(m, '*'); } catch (e) {} }
  function fmt(a) {
    try {
      if (a instanceof Error || (a && typeof a === 'object' && typeof a.message === 'string' && a.name)) {
        /* Chrome's stack starts with "Name: message"; Firefox's is frames only, so add it. */
        var head = a.name + ': ' + a.message;
        var st = a.stack || '';
        return st.indexOf(head) === 0 ? st : head + (st ? ' ' + st : '');
      }
      if (a && typeof a === 'object') return JSON.stringify(a);
      return String(a);
    } catch (e) { return String(a); }
  }
  function clone(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }

  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      send({ type: 'console', level: level, text: Array.prototype.map.call(arguments, fmt).join(' ') });
      return orig.apply(console, arguments);
    };
  });
  addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== window && (t.src || t.href)) {
      send({ type: 'console', level: 'error', text: 'Failed to load resource: ' + (t.src || t.href) });
    } else {
      var where = e.filename ? ' (line ' + e.lineno + ':' + e.colno + ')' : '';
      send({ type: 'console', level: 'error', text: 'Uncaught ' + (e.error ? fmt(e.error) : e.message) + where });
    }
  }, true);
  addEventListener('unhandledrejection', function (e) {
    send({ type: 'console', level: 'error', text: 'Unhandled promise rejection: ' + fmt(e.reason) });
  });
  addEventListener('load', function () { send({ type: 'ready' }); });

  var lastH = 0;
  function reportSize() {
    /* The <html> box height tracks content (scrollHeight never drops below the viewport, so
       widgets could grow but never shrink). */
    var h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (Math.abs(h - lastH) > 1) { lastH = h; send({ type: 'resize', height: h }); }
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(reportSize).observe(document.documentElement);
  addEventListener('load', reportSize);

  /* Shared store. Values must be JSON-serializable. Subscribers fire on every change,
     including this page's own, with (key, value); value is undefined when deleted. */
  var data = ${kvJson};
  var subs = [];
  function notify(key, value) {
    subs.slice().forEach(function (fn) { try { fn(key, value); } catch (e) { console.error(e); } });
  }
  function apply(key, value, deleted) {
    if (deleted) delete data[key]; else data[key] = value;
    notify(key, deleted ? undefined : clone(value));
  }
  window.kv = {
    get: function (key) { return key in data ? clone(data[key]) : undefined; },
    set: function (key, value) {
      if (value === undefined) return window.kv.delete(key);
      value = clone(value);
      apply(key, value, false);
      send({ type: 'kv-set', key: String(key), value: value });
    },
    delete: function (key) {
      apply(key, undefined, true);
      send({ type: 'kv-set', key: String(key), deleted: true });
    },
    all: function () { return clone(data); },
    subscribe: function (fn) {
      subs.push(fn);
      return function () { subs = subs.filter(function (f) { return f !== fn; }); };
    }
  };

  addEventListener('message', function (e) {
    var m = e.data;
    if (e.source !== parent || !m || m.__guestpass !== 1) return;
    if (m.type === 'kv') { apply(m.key, m.value, m.deleted); return; }
    if (m.type === 'patch') {
      var reply = function (ok, value) { send({ type: 'patch-result', reqId: m.reqId, ok: ok, value: value }); };
      if (typeof window.onPatch !== 'function') return reply(false, 'window.onPatch is not defined in this page');
      try {
        Promise.resolve(window.onPatch(m.data)).then(
          function (v) { try { reply(true, clone(v)); } catch (err) { reply(true, String(v)); } },
          function (err) { reply(false, fmt(err)); });
      } catch (err) { reply(false, fmt(err)); }
    }
  });
})();</script>`;

const FRAGMENT_STYLE = `<style>:root{color-scheme:light dark;font-family:system-ui,-apple-system,sans-serif}body{margin:12px}</style>`;

/** Serializes the kv snapshot so it can't break out of the inline <script>. */
export function kvLiteral(kv) {
  return JSON.stringify(kv ?? {})
    .replace(/</g, '\\u003c')
    .replaceAll(String.fromCharCode(0x2028), "\\u2028") // built at runtime: a raw U+2028/2029 in source is a line terminator
    .replaceAll(String.fromCharCode(0x2029), "\\u2029");
}

export function buildSrcdoc(html, { kv } = {}) {
  // One line, so line numbers in error messages match the page source as written (and as `read` numbers it).
  const BOOTSTRAP = bootstrap(kvLiteral(kv)).replace(/\n\s*/g, " ");
  const src = String(html ?? '');
  const head = /<head(\s[^>]*)?>/i.exec(src);
  if (head) return insertAt(src, head.index + head[0].length, BOOTSTRAP);
  const htmlTag = /<html(\s[^>]*)?>/i.exec(src);
  if (htmlTag) return insertAt(src, htmlTag.index + htmlTag[0].length, `<head>${BOOTSTRAP}</head>`);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(src);
  const body = doctype ? src.slice(doctype[0].length) : src;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${BOOTSTRAP}${FRAGMENT_STYLE}</head><body>${body}</body></html>`;
}

function insertAt(s, i, text) {
  return s.slice(0, i) + text + s.slice(i);
}
