// Streaming helpers for OpenAI-compatible APIs: an SSE line parser that copes with chunk
// boundaries anywhere, and accumulators that fold a stream into one reply, for chat completions
// (createAccumulator) and the Responses API (createResponsesAccumulator). Both return the same
// shape, so the caller doesn't care which API answered.

/** Calls onData(payload) for each `data:` line, excluding the `[DONE]` sentinel. */
export function createSSEParser(onData) {
  let buf = '';
  const handle = (raw) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.startsWith('data:')) return; // blank lines, comments, event:/id: fields
    const data = line.slice(5).replace(/^ /, '');
    if (data && data !== '[DONE]') onData(data);
  };
  return {
    push(text) {
      buf += text;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    },
    end() {
      if (buf) handle(buf);
      buf = '';
    },
  };
}

export function createAccumulator() {
  let content = '';
  let reasoning = '';
  let finishReason = null;
  let usage = null;
  let timings = null; // llama.cpp-style server timings (decode speed etc.), if sent
  const toolCalls = [];

  const newSlot = () => ({ id: '', type: 'function', function: { name: '', arguments: '' } });

  function applyToolCall(tc) {
    let slot;
    if (Number.isInteger(tc.index)) {
      slot = toolCalls[tc.index] ??= newSlot();
    } else if (!toolCalls.length || (tc.id && !toolCalls.some((t) => t?.id === tc.id)) || (!tc.id && tc.function?.name)) {
      // No index: servers that do this send each call whole, so a new id/name means a new call.
      slot = newSlot();
      toolCalls.push(slot);
    } else {
      slot = toolCalls[toolCalls.length - 1];
    }
    if (tc.id) slot.id = tc.id;
    const fn = tc.function || {};
    if (fn.name && !slot.function.name) slot.function.name = fn.name;
    if (fn.arguments != null) {
      if (typeof fn.arguments === 'string') slot.function.arguments += fn.arguments;
      else slot.function.arguments = JSON.stringify(fn.arguments);
    }
  }

  return {
    apply(chunk) {
      if (chunk?.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
      // OpenAI sends usage in a final chunk with empty `choices`; some servers attach it to the
      // chunk carrying finish_reason instead. Read it before bailing on a missing choice.
      if (chunk?.usage) usage = chunk.usage;
      if (chunk?.timings) timings = chunk.timings;
      const choice = chunk?.choices?.[0];
      if (!choice) return;
      const d = choice.delta || choice.message || {};
      if (typeof d.content === 'string') content += d.content;
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === 'string') reasoning += r;
      if (Array.isArray(d.tool_calls)) d.tool_calls.forEach(applyToolCall);
      if (choice.finish_reason) finishReason = choice.finish_reason;
    },
    result() {
      const calls = toolCalls.filter(Boolean).map((tc, i) => ({ ...tc, id: tc.id || `call_${Date.now().toString(36)}_${i}` }));
      return { content, reasoning, toolCalls: calls, finishReason, usage, timings };
    },
  };
}

/** An Error carrying the API's error code (e.g. from a Responses `response.failed` event). */
function apiError(e) {
  const err = new Error(e?.message || JSON.stringify(e));
  if (e?.code) err.code = e.code;
  return err;
}

/**
 * Folds Responses API stream events into {content, reasoning, toolCalls, finishReason, usage,
 * timings, responseId, stored}. toolCalls take the chat shape. `stored` says whether the server
 * kept the response, so the next request can chain from it. A non-streaming reply is applied as
 * one `response.completed` event; its `output` is folded only if no deltas were seen.
 */
export function createResponsesAccumulator() {
  let content = '';
  let reasoning = '';
  let finishReason = null;
  let usage = null;
  let timings = null;
  let responseId = null;
  let stored = false;
  let streamed = false;
  const toolCalls = [];
  const callsByKey = new Map(); // item_id (else output_index) -> slot

  function addCall(item, index) {
    const slot = { id: item.call_id || item.id || '', type: 'function', function: { name: item.name || '', arguments: item.arguments || '' } };
    toolCalls.push(slot);
    if (item.id) callsByKey.set(item.id, slot);
    if (Number.isInteger(index)) callsByKey.set(index, slot);
    return slot;
  }
  const callFor = (ev) => callsByKey.get(ev.item_id) ?? callsByKey.get(ev.output_index);

  function fold(output) {
    for (const item of output || []) {
      if (item.type === 'message') {
        for (const p of item.content || []) if (p.type === 'output_text') content += p.text || '';
      } else if (item.type === 'reasoning') {
        for (const p of [...(item.content || []), ...(item.summary || [])]) reasoning += p.text || '';
      } else if (item.type === 'function_call') {
        addCall(item);
      }
    }
  }

  function finish(r) {
    if (!r) return;
    if (r.id) responseId = r.id;
    stored = !!responseId && r.store !== false;
    if (!streamed) fold(r.output);
    else {
      // Calls the stream never announced (text streamed, calls only in the final output).
      const known = new Set(toolCalls.map((c) => c.id));
      for (const item of r.output || []) if (item.type === 'function_call' && !known.has(item.call_id)) addCall(item);
    }
    if (r.usage) {
      const input = r.usage.input_tokens ?? 0;
      const output = r.usage.output_tokens ?? 0;
      usage = { prompt_tokens: input, completion_tokens: output, total_tokens: r.usage.total_tokens ?? input + output };
    }
    if (r.bridge?.timings) timings = r.bridge.timings;
    finishReason = r.bridge?.finish_reason
      || (r.incomplete_details?.reason === 'max_output_tokens' ? 'length' : toolCalls.length ? 'tool_calls' : 'stop');
  }

  return {
    apply(ev) {
      switch (ev?.type) {
        case 'response.created':
        case 'response.in_progress':
          if (ev.response?.id) responseId = ev.response.id;
          break;
        case 'response.output_text.delta':
          streamed = true;
          content += ev.delta || '';
          break;
        case 'response.reasoning_text.delta':
        case 'response.reasoning_summary_text.delta':
          streamed = true;
          reasoning += ev.delta || '';
          break;
        case 'response.output_item.added':
          if (ev.item?.type === 'function_call') {
            streamed = true;
            addCall(ev.item, ev.output_index);
          }
          break;
        case 'response.function_call_arguments.delta': {
          streamed = true;
          const slot = callFor(ev) ?? addCall({ id: ev.item_id }, ev.output_index);
          slot.function.arguments += ev.delta || '';
          break;
        }
        case 'response.output_item.done': {
          // Some servers send a call's arguments whole here instead of as deltas.
          const item = ev.item;
          if (item?.type !== 'function_call') break;
          const slot = callFor({ item_id: item.id, output_index: ev.output_index });
          if (!slot) { streamed = true; addCall(item, ev.output_index); break; }
          if (!slot.function.arguments && item.arguments) slot.function.arguments = item.arguments;
          if (!slot.function.name && item.name) slot.function.name = item.name;
          if (item.call_id) slot.id = item.call_id;
          break;
        }
        case 'response.completed':
        case 'response.incomplete':
          finish(ev.response);
          break;
        case 'response.failed':
          throw apiError(ev.response?.error || { message: 'The response failed.' });
        case 'error':
          throw apiError(ev.error || ev);
        default:
      }
    },
    result() {
      const calls = toolCalls.map((tc, i) => ({ ...tc, function: { ...tc.function }, id: tc.id || `call_${Date.now().toString(36)}_${i}` }));
      return { content, reasoning, toolCalls: calls, finishReason, usage, timings, responseId, stored };
    },
  };
}
