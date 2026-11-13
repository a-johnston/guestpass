// Message content: plain strings, or OpenAI content-part arrays when a message carries images or
// files. Parts may carry a local-only `meta` ({kind, name, bytes, mime, pageId?, width?, height?,
// text?}) used for display, pruning and accounting; prepareHistory strips it before sending.
// Pure, so it is unit tested under Node.
import { imageTokens } from './media.js';

const isMedia = (p) => p?.type === 'image_url' || p?.type === 'file';
const textPart = (text) => ({ type: 'text', text });
const asParts = (c) => (typeof c === 'string' ? (c ? [textPart(c)] : []) : Array.isArray(c) ? c : []);

/** A code fence longer than any backtick run inside `text`, so the content can't close it early. */
export function fence(text, lang = '') {
  const longest = Math.max(2, ...(String(text).match(/`+/g) || []).map((s) => s.length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${String(text).replace(/\n$/, '')}\n${ticks}`;
}

/** Joins two message contents: strings stay a string; anything with parts becomes a part array. */
export function mergeContent(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return [a, b].filter(Boolean).join('\n\n');
  return [...asParts(a), ...asParts(b)];
}

/** A user message's content: the text alone, or text plus attachment parts. */
export function userContent(text, parts = []) {
  if (!parts.length) return text;
  return [...(text ? [textPart(text)] : []), ...parts];
}

/** "image: cat.jpg", "file: spec.pdf", or 'screenshot of "app"'. */
export function mediaLabel(part) {
  const m = part.meta || {};
  if (m.kind === 'screenshot') return `screenshot of "${m.pageId}"`;
  const name = m.name || (part.type === 'file' ? part.file?.filename : '') || 'unnamed';
  return `${part.type === 'file' ? 'file' : 'image'}: ${name}`;
}

/** The text of a content; with `placeholders`, media parts appear in place as "[image: name]" etc. */
export function contentText(content, { placeholders = false } = {}) {
  if (typeof content === 'string') return content;
  return asParts(content)
    .map((p) => (p.type === 'text' ? p.text : placeholders && isMedia(p) ? `[${mediaLabel(p)}]` : null))
    .filter((t) => t != null && t !== '')
    .join('\n\n');
}

/**
 * The history as it should be sent this request. Never mutates `messages`.
 *   clearedBefore: messages before this index have their media replaced by placeholders
 *   vision: false replaces images (null = unknown, sent anyway)
 *   documents: false inlines text files as fenced blocks and drops other files
 *   toolImages: false moves images out of tool results into a user message after them
 */
export function prepareHistory(messages, { vision = null, documents = true, toolImages = true, clearedBefore = 0 } = {}) {
  const lastShot = new Map(); // pageId -> the screenshot part that is still sent
  messages.forEach((m, i) => {
    if (i < clearedBefore || !Array.isArray(m.content)) return;
    for (const p of m.content) if (p.meta?.kind === 'screenshot') lastShot.set(p.meta.pageId, p);
  });

  const shaped = messages.map((m, i) => {
    if (!Array.isArray(m.content)) return { ...m };
    const content = m.content.map((p) => {
      if (!isMedia(p)) return p;
      if (i < clearedBefore) return textPart(`[${mediaLabel(p)} — cleared from history]`);
      if (p.meta?.kind === 'screenshot' && lastShot.get(p.meta.pageId) !== p) {
        return textPart(`[earlier screenshot of "${p.meta.pageId}" omitted; a newer one follows]`);
      }
      if (p.type === 'image_url' && vision === false) return textPart(`[${mediaLabel(p)} — not sent, this model can't see images]`);
      if (p.type === 'file' && documents === false) {
        return typeof p.meta?.text === 'string'
          ? textPart(`${p.meta.name}:\n${fence(p.meta.text)}`)
          : textPart(`[${mediaLabel(p)} — not sent, this server can't read it]`);
      }
      return p;
    });
    return { ...m, content };
  });

  const out = toolImages === false ? moveToolImages(shaped) : shaped;
  return out.map(finalize);
}

/** Servers that reject images in tool results get them in a user message right after the results. */
function moveToolImages(messages) {
  const out = [];
  let moved = [];
  const flush = (next) => {
    if (!moved.length) return next;
    const carrier = [textPart('Images returned by the tool calls above:'), ...moved];
    moved = [];
    if (next?.role === 'user') return { ...next, content: mergeContent(carrier, next.content) };
    out.push({ role: 'user', content: carrier });
    return next;
  };
  for (const m of messages) {
    if (m.role === 'tool' && Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')) {
      moved.push(...m.content.filter((p) => p.type === 'image_url'));
      const text = contentText(m.content.filter((p) => p.type !== 'image_url'));
      out.push({ ...m, content: `${text}\n(Image attached in the next message.)` });
      continue;
    }
    const next = m.role === 'tool' ? m : flush(m); // keep a run of tool results together
    out.push(next);
  }
  flush(null);
  return out;
}

/**
 * What "Clear media" would stop re-sending: images and files still sent (not before the
 * watermark, not an older screenshot of the same page) and page HTML not already stubbed.
 * bytes are wire size; tokens are estimates (images by basalt's 32 px tiles, text by chars).
 */
export function clearableSummary(messages, { clearedBefore = 0, renderTools, charsPerToken = 4 }) {
  const lastShot = new Map();
  messages.forEach((m, i) => {
    if (i < clearedBefore || !Array.isArray(m.content)) return;
    for (const p of m.content) if (p.meta?.kind === 'screenshot') lastShot.set(p.meta.pageId, p);
  });
  let bytes = 0;
  let tokens = 0;
  let items = 0;
  messages.forEach((m, i) => {
    if (i < clearedBefore) return;
    for (const p of Array.isArray(m.content) ? m.content : []) {
      if (!isMedia(p) || (p.meta?.kind === 'screenshot' && lastShot.get(p.meta.pageId) !== p)) continue;
      items++;
      bytes += p.meta?.bytes ?? 0;
      if (p.type === 'image_url' && p.meta?.width) tokens += imageTokens(p.meta.width, p.meta.height);
      if (p.type === 'file' && typeof p.meta?.text === 'string') tokens += Math.round(p.meta.text.length / charsPerToken);
    }
    for (const c of m.tool_calls || []) {
      if (c.superseded || !renderTools.has(c.function?.name)) continue;
      let html;
      try { html = JSON.parse(c.function.arguments).html; } catch { continue; }
      if (typeof html !== 'string' || !html) continue;
      items++;
      bytes += html.length;
      tokens += Math.round(html.length / charsPerToken);
    }
  });
  return { bytes, tokens, items };
}

/** Drops local meta; a part array that is only text again becomes a plain string. */
function finalize(m) {
  if (!Array.isArray(m.content)) return m;
  const parts = m.content.map(({ meta, ...p }) => p);
  return { ...m, content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n\n') : parts };
}
