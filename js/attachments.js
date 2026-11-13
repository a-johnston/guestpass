// The attachment tray above the composer: files added with the + button, pasted, or dropped become
// content parts (see content.js) once read and, for images, compressed. Each shows as a chip with
// the size it adds to every request; a file that can't be attached shows its reason briefly.
import {
  classifyFile, compressImage, readAsDataUrl, looksLikeText, formatBytes,
  IMAGE_QUALITY, MAX_DOCUMENT_BYTES, MAX_INLINE_TEXT_BYTES,
} from './media.js';

const ERROR_MS = 4000;

/**
 * @param {{tray:HTMLElement, input:HTMLInputElement, button:HTMLElement, dropTarget:HTMLElement,
 *          pasteTarget:HTMLElement, getOptions:() => {caps:{vision:boolean|null, documents:boolean, basalt:boolean}, mime:string}}} opts
 */
export function createAttachmentTray({ tray, input, button, dropTarget, pasteTarget, getOptions }) {
  /** @type {{part:object|null, chip:HTMLElement, done:Promise<void>, failed?:boolean}[]} */
  let entries = [];
  const sync = () => { tray.hidden = entries.length === 0; };

  const remove = (entry) => {
    entries = entries.filter((e) => e !== entry);
    entry.chip.remove();
    sync();
  };

  function add(file) {
    const chip = el('div', 'chip busy');
    chip.append(el('span', 'chip-name', file.name || 'pasted file'), el('span', 'chip-size', '…'));
    const entry = { part: null, chip, done: null };
    entry.done = toPart(file, getOptions()).then(
      (part) => {
        entry.part = part;
        chip.replaceWith(entry.chip = partChip(part, () => remove(entry)));
      },
      (err) => {
        entry.failed = true;
        chip.className = 'chip error';
        chip.textContent = `${file.name || 'File'}: ${err.message}`;
        setTimeout(() => remove(entry), ERROR_MS);
      },
    );
    entries.push(entry);
    tray.append(chip);
    sync();
  }

  const addAll = (files) => [...files].forEach(add);

  button.addEventListener('click', () => {
    const { caps } = getOptions();
    // Only a hint for the file dialog; classifyFile decides.
    input.accept = [
      caps.vision !== false && 'image/*',
      caps.documents && '.pdf,.docx,.pptx,.xlsx',
      'text/*,.md,.json,.csv,.yaml,.yml,.xml,.js,.ts,.py,.html,.css,.svg',
    ].filter(Boolean).join(',');
    input.click();
  });
  input.addEventListener('change', () => { addAll(input.files); input.value = ''; });

  // Pasted files (e.g. a screenshot) attach; pasted text pastes as usual.
  pasteTarget.addEventListener('paste', (e) => {
    const files = e.clipboardData?.files;
    if (!files?.length) return;
    e.preventDefault();
    addAll(files);
  });

  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let depth = 0; // dragenter/leave fire for every child crossed
  dropTarget.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; dropTarget.classList.add('dropping'); } });
  dropTarget.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; dropTarget.classList.remove('dropping'); } });
  dropTarget.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  dropTarget.addEventListener('drop', (e) => {
    depth = 0;
    dropTarget.classList.remove('dropping');
    if (!hasFiles(e)) return;
    e.preventDefault();
    addAll(e.dataTransfer.files);
  });

  return {
    /** Resolves once every file still being read or compressed has finished (or failed). */
    ready: () => Promise.all(entries.map((e) => e.done)).then(() => {}),
    get count() { return entries.filter((e) => e.part).length; },
    /** Whether a file is still being read or compressed. */
    get pending() { return entries.some((e) => !e.part && !e.failed); },
    /** Empties the tray and returns its parts, in the order they were added. */
    take() {
      const parts = entries.filter((e) => e.part).map((e) => e.part);
      entries.filter((e) => e.part).forEach((e) => e.chip.remove());
      entries = entries.filter((e) => !e.part); // failed ones finish showing their error
      sync();
      return parts;
    },
    /** Puts parts back (Stop hands queued attachments back for editing). */
    restore(parts) {
      for (const part of parts) {
        const entry = { part, chip: null, done: Promise.resolve() };
        entry.chip = partChip(part, () => remove(entry));
        entries.push(entry);
        tray.append(entry.chip);
      }
      sync();
    },
  };
}

