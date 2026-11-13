// Markdown → sanitized HTML for assistant messages.
import { marked } from '../vendor/marked.esm.js';
import DOMPurify from '../vendor/purify.es.mjs';

marked.setOptions({ gfm: true, breaks: false });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const RUNNABLE = new Set(['html', 'svg', 'xml']);

/**
 * Renders markdown into `el`. For runnable code blocks (```html / ```svg), calls
 * decorate(preEl, codeText) so the caller can attach "run" buttons.
 */
export function renderMarkdown(el, text, decorate) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text || ''), { FORBID_TAGS: ['style'], FORBID_ATTR: ['style'] });
  if (!decorate) return;
  for (const code of el.querySelectorAll('pre > code')) {
    const lang = (/language-(\S+)/.exec(code.className) || [])[1]?.toLowerCase();
    if (RUNNABLE.has(lang)) decorate(code.parentElement, code.textContent);
  }
}
