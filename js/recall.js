// Recall reads the full local history, never the compacted copy. Pure, unit tested under Node.
import { historyItems, collectNotes } from './items.js';
import { contentText } from './content.js';
import { COMPACTION } from './compaction-config.js';

// Reserve space for the header and continuation, including when ids/page numbers grow.
function paged(text, label, page) {
  if (label.length > COMPACTION.recallLabelChars) label = label.slice(0, COMPACTION.recallLabelChars - 1) + '…';
  const size = Math.max(1, COMPACTION.recallChars - label.length - 160);
  const pages = Math.max(1, Math.ceil(text.length / size));
  if (page > pages) return `Error: page ${page} is out of range (1–${pages}).`;
  return `${label}, page ${page} of ${pages}:\n${text.slice((page - 1) * size, page * size)}` +
    (page < pages ? `\n… continue with page=${page + 1}` : '');
}

export function runRecall(messages, args = {}) {
  const { id, search, page = 1 } = args || {};
  if (!Number.isSafeInteger(page) || page < 1) return 'Error: "page" must be a positive integer.';
  const items = historyItems(messages);
  if (typeof id === 'string') {
    if (id === 'notes') {
      const notes = collectNotes(items);
      return paged(notes.map((n) => `- ${n}`).join('\n') || '(no notes)', 'Notes (newest first)', page);
    }
    const range = id.match(/^index:(\d+)-(\d+)$/);
    if (range) {
      const from = Number(range[1]), to = Number(range[2]);
      const lines = items.filter((i) => (i.msg >= from && i.msg <= to) || (i.resultMsg >= from && i.resultMsg <= to))
        .map((i) => `${i.id} ${i.kind}: ${i.text.trim().split(/\s+/).slice(0, 12).join(' ').slice(0, COMPACTION.recallLabelChars)}`);
      return paged(lines.join('\n') || '(no items)', `Index ${from}–${to}`, page);
    }
    const item = items.find((i) => i.id === id || i.resultId === id);
    if (!item) return `Error: no item "${id.slice(0, 200)}". Use an id from a stub, "notes", "index:A-B", or search.`;
    const result = item.resultId === id;
    const content = result ? messages[item.resultMsg].content : null;
    const text = result ? contentText(content) : item.call ? item.call.function.arguments : item.text;
    const kind = item.kind === 'page' ? `page ${JSON.stringify(item.pageId)}` : item.kind;
    const label = `Item ${id} (${kind}, message ${result ? item.resultMsg : item.msg})`;
    const output = paged(text, label, page);
    const images = Array.isArray(content) ? content.filter((p) => p.type === 'image_url').map((p) => ({ dataUrl: p.image_url.url, meta: structuredClone(p.meta) })) : [];
    return images.length && page === 1 ? { text: output, images } : output;
  }
  if (typeof search !== 'string') return 'Error: give "id" or "search".';
  // A pathological-size pattern must not make even the header exceed the result cap.
  if (search.length > COMPACTION.searchPatternChars) return `Error: regex is too long (maximum ${COMPACTION.searchPatternChars} characters).`;
  let regex;
  try { regex = new RegExp(search, 'i'); } catch (e) { return `Error: invalid regex ${e.message}`; }
  const hits = [];
  for (const item of items) {
    const match = regex.exec(item.text);
    if (!match) continue;
    const snippet = item.text.slice(Math.max(0, match.index - 60), match.index + Math.min(match[0].length, 120) + 60).replace(/\s+/g, ' ');
    hits.push(`${item.id} (${item.kind}, message ${item.msg}): …${snippet}…`);
  }
  if (!hits.length) return `No matches for /${search}/i.`;
  const pages = Math.ceil(hits.length / COMPACTION.searchHits);
  if (page > pages) return `Error: page ${page} is out of range (1–${pages}).`;
  return `Hits for /${search}/i, page ${page}:\n${hits.slice((page - 1) * COMPACTION.searchHits, page * COMPACTION.searchHits).join('\n')}` +
    (page < pages ? `\n… continue with page=${page + 1}` : '');
}
