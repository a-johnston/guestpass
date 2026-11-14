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
 * "Clear media": marks every image and file part (meta.cleared) and every page render
 * (call.cleared) in the history so far. Marks rather than an index, so a later attachment merged
 * into an already-cleared user message is still sent.
 */
export function markCleared(messages, renderTools) {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const p of m.content) if (isMedia(p)) p.meta = { ...p.meta, cleared: true };
    }
    for (const c of m.tool_calls || []) if (renderTools.has(c.function?.name)) c.cleared = true;
  }
}

/** The latest screenshot part of each page that is still sent; earlier ones are dropped. */
function latestShots(messages) {
  const last = new Map();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content) if (p.meta?.kind === 'screenshot' && !p.meta.cleared) last.set(p.meta.pageId, p);
  }
  return last;
}

/**
 * The history as it should be sent this request. Never mutates `messages`.
 *   cleared parts (markCleared) become placeholders
 *   vision: false replaces images (null = unknown, sent anyway)
 *   documents: false inlines text files as fenced blocks and drops other files
 *   toolImages: false moves images out of tool results into a user message after them
 */
export function prepareHistory(messages, { vision = null, documents = true, toolImages = true } = {}) {
  const lastShot = latestShots(messages);
  const shaped = messages.map((m) => {
    if (!Array.isArray(m.content)) return { ...m };
    const content = m.content.map((p) => {
      if (!isMedia(p)) return p;
      if (p.meta?.cleared) return textPart(`[${mediaLabel(p)} — cleared from history]`);
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
 * What "Clear media" would stop re-sending: images and files still sent (not cleared, not an
 * older screenshot of the same page) and page HTML not already stubbed.
 * bytes are wire size; tokens are estimates (images by basalt's 32 px tiles, text by chars).
 */
export function clearableSummary(messages, { renderTools, charsPerToken = 4 }) {
  const lastShot = latestShots(messages);
  let bytes = 0;
  let tokens = 0;
  let items = 0;
  messages.forEach((m) => {
    for (const p of Array.isArray(m.content) ? m.content : []) {
      if (!isMedia(p) || p.meta?.cleared || (p.meta?.kind === 'screenshot' && lastShot.get(p.meta.pageId) !== p)) continue;
      items++;
      bytes += p.meta?.bytes ?? 0;
      if (p.type === 'image_url' && p.meta?.width) tokens += imageTokens(p.meta.width, p.meta.height);
      if (p.type === 'file' && typeof p.meta?.text === 'string') tokens += Math.round(p.meta.text.length / charsPerToken);
    }
    for (const c of m.tool_calls || []) {
      if (c.superseded || c.cleared || !renderTools.has(c.function?.name)) continue;
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

/** Estimated tokens per image: images are scaled to about 1 MP (MAX_IMAGE_PIXELS), 1024 tokens on basalt. */
const IMAGE_TOKENS = 1024;

/**
 * Rough token count of prepared (sent-shape) messages: text, reasoning and tool-call arguments by
 * chars, images at their size cap, files by decoded size. For deciding on a rebase, not billing.
 */
export function estimateTokens(messages, { charsPerToken = 4 } = {}) {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    for (const p of asParts(m.content)) {
      if (p.type === 'text') chars += p.text?.length ?? 0;
      else if (p.type === 'image_url') images++;
      else if (p.type === 'file') {
        const data = String(p.file?.file_data ?? '');
        chars += (data.length - data.indexOf(',') - 1) * 3 / 4;
      }
    }
    chars += m.reasoning_content?.length ?? 0;
    for (const c of m.tool_calls || []) chars += c.function?.arguments?.length ?? 0;
  }
  return Math.round(chars / charsPerToken) + images * IMAGE_TOKENS;
}

/**
 * Whether to drop the chain and resend the trimmed history: the context (`used`, as last
 * reported) is at least 75% of `max`, and the resend (`trimmed`, estimated) frees at least 10%.
 * With `held`, an estimate of the context the server holds made the same way as `trimmed`,
 * `trimmed` is scaled by used/held first, so the estimate's bias cancels out: right after a
 * rebase held equals trimmed and it can't fire again until something new becomes trimmable.
 */
export function shouldRebase({ used, max, trimmed, held }) {
  if (!(used > 0) || !(max > 0)) return false;
  const resend = held > 0 ? trimmed * (used / held) : trimmed;
  return used >= 0.75 * max && used - resend >= 0.10 * max;
}
