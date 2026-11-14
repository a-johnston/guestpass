// Deterministic history compaction. Pure, unit tested under Node; no DOM or application state.
import { historyItems, headTail, collectNotes, matchToolResults, normalizeToolIds } from './items.js';
import { estimateTokens, contentText, mediaLabel, coalesceMessages } from './content.js';

import { COMPACTION } from './compaction-config.js';
export { COMPACTION };

export const OMITTED_MARKER = '[not page source';
export const omittedHtml = (id) =>
  `${OMITTED_MARKER}: omitted from history after a later render of "${id}". Use read("${id}") for the current source.]`;
export const clearedHtml = (id) =>
  `${OMITTED_MARKER}: cleared from history. Use read("${id}") for the current source.]`;

/** Compare estimates in the server's units to cancel chars/4's systematic bias. */
export function shouldCompact({ used, max, held, compacted }) {
  if (!(used > 0) || !(max > 0)) return false;
  const resend = held > 0 ? compacted * (used / held) : compacted;
  return used >= COMPACTION.highMark * max && used - resend >= COMPACTION.minFree * max;
}

/** A length finish can reveal a window; later larger usage proves it was an output cap. */
export function learnWindow(win, { finishReason, used }) {
  if (!(used > 0)) return { ...win };
  if (win.max != null && used > win.max) return { max: null, floor: used };
  if (win.max == null && finishReason === 'length' && used >= win.floor) return { max: used, floor: win.floor };
  return { ...win };
}

/** Integer weighted water-filling; rounding never spends more than the available total. */
export function allocate(demand, weights, total) {
  const out = Object.fromEntries(Object.keys(demand).map((k) => [k, 0]));
  let pending = Object.keys(demand).filter((k) => demand[k] > 0 && weights[k] > 0);
  let remaining = Math.max(0, Math.floor(total));
  while (pending.length && remaining > 0) {
    const weight = pending.reduce((n, k) => n + weights[k], 0);
    const capped = pending.filter((k) => demand[k] <= remaining * weights[k] / weight);
    if (!capped.length) {
      for (const k of pending) out[k] = Math.floor(remaining * weights[k] / weight);
      break;
    }
    for (const k of capped) { out[k] = demand[k]; remaining -= demand[k]; }
    pending = pending.filter((k) => !capped.includes(k));
  }
  return out;
}

const textPart = (text) => ({ type: 'text', text });
const tokens = (text) => estimateTokens([{ content: text }]);
const parseArgs = (call) => { try { return JSON.parse(call.function.arguments); } catch { return {}; } };
const wireCall = (c, args = c.function.arguments) => ({ id: c.id, type: c.type, function: { name: c.function.name, arguments: c.cutOff ? '{}' : args } });
const clearedContent = (content) => Array.isArray(content) ? content.map((p) => p.meta?.cleared ? textPart(`[${mediaLabel(p)} — cleared from history]`) : p) : content;

function shortText(text, id, tools) {
  const { head, tail } = headTail(text, COMPACTION.stubWords);
  return [head, tools ? `[… recall ${id}]` : '[…]', tail].filter(Boolean).join(' ');
}

