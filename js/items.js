// Addressable history items. Pure, unit tested under Node; never changes local messages.
import { contentText, estimateTokens } from './content.js';
import { COMPACTION } from './compaction-config.js';

export function toolKind(name) {
  return ({ read: 'read', edit: 'edit', inline: 'page', pane: 'page', screenshot: 'shot', recall: 'recall' })[name] || 'other';
}

/** Match results in history order, even when a server reuses ids in later turns. */
export function matchToolResults(messages) {
  const pending = new Map(), results = new Map();
  messages.forEach((m, msg) => {
    if (m.role === 'tool') {
      const queue = pending.get(m.tool_call_id);
      if (queue && queue.next < queue.calls.length) results.set(queue.calls[queue.next++], msg);
    } else {
      (m.tool_calls || []).forEach((call, k) => {
        if (!pending.has(call.id)) pending.set(call.id, { calls: [], next: 0 });
        pending.get(call.id).calls.push(`a${msg}.${k}`);
      });
    }
  });
  return results;
}

/** Repair duplicate wire ids without changing originals or ids in a results-only chain tail. */
export function normalizeToolIds(messages) {
  const results = matchToolResults(messages), used = new Set();
  const out = messages.slice();
  messages.forEach((m, msg) => {
    if (!m.tool_calls) return;
    const calls = m.tool_calls.map((call, k) => {
      let id = call.id;
      if (used.has(id)) {
        id = `call_guestpass_${msg}_${k}`;
        while (used.has(id)) id += '_';
      }
      used.add(id);
      if (id === call.id) return call;
      const resultMsg = results.get(`a${msg}.${k}`);
      if (resultMsg != null) out[resultMsg] = { ...out[resultMsg], tool_call_id: id };
      return { ...call, id };
    });
    if (calls.some((c, k) => c !== m.tool_calls[k])) out[msg] = { ...out[msg], tool_calls: calls };
  });
  return out;
}

export function historyItems(messages) {
  const results = matchToolResults(messages);
  const items = [];
  messages.forEach((m, msg) => {
    if (m.role === 'tool') return;
    if (m.reasoning) items.push({ id: `r${msg}`, kind: m.reasoning.length > COMPACTION.planTokens * 4 ? 'plan' : 'reasoning', msg, text: m.reasoning, tokens: m.reasoning.length / 4 });
    const text = contentText(m.content);
    if (text || (Array.isArray(m.content) && m.content.length)) {
      items.push({ id: `m${msg}`, kind: m.role === 'user' ? 'user' : 'text', msg, text, tokens: estimateTokens([{ content: m.content }]) });
    }
    (m.tool_calls || []).forEach((call, k) => {
      const resultMsg = results.get(`a${msg}.${k}`);
      const result = messages[resultMsg];
      let args;
      try { args = JSON.parse(call.function.arguments); } catch {}
      const part = Array.isArray(result?.content) && result.content.find((p) => p.meta?.pageId != null);
      items.push({
        id: `a${msg}.${k}`, kind: toolKind(call.function.name), msg, call,
        text: `${call.function.arguments}\n${contentText(result?.content)}`,
        tokens: estimateTokens([{ tool_calls: [call] }, { content: result?.content }]),
        ...(result ? { resultMsg, resultId: `t${resultMsg}` } : {}),
        tool: call.function.name, pageId: part?.meta?.pageId ?? args?.id,
      });
    });
  });
  return items;
}

export function findNotes(text) {
  return String(text).split(/\r?\n/).flatMap((line) => {
    const marked = line.trim().replace(/^(?:- |\* |> )/, '');
    if (!/^(?:key|important|preserve):/i.test(marked)) return [];
    return [marked.length > COMPACTION.noteChars ? marked.slice(0, COMPACTION.noteChars - 1) + '…' : marked];
  });
}

/** Lasting assistant findings in history order reversed, deduplicated at their newest position. */
export function collectNotes(items) {
  return [...new Set(items.toReversed()
    .filter((i) => ['reasoning', 'plan', 'text'].includes(i.kind))
    .flatMap((i) => findNotes(i.text).toReversed()))];
}

export function headTail(text, words = COMPACTION.stubWords) {
  const sentences = String(text).trim().split(/(?<=[.!?\n])\s+/).filter(Boolean);
  const cut = (s) => {
    const all = (s || '').split(/\s+/);
    return all.length > words ? all.slice(0, words).join(' ') + '…' : s || '';
  };
  return { head: cut(sentences[0]), tail: sentences.length > 1 ? cut(sentences.at(-1)) : '' };
}
