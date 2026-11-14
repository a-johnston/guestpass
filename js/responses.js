// Request bodies for the Responses API (POST /responses), built from the chat history in the
// chat-completions shape Guestpass keeps locally (after prepareHistory: meta stripped). A chained
// request passes only the messages after the chain head plus previous_response_id; the slice may
// start with tool results whose calls only the server holds, which is fine.
// Pure, so it is unit tested under Node.

/** A chat content part as a Responses input part; unknown part types pass through. */
function inputPart(p) {
  if (p.type === 'text') return { type: 'input_text', text: p.text };
  if (p.type === 'image_url') return { type: 'input_image', image_url: p.image_url?.url };
  if (p.type === 'file') return { type: 'input_file', filename: p.file?.filename, file_data: p.file?.file_data };
  return p;
}

const inputParts = (content) => (typeof content === 'string'
  ? [{ type: 'input_text', text: content }]
  : (Array.isArray(content) ? content : []).map(inputPart));

const textOf = (content) => (typeof content === 'string'
  ? content
  : (Array.isArray(content) ? content : []).filter((p) => p.type === 'text').map((p) => p.text).join('\n\n'));

/** Chat-shaped messages as Responses input items. System messages are dropped: `instructions` carries them. */
export function toResponsesInput(messages) {
  const items = [];
  for (const m of messages) {
    if (m.role === 'user') {
      items.push({ role: 'user', content: inputParts(m.content) });
    } else if (m.role === 'assistant') {
      if (m.reasoning_content) items.push({ type: 'reasoning', content: [{ type: 'reasoning_text', text: m.reasoning_content }] });
      const text = textOf(m.content);
      if (text) items.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const c of m.tool_calls || []) {
        items.push({ type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments });
      }
    } else if (m.role === 'tool') {
      const output = typeof m.content === 'string' ? m.content : inputParts(m.content);
      items.push({ type: 'function_call_output', call_id: m.tool_call_id, output });
    }
  }
  return items;
}

/** Chat-completions tool definitions, flattened the way the Responses API takes them. */
export function toResponsesTools(tools) {
  return tools.map(({ function: f }) => ({ type: 'function', name: f.name, description: f.description, parameters: f.parameters }));
}

/** A streaming Responses request. Empty or absent fields are omitted. */
export function buildResponsesBody({ instructions, messages, tools, model, previousResponseId }) {
  const body = {};
  if (model) body.model = model;
  if (instructions) body.instructions = instructions;
  body.input = toResponsesInput(messages);
  if (tools?.length) body.tools = toResponsesTools(tools);
  if (previousResponseId) body.previous_response_id = previousResponseId;
  body.stream = true;
  return body;
}
