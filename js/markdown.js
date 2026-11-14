// Markdown → sanitized HTML for assistant messages.
import { marked } from '../vendor/marked.esm.min.js';
import DOMPurify from '../vendor/purify.es.min.mjs';

marked.setOptions({ gfm: true, breaks: false });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const RUNNABLE = new Set(['html', 'svg', 'xml']);
const LABELLED = 'pre > code[class*="language-"]';

// highlight.js is about a quarter of the page's script, and only labelled code blocks use it,
// so it stays off the initial load. A failed fetch is forgotten so a later block can retry.
let hljsLoad = null;
function loadHljs() {
  hljsLoad ??= import('../vendor/highlight.min.js').then(({ default: hljs }) => {
    hljs.configure({ ignoreUnescapedHTML: true });
    return hljs;
  }, (e) => {
    hljsLoad = null;
    throw e;
  });
  return hljsLoad;
}

/**
 * Renders markdown into `el`.
 *  - final: true once the message is complete. Only then are code blocks syntax-highlighted
 *    (re-highlighting on every streamed token would be wasted work) and decorated. Highlighting
 *    lands once highlight.js has loaded; a streamed labelled block starts that load early.
 *  - decorate(preEl, codeText, {lang, runnable}): called for every code block so the caller
 *    can add a header (language, Copy; Run for ```html / ```svg).
 * Blocks without a language label, or with one highlight.js doesn't know, stay plain:
 * auto-detection guesses wrong often enough to be worse than no colour.
 */
export function renderMarkdown(el, text, { final = false, decorate } = {}) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text || ''), { FORBID_TAGS: ['style'], FORBID_ATTR: ['style'] });
  if (!final) {
    if (el.querySelector(LABELLED)) loadHljs().catch(() => {});
    return;
  }
  const labelled = [];
  for (const code of el.querySelectorAll('pre > code')) {
    const lang = (/language-(\S+)/.exec(code.className) || [])[1]?.toLowerCase();
    const source = code.textContent;
    if (lang) labelled.push([code, lang]);
    decorate?.(code.parentElement, source, { lang: lang || '', runnable: RUNNABLE.has(lang) });
  }
  if (!labelled.length) return;
  loadHljs().then((hljs) => {
    for (const [code, lang] of labelled) if (hljs.getLanguage(lang)) hljs.highlightElement(code);
  }, () => {}); // offline or flaky: the block stays plain, which is still correct
}