/** Thumbnails and file names for a sent message (no sizes or remove buttons). */
export function mediaRow(parts) {
  const row = el('div', 'msg-media');
  for (const p of parts) {
    if (p.type === 'image_url') {
      const img = el('img');
      img.src = p.image_url.url;
      img.alt = p.meta?.name || 'image';
      row.append(img);
    } else if (p.type === 'file') {
      const chip = el('div', 'chip');
      chip.append(el('span', 'chip-name chip-file', p.meta?.name || p.file.filename));
      row.append(chip);
    }
  }
  return row;
}

function partChip(part, onRemove) {
  const chip = el('div', 'chip');
  const name = part.meta?.name || 'attachment';
  if (part.type === 'image_url') {
    const img = el('img');
    img.src = part.image_url.url;
    img.alt = name;
    chip.append(img);
  } else {
    chip.append(el('span', 'chip-name chip-file', name));
  }
  const size = el('span', 'chip-size', formatBytes(part.meta?.bytes ?? 0));
  size.title = 'Sent with every request until cleared';
  const x = el('button', 'icon-btn', '×');
  x.type = 'button';
  x.title = `Remove ${name}`;
  x.setAttribute('aria-label', `Remove ${name}`);
  x.addEventListener('click', onRemove);
  chip.append(size, x);
  return chip;
}

/** Reads one file into a content part, or throws an Error whose message is shown on its chip. */
async function toPart(file, { caps, mime }) {
  const name = file.name || 'pasted file';
  const kind = classifyFile(file, caps);
  if (kind.error) throw new Error(kind.error);
  if (kind.kind === 'image') {
    const accept = (t) => t === 'image/jpeg' || t === 'image/png' || (caps.basalt && t === 'image/webp');
    const r = await compressImage(file, { mime, quality: IMAGE_QUALITY, acceptOriginal: accept });
    return {
      type: 'image_url', image_url: { url: r.dataUrl },
      meta: { kind: 'attachment', name, bytes: r.bytes, mime: r.mime, width: r.width, height: r.height },
    };
  }
  if (kind.kind === 'document') {
    const url = await readFile(() => readAsDataUrl(file));
    return { type: 'file', file: { filename: name, file_data: url }, meta: { kind: 'attachment', name, bytes: url.length, mime: file.type } };
  }
  const bytes = new Uint8Array(await readFile(() => file.arrayBuffer()));
  if (!looksLikeText(bytes)) {
    throw new Error(caps.documents ? 'Only images, text, PDF and Office files can be attached.' : 'Only images and text files can be attached.');
  }
  if (bytes.length > (caps.documents ? MAX_DOCUMENT_BYTES : MAX_INLINE_TEXT_BYTES)) {
    throw new Error(caps.documents ? "Files over 10 MB aren't supported." : "Text files over 100 KB can't be attached to this server.");
  }
  const url = await readAsDataUrl(file, 'text/plain');
  const meta = { kind: 'attachment', name, bytes: url.length, mime: 'text/plain' };
  // Kept for servers that can't read files: the text is then sent inline (see prepareHistory).
  if (bytes.length <= MAX_INLINE_TEXT_BYTES) meta.text = new TextDecoder().decode(bytes);
  return { type: 'file', file: { filename: name, file_data: url }, meta };
}

/** A dropped folder or an unreadable file rejects with a DOMException; say it plainly. */
async function readFile(read) {
  try {
    return await read();
  } catch {
    throw new Error("Couldn't read this file.");
  }
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}
