// Converts the conversation (the OpenAI-style message list) into a markdown document for
// saving. Pure, so it is unit tested under Node. The server URL and API key are never included.

/**
 * @param {{role:string, content?:string, tool_calls?:any[], tool_call_id?:string}[]} messages
 * @param {{model?:string, system?:string, savedAt?:Date}} meta
 */
export function sessionToMarkdown(messages, { model = '', system = '', savedAt = new Date() } = {}) {
  const out = ['# Chat Bridge session', ''];
  out.push(`- Saved: ${formatDate(savedAt)}`);
  if (model) out.push(`- Model: ${model}`);
  out.push('');
  if (system.trim()) out.push('**System prompt:**', '', quote(system), '');
  out.push('---', '');

  const results = new Map(messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content ?? '']));
  let lastHeading = '';
  const heading = (name) => {
    if (lastHeading !== name) out.push(`## ${name}`, '');
    lastHeading = name;
  };

  for (const m of messages) {
    if (m.role === 'user') {
      heading('User');
      out.push((m.content ?? '').trimEnd(), '');
    } else if (m.role === 'assistant') {
      heading('Assistant'); // one heading per turn, even across several tool rounds
      if (m.content) out.push(m.content.trimEnd(), '');
      for (const call of m.tool_calls || []) out.push(...toolCallBlock(call, results.get(call.id)));
    }
    // role "tool" is rendered with the call that produced it
  }
  return `${out.join('\n').trimEnd()}\n`;
}

function toolCallBlock(call, result) {
  const name = call.function?.name || 'tool';
  const raw = call.function?.arguments ?? '';
  let args = null;
  try { args = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw; } catch {}
  const label = args && (args.title || args.id) ? `${name} · ${args.title || args.id}` : name;

  const lines = ['<details>', `<summary>Tool call: ${escapeHtml(label)}</summary>`, ''];
  if (args && typeof args === 'object') {
    // Keep generated pages readable: HTML gets its own block instead of a JSON-escaped string.
    const { html, ...rest } = args;
    if (Object.keys(rest).length) lines.push(fence(JSON.stringify(rest, null, 2), 'json'), '');
    if (typeof html === 'string') lines.push(fence(html, 'html'), '');
  } else if (raw) {
    lines.push(fence(String(raw)), '');
  }
  if (result != null) lines.push('Result:', '', fence(result), '');
  lines.push('</details>', '');
  return lines;
}

/** A code fence longer than any backtick run inside `text`, so the content can't close it early. */
function fence(text, lang = '') {
  const longest = Math.max(2, ...(String(text).match(/`+/g) || []).map((s) => s.length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${String(text).replace(/\n$/, '')}\n${ticks}`;
}

function quote(text) {
  return text.trim().split('\n').map((l) => `> ${l}`).join('\n');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
