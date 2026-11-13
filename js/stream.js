// Streaming helpers for OpenAI-compatible chat completions: an SSE line parser that copes
// with chunk boundaries anywhere, and an accumulator that folds deltas into a message.

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
