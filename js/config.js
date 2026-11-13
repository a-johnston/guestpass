// Connection config and the share-link codec.
//
// A share link is the app URL with `#<base64url(payload)>`, where the payload is plain text:
//
//     <baseUrl> [<apiKey> [<system prompt…>]]
//
// separated by single spaces (URLs and API keys contain none; the system prompt is everything
// after the second space). Trailing empty fields are omitted, and base64 padding is dropped, to
// keep links short. The fragment is never sent to the web host, so the connection details only
// travel between the browser and the model server. This is encoding, not encryption: anyone
// with the link has the key. The model is not included; the chat uses the server's first model.

/** @typedef {{baseUrl:string, apiKey:string, system:string}} Config */

function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64) {
  const std = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** @param {Partial<Config>} cfg */
export function encodeConfig({ baseUrl, apiKey = '', system = '' }) {
  const fields = [normalizeBaseUrl(baseUrl), apiKey.trim(), system.trim()];
  while (fields.length > 1 && !fields.at(-1)) fields.pop();
  return toBase64Url(fields.join(' '));
}

/** @returns {Config} */
export function decodeConfig(encoded) {
  let text;
  try {
    text = fromBase64Url(encoded);
  } catch {
    throw new Error('The shared link is malformed (could not decode connection data).');
  }
  const [baseUrl = '', apiKey = '', ...rest] = text.split(' ');
  let url;
  try { url = new URL(baseUrl); } catch {}
  if (!url || !/^https?:$/.test(url.protocol)) throw new Error('The shared link is malformed (no valid server URL).');
  return { baseUrl: normalizeBaseUrl(baseUrl), apiKey, system: rest.join(' ') };
}

/** Returns the decoded config from a location.hash string, or null if none is present. */
export function readShareFromHash(hash) {
  const encoded = (hash || '').replace(/^#/, '');
  return encoded ? decodeConfig(encoded) : null;
}

/** Accepts what people tend to paste and returns the API root (e.g. https://host:port/v1). */
export function normalizeBaseUrl(url) {
  return (url || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|models)$/, '');
}

/** Builds a share link for `cfg` rooted at the given page URL (without its hash). */
export function buildShareLink(pageUrl, cfg) {
  return `${pageUrl.split('#')[0]}#${encodeConfig(cfg)}`;
}
