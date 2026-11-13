// Connection config and the share-link codec.
//
// A share link is the app URL plus `#<fragment>`. The fragment never reaches the web host, so the
// connection details only travel between the browser and the model server. It's an encoding, not
// encryption: anyone with the link has the key. The model isn't included; chats use the server's
// first listed model.
//
// Payload text (before compression): `<url> [<apiKey> [<system prompt…>]]`, space-separated,
// trailing empty fields dropped. The URL is written compactly (see compactUrl): `https://` and a
// `/v1` path are implied, so `https://box.tail1234.ts.net/v1` is just `box.tail1234.ts.net`.
//
// Compression: a fixed canonical Huffman code over characters common in hostnames, ports, and
// keys, plus a few multi-character tokens (`.ts.net`, `localhost`, `:8080`, …). Characters
// outside the table are written as ESC + one UTF-8 byte each. If plain bytes would be shorter
// (e.g. a punctuation-heavy system prompt), the stream is RAW + UTF-8 bytes instead. Bits are
// packed into base64url and the last character is padded with 1-bits: in a canonical code the
// all-ones string is only a code at the maximum length (> 5), so padding never decodes as data.
//
// The code table is part of the link format: changing a symbol or weight breaks every existing
// link. That's accepted; links are meant to be temporary.

const LOWER = { e: 30, t: 26, a: 26, o: 22, i: 22, n: 22, s: 20, l: 16, r: 18, h: 14, d: 14, c: 14, u: 10, m: 10, p: 10, w: 8, g: 8, b: 8, f: 8, y: 6, k: 6, v: 6, x: 5, z: 4, q: 3, j: 3 };
const TOKENS = {
  '.ts.net': 12, '.tail': 12, localhost: 6, '127.0.0.1': 3, '192.168.': 5, '10.0.': 2, '.local': 3,
  '.com': 6, '.net': 3, '.org': 2, '.io': 3, '.dev': 2, '.ai': 2, 'http://': 5,
  ':8080': 5, ':8000': 3, ':11434': 3, ':1234': 2, ':5000': 2, ':3000': 2, ':443': 1, 'sk-': 4, '/api': 2, '/v1': 3,
};
const ESC = 'ESC';
const RAW = 'RAW';

/** [symbol, weight] in a fixed order (ties in the code construction break by this order). */
const TABLE = [
  ...Object.entries(LOWER),
  ...'0123456789'.split('').map((d) => [d, 12]),
  ['.', 20], [' ', 16], ['-', 8], [':', 6], ['/', 4], ['_', 4],
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => [c, 3]),
  ...Object.entries(TOKENS),
  [ESC, 2], [RAW, 1],
];

/** Canonical Huffman code for TABLE: {symbols, lengths, codes: [{code, len}], decode: Map}. */
function buildCode(table) {
  let nodes = table.map(([, w], i) => ({ w, sym: i, order: i }));
  let order = nodes.length;
  while (nodes.length > 1) {
    nodes.sort((a, b) => a.w - b.w || a.order - b.order);
    const [a, b] = nodes.splice(0, 2);
    nodes.push({ w: a.w + b.w, kids: [a, b], order: order++ });
  }
  const lengths = new Array(table.length);
  (function walk(n, depth) {
    if (n.kids) n.kids.forEach((k) => walk(k, depth + 1));
    else lengths[n.sym] = Math.max(depth, 1);
  })(nodes[0], 0);

  const bySize = lengths.map((_, i) => i).sort((a, b) => lengths[a] - lengths[b] || a - b);
  const codes = new Array(table.length);
  let code = 0;
  bySize.forEach((s, k) => {
    if (k) code = (code + 1) << (lengths[s] - lengths[bySize[k - 1]]);
    codes[s] = { code, len: lengths[s] };
  });
  const decode = new Map(codes.map((c, s) => [`${c.len}:${c.code}`, s]));
  return { symbols: table.map(([s]) => s), lengths, codes, decode, maxLen: Math.max(...lengths) };
}

export const CODE = buildCode(TABLE);
const SYM_INDEX = new Map(CODE.symbols.map((s, i) => [s, i]));
/** Multi-character tokens first (longest first), so encoding matches them greedily. */
const MATCH_ORDER = CODE.symbols.filter((s) => s !== ESC && s !== RAW).sort((a, b) => b.length - a.length);

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

