// Connection config and the share-link codec.
//
// A share link is the app URL with `#c=<base64url(JSON)>` appended. The fragment is never
// sent to the web host, so the connection details only ever travel between the browser
// and the model server. This is encoding, not encryption: anyone with the link has the key.

export const CONFIG_VERSION = 1;
const HASH_PARAM = 'c';

/** @typedef {{v:number, baseUrl:string, apiKey?:string, model?:string, system?:string}} Config */

function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64) {
  const std = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** @param {Config} cfg */
export function encodeConfig(cfg) {
  return toBase64Url(JSON.stringify(cfg));
}

/** @returns {Config} */
export function decodeConfig(encoded) {
  let cfg;
  try {
    cfg = JSON.parse(fromBase64Url(encoded));
  } catch {
    throw new Error('The shared link is malformed (could not decode connection data).');
  }
  if (!cfg || typeof cfg !== 'object') throw new Error('The shared link is malformed.');
  if (cfg.v !== CONFIG_VERSION) throw new Error(`Unsupported shared link version: ${cfg.v}`);
  if (typeof cfg.baseUrl !== 'string' || !cfg.baseUrl) throw new Error('The shared link has no baseUrl.');
  return cfg;
}

/** Returns the decoded config from a location.hash string, or null if none is present. */
export function readShareFromHash(hash) {
  const encoded = new URLSearchParams((hash || '').replace(/^#/, '')).get(HASH_PARAM);
  return encoded ? decodeConfig(encoded) : null;
}

/** Accepts what people tend to paste and returns the API root (e.g. https://host:port/v1). */
export function normalizeBaseUrl(url) {
  return (url || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|models)$/, '');
}

/** Builds a share link for `cfg` rooted at the current page URL (without its hash). */
export function buildShareLink(pageUrl, cfg) {
  const out = { v: CONFIG_VERSION, baseUrl: normalizeBaseUrl(cfg.baseUrl) };
  if (cfg.apiKey) out.apiKey = cfg.apiKey;
  if (cfg.model) out.model = cfg.model;
  if (cfg.system) out.system = cfg.system;
  const base = pageUrl.split('#')[0];
  return `${base}#${HASH_PARAM}=${encodeConfig(out)}`;
}
