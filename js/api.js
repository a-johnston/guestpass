// Minimal client for an OpenAI-compatible API (chat completions + model list).
import { createSSEParser, createAccumulator } from './stream.js';

function headers(apiKey) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

/**
 * Turns an opaque fetch failure into something actionable. The message never names the server:
 * share-link recipients see it, and the link shouldn't reveal the address it connects to.
 */
export function explainNetworkError(err, baseUrl) {
  if (err?.name === 'AbortError') return err;
  if (!(err instanceof TypeError)) return err;
  let target;
  try { target = new URL(baseUrl); } catch { return new Error('Invalid server URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (location.protocol === 'https:' && target.protocol === 'http:' && !loopback) {
    return new Error('Blocked: this page is served over HTTPS, so browsers refuse to call a plain-HTTP server. Put the server behind TLS (e.g. a Caddy reverse proxy).');
  }
  return new Error(`The server didn't answer, or the browser blocked its reply. Check that it is up, its TLS certificate is valid, and it sends CORS headers allowing this origin (${location.origin}) and the Authorization header.`);
}

export async function listModels({ baseUrl, apiKey, signal }) {
  let res;
  try {
    res = await fetch(`${baseUrl}/models`, { headers: headers(apiKey), signal });
  } catch (e) {
    throw explainNetworkError(e, baseUrl);
  }
  if (!res.ok) throw new Error(`GET /models failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  // Keep the server's order: "the first model" means the one the server lists first.
  return (json.data || json.models || [])
    .map((m) => ({
      id: m.id || m.name,
      contextLength: contextLengthOf(m),
      // OpenRouter-style, also reported by basalt: ["text", "image", …]
      inputModalities: Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : null,
    }))
    .filter((m) => m.id);
}

/** Context window as reported by various servers' /models entries, if any. */
export function contextLengthOf(m) {
  const n = m?.meta?.n_ctx ?? m?.max_model_len ?? m?.context_length ?? m?.context_window ?? m?.meta?.n_ctx_train;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** llama.cpp-style servers (and basalt) describe themselves at <root>/props. Best effort; null if absent. */
export async function fetchProps({ baseUrl, apiKey }) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/v1$/, '')}/props`, { headers: headers(apiKey) });
    if (!res.ok) return null;
    const json = await res.json();
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
}

/** basalt's /v1/status: unlike /props, it is under /v1, so basalt sends CORS headers for it. */
export async function fetchStatus({ baseUrl, apiKey }) {
  try {
    const res = await fetch(`${baseUrl}/status`, { headers: headers(apiKey) });
    if (!res.ok) return null;
    const json = await res.json();
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
}

/** Basalt reads documents from 0.3.3; before that it dropped file parts without an error. */
const BASALT_DOCUMENTS_SINCE = [0, 3, 3];

function versionAtLeast(version, min) {
  const v = String(version ?? '').split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < min.length; i++) {
    const n = Number.isFinite(v[i]) ? v[i] : 0;
    if (n !== min[i]) return n > min[i];
  }
  return true;
}

/**
 * What the model and server accept, from a /models entry, /props and basalt's /v1/status (any may
 * be missing; a browser usually can't read basalt's /props). vision is null when nobody says:
 * callers treat that as "try it".
 */
export function capabilitiesFrom(model, props, status = null) {
  let vision = null;
  if (Array.isArray(model?.inputModalities)) vision = model.inputModalities.includes('image');
  else if (typeof props?.modalities?.vision === 'boolean') vision = props.modalities.vision;
  const basaltCaps = props?.basalt?.capabilities;
  const basaltStatus = status?.service === 'basalt';
  const n = props?.default_generation_settings?.n_ctx;
  return {
    vision,
    documents: (Array.isArray(basaltCaps) && basaltCaps.includes('documents'))
      || (basaltStatus && versionAtLeast(status.engine, BASALT_DOCUMENTS_SINCE)),
    basalt: !!props?.basalt || basaltStatus,
    contextLength: model?.contextLength || (Number.isFinite(n) && n > 0 ? n : null),
  };
}

/**
 * Streams one chat completion. onUpdate receives the partial accumulated message
 * ({content, reasoning, toolCalls}) as it arrives. Resolves to the final message.
 */
export async function streamChat({ baseUrl, apiKey, body, signal, onUpdate }) {
  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
  } catch (e) {
    throw explainNetworkError(e, baseUrl);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text;
    try { msg = JSON.parse(text).error?.message || text; } catch {}
    const err = new Error(`HTTP ${res.status}: ${msg.slice(0, 500) || res.statusText}`);
    err.status = res.status;
    throw err;
  }

  const acc = createAccumulator();
  const type = res.headers.get('content-type') || '';
  if (!type.includes('text/event-stream') && type.includes('json')) {
    acc.apply(await res.json()); // server ignored stream:true
    onUpdate?.(acc.result());
    return acc.result();
  }

  const parser = createSSEParser((data) => {
    let chunk;
    try { chunk = JSON.parse(data); } catch { return; } // non-JSON keepalives etc.
    acc.apply(chunk);
    onUpdate?.(acc.result());
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  parser.end();
  return acc.result();
}
