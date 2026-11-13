// Markdown → sanitized HTML for assistant messages.
import { marked } from '../vendor/marked.esm.js';
import DOMPurify from '../vendor/purify.es.mjs';
import hljs from '../vendor/highlight.min.js';

marked.setOptions({ gfm: true, breaks: false });
hljs.configure({ ignoreUnescapedHTML: true });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const RUNNABLE = new Set(['html', 'svg', 'xml']);

/**
 * Renders markdown into `el`.
 *  - final: true once the message is complete. Only then are code blocks syntax-highlighted
 *    (re-highlighting on every streamed token would be wasted work) and decorated.
 *  - decorate(preEl, codeText, {lang, runnable}): called for every code block so the caller
 *    can add a header (language, Copy; Run for ```html / ```svg).
 * Blocks without a language label, or with one highlight.js doesn't know, stay plain:
 * auto-detection guesses wrong often enough to be worse than no colour.
 */
export function renderMarkdown(el, text, { final = false, decorate } = {}) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text || ''), { FORBID_TAGS: ['style'], FORBID_ATTR: ['style'] });
  if (!final) return;
  for (const code of el.querySelectorAll('pre > code')) {
    const lang = (/language-(\S+)/.exec(code.className) || [])[1]?.toLowerCase();
    const source = code.textContent;
    if (lang && hljs.getLanguage(lang)) hljs.highlightElement(code);
    decorate?.(code.parentElement, source, { lang: lang || '', runnable: RUNNABLE.has(lang) });
  }
}
