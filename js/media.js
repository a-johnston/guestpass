// Attachable files: what kind each one is, and images shrunk before they are sent. The whole
// history is re-sent on every request (Chat Completions is stateless), so bytes matter more than
// fidelity: images are capped at ~1 MP and encoded at low quality. Pure helpers are unit tested
// under Node; the DOM ones (canvas encoding) only run in the browser and touch nothing at import.

export const MAX_IMAGE_PIXELS = 1024 * 1024; // 1024 basalt tokens (32 px tiles)
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_INLINE_TEXT_BYTES = 100 * 1024;
export const IMAGE_QUALITY = 0.25;

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|mpe?g|3gp)$/i;
const DOCUMENT_EXT = /\.(pdf|docx|pptx|xlsx)$/i;
const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/** The largest size within `maxPixels` with the same aspect ratio; never larger than the original. */
export function fitWithin(w, h, maxPixels = MAX_IMAGE_PIXELS) {
  const scale = Math.min(1, Math.sqrt(maxPixels / (w * h)));
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)) };
}

/** Tokens an image costs on basalt (32 px tiles, 8..4096); an estimate on other servers. */
export function imageTokens(width, height) {
  return Math.min(4096, Math.max(8, Math.ceil(width / 32) * Math.ceil(height / 32)));
}

/**
 * What an attached file is, from its name and type: {kind: 'image'|'document'|'text'} or {error}.
 * 'text' is provisional: the caller still checks the bytes (looksLikeText) and the size.
 */
export function classifyFile({ name = '', type = '', size = 0 }, { vision = null, documents = false } = {}) {
  // By extension first: browsers type TypeScript (.ts) as video/mp2t.
  if (VIDEO_EXT.test(name) || (type.startsWith('video/') && !/\.ts$/i.test(name))) return { error: "Video isn't supported yet." };
  if (type === 'image/svg+xml' || /\.svg$/i.test(name)) return { kind: 'text' };
  if (type.startsWith('image/')) return vision === false ? { error: "This model can't see images." } : { kind: 'image' };
  if (DOCUMENT_EXT.test(name) || DOCUMENT_TYPES.has(type)) {
    if (!documents) return { error: "This server can't read PDF or Office files." };
    return size > MAX_DOCUMENT_BYTES ? { error: "Files over 10 MB aren't supported." } : { kind: 'document' };
  }
  return { kind: 'text' };
}

/** Valid UTF-8 with no NUL bytes. */
export function looksLikeText(bytes) {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** WebP is smaller, but only basalt is known to decode it (llama.cpp's stb_image doesn't). */
export function pickImageMime({ basalt, canWebp }) {
  return basalt && canWebp ? 'image/webp' : 'image/jpeg';
}

// ---------------------------------------------------------------- browser only

let webp = null;
/** Whether canvas can encode WebP here (Safari silently falls back to PNG). */
export function canEncodeWebp() {
  if (webp == null) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    webp = c.toDataURL('image/webp').startsWith('data:image/webp');
  }
  return webp;
}

export function readAsDataUrl(blob, mime) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(mime ? String(r.result).replace(/^data:[^;,]*/, `data:${mime}`) : String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * Decodes an image (a Blob, or a data URL string), scales it within MAX_IMAGE_PIXELS onto white,
 * and encodes it as `mime` at `quality`. A Blob that is already small enough, in a format
 * `acceptOriginal` allows, and smaller than the re-encode is returned as-is.
 */
export async function compressImage(source, { mime, quality = IMAGE_QUALITY, acceptOriginal = () => false }) {
  const blob = typeof source === 'string' ? await (await fetch(source)).blob() : source;
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error("Couldn't read this image.");
  }
  const { width, height } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  const fits = bitmap.width * bitmap.height <= MAX_IMAGE_PIXELS;
  bitmap.close?.();
  const encoded = await new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
  if (!encoded) throw new Error("Couldn't encode this image.");
  const useOriginal = typeof source !== 'string' && fits && acceptOriginal(blob.type) && blob.size < encoded.size;
  const out = useOriginal ? blob : encoded;
  const dataUrl = await readAsDataUrl(out);
  return { dataUrl, mime: out.type, width, height, bytes: dataUrl.length };
}