/** A decision owns the call and result together, so neither can be removed on its own. */
function stub(item, source, tools) {
  if (!item.call) return { text: shortText(item.text, item.id, tools) };
  const args = parseArgs(item.call);
  const result = source[item.resultMsg]?.content ?? '';
  const ref = (id) => tools ? `, recall ${id}` : '';
  switch (item.kind) {
    case 'read': {
      const match = contentText(result).match(/Lines (\d+)-(\d+)/i);
      const start = args.start ?? match?.[1], end = args.end ?? match?.[2] ?? start;
      const lines = start != null ? ` lines ${start}–${end}` : '';
      return { args: item.call.function.arguments, result: `[read ${JSON.stringify(args.id ?? '')}${lines}; stale${ref(item.resultId)}]` };
    }
    case 'edit': {
      const match = contentText(result).match(/\(lines? (\d+)(?:[-–](\d+))?/);
      const start = args.start ?? (match ? Number(match[1]) : undefined);
      const end = args.end ?? (match ? Number(match[2] || match[1]) : start);
      const lines = start != null ? `lines ${start}–${end}` : 'source';
      return { args: JSON.stringify({ id: args.id, ...(start != null ? { start, end } : {}), new: `${OMITTED_MARKER}: edit of ${lines}${ref(item.id)}]` }), result };
    }
    case 'page':
      return { args: JSON.stringify({ ...args, html: item.call.cleared ? clearedHtml(args.id) : item.call.superseded ? omittedHtml(args.id) : `${OMITTED_MARKER}: current source: read("${args.id}")]` }), result };
    case 'shot':
      return { args: item.call.function.arguments, result: [textPart(`[earlier screenshot of "${item.pageId}"${ref(item.resultId)}]`)] };
    case 'recall':
      return { args: item.call.function.arguments, result: `[recall result${ref(item.resultId)}]` };
    default: {
      const lines = contentText(result).trim().split('\n');
      return { args: item.call.function.arguments, result: [lines[0], tools ? `[… recall ${item.resultId}]` : '[…]', ...(lines.length > 1 ? [lines.at(-1)] : [])].join('\n') };
    }
  }
}

function decisionTokens(item, decision) {
  return item.call
    ? estimateTokens([{ tool_calls: [wireCall(item.call, decision.args)] }, { content: decision.result }])
    : tokens(decision.text);
}

export function compactHistory(messages, { window = COMPACTION.nominalWindow, thinkingMode = 'all', sendReasoning = true, tools = true } = {}) {
  // A failed send can leave a trailing user message that pushUser will later merge into.
  let upTo = messages.at(-1)?.role === 'user' ? messages.length - 1 : messages.length;
  // Compact can be clicked while a tool batch is still running. Freeze only completed pairs.
  const answered = matchToolResults(messages);
  const pending = messages.findIndex((m, i) => m.tool_calls?.some((c, k) => !answered.has(`a${i}.${k}`)));
  if (pending >= 0) upTo = Math.min(upTo, pending);
  const source = structuredClone(messages.slice(0, upTo));
  const lastUser = messages.findLastIndex((m) => m.role === 'user');
  const firstUser = messages.findIndex((m) => m.role === 'user');
  const fullShape = source.map(({ reasoning, thinkingMs, ...m }) => ({ ...m, ...(reasoning && sendReasoning ? { reasoning_content: reasoning } : {}) }));
  const before = estimateTokens(fullShape.filter((m) => tools || m.role !== 'tool').map((m) => tools ? m : { ...m, tool_calls: undefined }));
  const items = historyItems(source);
  const hasImage = (item) => Array.isArray(source[item.resultMsg]?.content) && source[item.resultMsg].content.some((p) => p.type === 'image_url');
  const newestShot = new Map();
  // Include cleared images here so clearing the newest cannot resurrect an older image.
  for (const item of items) if (item.kind === 'shot' && hasImage(item)) newestShot.set(item.pageId, item.id);
  const decisions = new Map();
  const allNotes = collectNotes(items);
  const budgeted = [];
  const demand = Object.fromEntries(Object.keys(COMPACTION.weights).map((k) => [k, 0]));
  demand.notes = tokens(allNotes.map((n) => `- ${n}`).join('\n'));
  let mandatory = 0;
  for (const item of items) {
    if ((!tools && item.call) || ((item.kind === 'reasoning' || item.kind === 'plan') && (!sendReasoning || (thinkingMode === 'turn' && item.msg < lastUser)))) {
      decisions.set(item.id, { drop: true });
      continue;
    }
    const whole = item.call
      ? { args: item.call.cutOff ? '{}' : item.call.function.arguments, result: clearedContent(source[item.resultMsg]?.content ?? '') }
      : { text: clearedContent(source[item.msg].content) };
    if (item.kind === 'reasoning' || item.kind === 'plan') whole.text = item.text;
    const kind = item.kind === 'shot' && !hasImage(item) ? 'other' : item.kind;
    const small = stub(kind === item.kind ? item : { ...item, kind }, source, tools);
    if (item.kind === 'user') {
      const decision = item.msg !== firstUser && item.msg !== lastUser && item.tokens > COMPACTION.userCap ? { ...small, compacted: true, stub: true } : whole;
      decisions.set(item.id, decision);
      if (decision.stub) demand.stubs += decisionTokens(item, decision);
      else mandatory += decisionTokens(item, decision);
    } else if ((item.kind === 'shot' && hasImage(item)) || (item.kind === 'page' && (item.call.superseded || item.call.cleared))) {
      const keepShot = item.kind === 'shot' && newestShot.get(item.pageId) === item.id;
      const decision = keepShot ? whole : { ...small, compacted: true, stub: true };
      decisions.set(item.id, decision);
      if (keepShot) mandatory += decisionTokens(item, decision);
      else demand.stubs += decisionTokens(item, decision);
    } else {
      if (item.kind === 'plan' && item.text.length > (COMPACTION.planHead + COMPACTION.planTail) * 4) {
        whole.text = item.text.slice(0, COMPACTION.planHead * 4) + (tools ? `\n[… recall ${item.id} …]\n` : '\n[…]\n') + item.text.slice(-COMPACTION.planTail * 4);
        whole.compacted = true;
      }
      const cost = decisionTokens(item, whole);
      demand[kind] += cost;
      demand.stubs += decisionTokens(item, small);
      budgeted.push({ item, kind, whole, small, cost });
    }
  }
  // Reserve bounded directory/heading overhead before allocation. Otherwise hundreds of
  // disjoint removed ranges can make the directory larger than the original context window.
  const remaining = Math.max(0, Math.floor(window * COMPACTION.lowMark) - mandatory);
  const metadataReserve = Math.min(COMPACTION.directoryTokens, remaining);
  const shares = allocate(demand, COMPACTION.weights, remaining - metadataReserve);
  const stubShare = shares.stubs;
  const noteShare = shares.notes;
  for (const { item, kind, whole, small, cost } of budgeted.toReversed()) {
    if (cost <= shares[kind]) { decisions.set(item.id, whole); shares[kind] -= cost; }
    else decisions.set(item.id, { ...small, compacted: true, stub: true });
  }

  let stubTokens = items.reduce((n, item) => n + (decisions.get(item.id).stub ? decisionTokens(item, decisions.get(item.id)) : 0), 0);
  const removed = [];
  for (const item of items) {
    const d = decisions.get(item.id);
    if (!d.stub || stubTokens <= stubShare) continue;
    stubTokens -= decisionTokens(item, d);
    d.drop = true;
    removed.push(item);
  }
  const removedIndices = [...new Set(removed.flatMap((i) => [i.msg, ...(i.resultMsg != null ? [i.resultMsg] : [])]))].sort((a, b) => a - b);
  const ranges = [];
  for (const i of removedIndices) {
    if (ranges.at(-1)?.end === i - 1) ranges.at(-1).end = i;
    else ranges.push({ start: i, end: i });
  }
  let directory = ranges.map(({ start, end }) => {
    const n = removed.filter((i) => i.msg >= start && i.msg <= end).length;
    return `Messages ${start}–${end} compacted (${n} items)${tools ? `: recall id "index:${start}-${end}" lists them.` : '.'}`;
  });
  const notes = collectNotes(items.filter((i) => decisions.get(i.id).compacted));
  const noteLines = [];
  for (const note of notes) {
    const line = `- ${note}`;
    if (tokens([...noteLines, line].join('\n')) > noteShare) break;
    noteLines.push(line);
  }
  const moreNotes = noteLines.length < notes.length
    ? `[${notes.length - noteLines.length} older notes${tools ? ': recall id "notes"' : ''}]` : '';
  const labels = `[Compacted history]\n${notes.length ? 'Notes (newest first):\n' : ''}${moreNotes}`;
  if (ranges.length > 1 && tokens(directory.join('\n')) > Math.max(0, metadataReserve - tokens(labels))) {
    const start = ranges[0].start, end = ranges.at(-1).end;
    // A bounded top-level directory; recall's paged index supplies the detailed history,
    // including the retained messages between these disjoint removed ranges.
    directory = [`Messages ${start}–${end} compacted (${removed.length} items across ${ranges.length} ranges)${tools ? `: recall id "index:${start}-${end}" lists them.` : '.'}`];
  }
  const block = [...directory, ...(notes.length ? ['Notes (newest first):', ...noteLines, ...(moreNotes ? [moreNotes] : [])] : [])];

  const out = source.map((m) => ({ role: m.role, content: '', ...(m.role === 'tool' ? { tool_call_id: m.tool_call_id } : {}) }));
  const keptResults = new Set();
  const keptMessages = new Set();
  for (const item of items) {
    const d = decisions.get(item.id);
    if (d.drop) continue;
    const m = out[item.msg];
    keptMessages.add(item.msg);
    if (item.call) {
      (m.tool_calls ||= []).push(wireCall(item.call, d.args));
      if (item.resultMsg != null) { out[item.resultMsg].content = d.result; keptResults.add(item.resultMsg); }
    } else if (item.kind === 'reasoning' || item.kind === 'plan') m.reasoning_content = d.text;
    else m.content = d.text;
  }
  if (block.length && out[firstUser]) {
    const content = out[firstUser].content;
    out[firstUser].content = [...(Array.isArray(content) ? content : [textPart(content)]), textPart(`[Compacted history]\n${block.join('\n')}`)];
  }
  const kept = out.filter((m, i) => {
    if (m.role === 'tool' && !keptResults.has(i)) return false;
    if (m.role === 'user' && !keptMessages.has(i)) return false;
    if (m.role === 'assistant' && !m.content && !m.reasoning_content && !m.tool_calls?.length) return false;
    return true;
  });
  const built = normalizeToolIds(coalesceMessages(kept));
  return { messages: built, upTo, before, after: estimateTokens(built) };
}
