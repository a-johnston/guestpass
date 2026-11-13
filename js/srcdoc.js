// Builds the srcdoc for sandboxed frames. A small bootstrap script is injected before any
// model-authored code so console output, errors, load, and size changes are reported to the
// parent page via postMessage. Pure string work, so it is unit tested under Node.

export const BOOTSTRAP_MARKER = 'data-chat-bridge-bootstrap';

const BOOTSTRAP = `<script ${BOOTSTRAP_MARKER}>(function () {
  function send(m) { m.__chatBridge = 1; try { parent.postMessage(m, '*'); } catch (e) {} }
  function fmt(a) {
    try {
      if (a instanceof Error) return a.stack || String(a);
      if (a && typeof a === 'object') return JSON.stringify(a);
      return String(a);
    } catch (e) { return String(a); }
  }
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
    // The <html> box height tracks content (scrollHeight never drops below the viewport, so
    // widgets could grow but never shrink).
    var h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (Math.abs(h - lastH) > 1) { lastH = h; send({ type: 'resize', height: h }); }
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(reportSize).observe(document.documentElement);
  addEventListener('load', reportSize);
})();</script>`;

const FRAGMENT_STYLE = `<style>:root{color-scheme:light dark;font-family:system-ui,-apple-system,sans-serif}body{margin:12px}</style>`;

export function buildSrcdoc(html) {
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