class BitWriter {
  bits = [];
  write(value, len) {
    for (let i = len - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
  symbol(s) {
    const { code, len } = CODE.codes[SYM_INDEX.get(s)];
    this.write(code, len);
  }
  toBase64Url() {
    const bits = [...this.bits];
    while (bits.length % 6) bits.push(1); // 1-padding can't complete a code (see top)
    let out = '';
    for (let i = 0; i < bits.length; i += 6) out += B64[bits.slice(i, i + 6).reduce((v, b) => (v << 1) | b, 0)];
    return out;
  }
}

function huffmanBits(text) {
  const w = new BitWriter();
  const bytes = new TextEncoder();
  for (let i = 0; i < text.length;) {
    const sym = MATCH_ORDER.find((s) => text.startsWith(s, i));
    if (sym) {
      w.symbol(sym);
      i += sym.length;
    } else {
      const ch = String.fromCodePoint(text.codePointAt(i));
      for (const byte of bytes.encode(ch)) {
        w.symbol(ESC);
        w.write(byte, 8);
      }
      i += ch.length;
    }
  }
  return w;
}

function rawBits(text) {
  const w = new BitWriter();
  w.symbol(RAW);
  for (const byte of new TextEncoder().encode(text)) w.write(byte, 8);
  return w;
}

function decodeBits(fragment) {
  const bits = [];
  for (const ch of fragment) {
    const v = B64.indexOf(ch);
    if (v === -1) throw new Error('bad character');
    for (let i = 5; i >= 0; i--) bits.push((v >> i) & 1);
  }
  let pos = 0;
  const readSymbol = () => {
    let code = 0;
    for (let len = 1; len <= CODE.maxLen && pos < bits.length; len++) {
      code = (code << 1) | bits[pos++];
      const s = CODE.decode.get(`${len}:${code}`);
      if (s !== undefined) return CODE.symbols[s];
    }
    return null; // ran out mid-code: padding (checked below) or truncation
  };
  const readByte = () => {
    let v = 0;
    for (let i = 0; i < 8; i++) v = (v << 1) | bits[pos++];
    return v;
  };

  const out = [];
  const bytes = [];
  const flush = () => { if (bytes.length) { out.push(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes))); bytes.length = 0; } };
  let start = pos;
  let first = readSymbol();
  if (first === RAW) {
    while (bits.length - pos >= 8) bytes.push(readByte());
    flush();
    start = pos;
  } else {
    pos = start;
    for (;;) {
      start = pos;
      const s = readSymbol();
      if (s === null) break;
      if (s === ESC) {
        if (bits.length - pos < 8) throw new Error('truncated escape');
        bytes.push(readByte());
        continue;
      }
      if (s === RAW) throw new Error('RAW marker mid-stream');
      flush();
      out.push(s);
    }
    flush();
  }
  const tail = bits.slice(start);
  if (tail.length > 5 || tail.some((b) => b !== 1)) throw new Error('bad padding');
  return out.join('');
}

/** URL in its link form: `https://` and a `/v1` path implied; anything else kept explicitly. */
export function compactUrl(url) {
  const u = new URL(normalizeBaseUrl(url));
  const scheme = u.protocol === 'http:' ? 'http://' : '';
  const path = u.pathname === '/v1' ? '' : u.pathname; // a root path stays "/", so it can't read as /v1
  return `${scheme}${u.host}${path}${u.search}`;
}

/** Inverse of compactUrl. */
export function expandUrl(text) {
  const withScheme = /^https?:\/\//.test(text) ? text : `https://${text}`;
  const afterScheme = withScheme.replace(/^https?:\/\//, '');
  const full = afterScheme.includes('/') ? withScheme : `${withScheme}/v1`;
  return normalizeBaseUrl(full);
}

/** @typedef {{baseUrl:string, apiKey:string, system:string}} Config */

/** @param {Partial<Config>} cfg */
export function encodeConfig({ baseUrl, apiKey = '', system = '' }) {
  const fields = [compactUrl(baseUrl), apiKey.trim(), system.trim()];
  while (fields.length > 1 && !fields.at(-1)) fields.pop();
  const text = fields.join(' ');
  const huff = huffmanBits(text);
  const raw = rawBits(text);
  return (raw.bits.length < huff.bits.length ? raw : huff).toBase64Url();
}

/** @returns {Config} */
export function decodeConfig(encoded) {
  let text;
  try {
    text = decodeBits(encoded || '');
  } catch {
    throw new Error('The shared link is malformed (could not decode connection data).');
  }
  const [urlText = '', apiKey = '', ...rest] = text.split(' ');
  let url;
  try { url = new URL(expandUrl(urlText)); } catch {}
  if (!urlText || !url || !/^https?:$/.test(url.protocol)) throw new Error('The shared link is malformed (no valid server URL).');
  return { baseUrl: expandUrl(urlText), apiKey, system: rest.join(' ') };
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
