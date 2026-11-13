# Media Attachments and Page Screenshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users attach images and files to messages, let vision models screenshot their own pages, and keep the re-sent history small (compressed images, a visible "clear media" control).

**Architecture:** Message `content` becomes either a string or an array of OpenAI content parts; parts carry a local-only `meta` object that is stripped before sending. A new pure module (`js/content.js`) shapes the history per request (screenshot pruning, clearing, capability fallbacks), so it is unit tested under Node like `session.js`. Screenshots are rasterized inside the sandboxed frame by a vendored DOM-to-image library posted in on demand; the parent compresses every image the same way.

**Tech Stack:** Plain ES modules, no build; `node --test`; vendored html-to-image (MIT); Python mock server.

**Spec:** `docs/superpowers/specs/2026-11-13-media-attachments-design.md`

## Global Constraints

- No build step, no package manager; third-party code goes in `vendor/` with its license header.
- Frames keep `sandbox="allow-scripts …"` without `allow-same-origin`. Nothing in this plan changes `SANDBOX` in `js/frames.js`.
- Images: at most `MAX_IMAGE_PIXELS = 1024 * 1024` pixels, never upscaled; WebP when the server is basalt and the browser can encode WebP, else JPEG; quality fixed at `0.25` (no option); transparent pixels flattened onto white; original bytes sent only if smaller than the re-encode and in an accepted format.
- Documents (server lists `"documents"`): `file` parts, max `10 * 1024 * 1024` bytes on disk. Inline text fallback: max `100 * 1024` bytes; larger is rejected, never truncated.
- Video is out of scope: video files are rejected like any other unsupported binary.
- `meta` never reaches the server; the local `state.messages` keeps everything (chat display and session.md are unaffected by pruning or clearing).
- `TOOL_DEFS`/`TOOL_SYSTEM_HINT` stay terse; the only addition is the `screenshot` tool, sent only when vision is not known to be off.
- All state in memory only, like the rest of the app.
- Commit messages follow the repo style (sentence-case imperative, no prefix) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A file the browser can't decode as an image (HEIC in Chrome, a corrupt PNG, a 60 MP panorama) → the chip shows a short error and nothing is sent; no exception escapes. (Task 5, manual step.)
2. Pasting plain text into the textarea still pastes text; only clipboard *files* become attachments. (Task 5, manual step.)
3. A page closed or replaced while a screenshot is in flight → the tool returns `Error: …` within the timeout; the turn doesn't hang. (Task 6, manual step.)
4. Several consecutive tool results that each carry a screenshot, under the tool-image fallback → tool messages stay contiguous and exactly one user message with all images follows them. (Task 3, unit test `fallback keeps tool messages contiguous`.)
5. Stop while a message with attachments is queued → text returns to the textarea and attachments return to the chip tray. (Task 5, manual step.)

---

### Task 1: Spike — rasterize a sandboxed frame (go/no-go)

Throwaway. Nothing from this task is committed except the vendored library and the spec/plan docs.

**Files:**
- Create: `vendor/html-to-image.js` (kept, if the spike passes)
- Scratch (not committed): `<scratchpad>/shot-spike/index.html`, `<scratchpad>/shot-spike/html-to-image.js`

- [ ] **Step 1: Branch and commit the docs**

```bash
git switch -c media-attachments
git add docs/superpowers/specs/2026-11-13-media-attachments-design.md docs/superpowers/plans/2026-11-13-media-attachments.md
git commit -m "Add design and plan for media attachments and screenshots"
```

- [ ] **Step 2: Fetch the library**

Download `https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js` (UMD; defines `window.htmlToImage`) into the scratch folder. Check the file starts with or contains the MIT license notice.

- [ ] **Step 3: Build the harness**

`index.html` creates an iframe with `sandbox="allow-scripts"` and a `srcdoc` containing: a heading and paragraph styled with a Google Font, a 2D `<canvas>` with a drawn shape, and a WebGL canvas cleared to a color. The srcdoc listens for `{type:'shot', lib}`; evaluates `lib` with `(0, eval)(lib)` if `window.htmlToImage` is undefined; calls `htmlToImage.toCanvas(document.documentElement, { pixelRatio: 1 })`; replies `{ok, dataUrl: canvas.toDataURL('image/png')}` or `{ok:false, error:String(e)}`. The parent fetches `html-to-image.js` as text, posts it, and shows the returned image under the frame.

- [ ] **Step 4: Run it in Chrome and Safari**

Run: `python3 -m http.server 8090` in the scratch folder; open `http://localhost:8090/` in Chrome, then ask the user to open it in Safari.
Pass: both browsers return an image showing the text and the 2D canvas (WebGL blank and font fallback are acceptable). Fail: an error (e.g. `SecurityError: tainted canvas`) in either browser.

- [ ] **Step 5: Decide**

Pass → copy `html-to-image.js` to `vendor/html-to-image.js`, prepend a one-line header in the style of the other vendored files (`/*! html-to-image 1.11.11 | MIT License | https://github.com/bubkoo/html-to-image */` if not already present), commit:

```bash
git add vendor/html-to-image.js
git commit -m "Vendor html-to-image for page screenshots"
```

Fail in Safari only → stop and ask the user whether Chrome-only screenshots are acceptable (Safari would return `Error: screenshots aren't supported in this browser.`). Fail in Chrome → stop and report; try `modern-screenshot` the same way before giving up.

---

### Task 2: Capability detection

**Files:**
- Modify: `js/api.js` (`listModels`, `contextLengthFromProps`)
- Modify: `js/main.js:111-140` (`connect`)
- Modify: `dev/mock_server.py` (`do_GET`, new flags)
- Test: `test/api.test.js` (create)

**Interfaces:**
- Produces: `listModels(...) -> Promise<{id, contextLength, inputModalities: string[]|null}[]>`
- Produces: `fetchProps({baseUrl, apiKey}) -> Promise<object|null>` (replaces `contextLengthFromProps`; best effort, `null` on any failure)
- Produces: `capabilitiesFrom(model, props) -> {vision: boolean|null, documents: boolean, basalt: boolean, contextLength: number|null}`
- Produces: `state.caps = {vision, documents, basalt}` in `main.js`, set in `connect()`; initial value `{vision: null, documents: false, basalt: false}`.

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesFrom } from '../js/api.js';

test('vision from the model entry wins over /props', () => {
  const caps = capabilitiesFrom({ inputModalities: ['text'] }, { modalities: { vision: true } });
  assert.equal(caps.vision, false);
});
test('vision falls back to /props modalities, else unknown', () => {
  assert.equal(capabilitiesFrom({ inputModalities: null }, { modalities: { vision: true } }).vision, true);
  assert.equal(capabilitiesFrom({ inputModalities: null }, null).vision, null);
});
test('documents and basalt come from props.basalt', () => {
  const caps = capabilitiesFrom({}, { basalt: { version: '0.3.3', capabilities: ['answer_now', 'documents'] } });
  assert.deepEqual([caps.documents, caps.basalt], [true, true]);
  assert.deepEqual([capabilitiesFrom({}, {}).documents, capabilitiesFrom({}, {}).basalt], [false, false]);
});
test('context length: model entry, then props n_ctx', () => {
  assert.equal(capabilitiesFrom({ contextLength: 4096 }, { default_generation_settings: { n_ctx: 8192 } }).contextLength, 4096);
  assert.equal(capabilitiesFrom({ contextLength: null }, { default_generation_settings: { n_ctx: 8192 } }).contextLength, 8192);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/api.test.js` — Expected: FAIL (`capabilitiesFrom` is not exported).

- [ ] **Step 3: Implement in `js/api.js`**

`listModels` also maps `inputModalities: Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : null`. `fetchProps` is today's `contextLengthFromProps` fetch returning the whole JSON. `capabilitiesFrom` reads `inputModalities.includes('image')`, else `props?.modalities?.vision` (boolean), else `null`; `documents` from `props?.basalt?.capabilities?.includes('documents')`; `basalt` = `!!props?.basalt`; context length = `model.contextLength` else a positive finite `props.default_generation_settings.n_ctx`.

- [ ] **Step 4: Use it in `connect()`**

Fetch props once after models; set `state.caps` and `state.context.max` from `capabilitiesFrom(models[0] ?? {}, props)`.

- [ ] **Step 5: Mock server**

`/models` entries gain `"architecture": {"input_modalities": ["text", "image"]}` (only `["text"]` with `--no-vision`). New `GET …/props` (path ends with `/props`, at the server root like llama.cpp) returns `{"default_generation_settings": {"n_ctx": 8192}, "modalities": {"vision": <not no_vision>}, "basalt": {"version": "mock", "capabilities": ["documents"] unless --no-documents}}`. Add argparse flags `--no-vision`, `--no-documents`, `--no-tool-images` (the last two used in Task 5) and the class attributes behind them; document them in the module docstring.

- [ ] **Step 6: Run all tests**

Run: `node --test test/` — Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add js/api.js js/main.js dev/mock_server.py test/api.test.js
git commit -m "Detect image and document support from /models and /props"
```

---

### Task 3: Message content and history shaping

**Files:**
- Create: `js/content.js`
- Modify: `js/session.js` (user/tool content may be arrays; `fence` moves to `content.js`)
- Test: `test/content.test.js` (create), `test/session.test.js` (add cases)

**Interfaces:**
- Part shapes (local): `{type:'text', text}`, `{type:'image_url', image_url:{url}, meta}`, `{type:'file', file:{filename, file_data}, meta}`.
- `meta`: `{kind: 'attachment'|'screenshot', name: string, bytes: number, mime: string, pageId?: string, width?: number, height?: number, text?: string}` — `bytes` is the data URL's length (what goes on the wire); `text` is present for text files ≤ 100 KB.
- Produces: `export function fence(text, lang = '')` (moved from `session.js`, same behavior).
- Produces: `mergeContent(a: string|Part[], b: string|Part[]) -> string|Part[]` — two strings join with `\n\n`; otherwise both become part arrays and concatenate.
- Produces: `contentText(content, {placeholders = false} = {}) -> string` — the text parts joined with `\n\n`; with `placeholders`, media parts appear in order as `[image: name]`, `[file: name]`, `[screenshot of "pageId"]`.
- Produces: `mediaLabel(part) -> string` — `image: name` / `file: name` / `screenshot of "pageId"` (used by placeholders here and in Task 7).
- Produces: `prepareHistory(messages, {vision, documents, toolImages, clearedBefore}) -> messages` — pure; returns new objects, never mutates its input. `vision` is `true|false|null` (null = unknown, treated as on).

Rules `prepareHistory` applies, in this order (exact placeholder copy):
1. Message index `< clearedBefore`: every image/file part → `{type:'text', text:`[${mediaLabel(p)} — cleared from history]`}`.
2. Screenshot parts: only the last one per `meta.pageId` across the history stays; earlier ones → `[earlier screenshot of "${pageId}" omitted; a newer one follows]`.
3. `vision === false`: remaining image parts → `[${mediaLabel(p)} — not sent, this model can't see images]`.
4. `documents === false`: file parts with `meta.text` → a text part `` `${meta.name}:\n${fence(meta.text)}` ``; other file parts → `[file: ${name} — not sent, this server can't read it]`.
5. `toolImages === false`: a tool message with image parts keeps only its text, plus `\n(Image attached in the next message.)`; after the run of consecutive tool messages, one user message `[{type:'text', text:'Images returned by the tool calls above:'}, …all those images]` is inserted; if a user message already follows the run, the images are merged into it with `mergeContent`.
6. A part array that is now only text parts collapses to a string (joined with `\n\n`); every `meta` is removed.

- [ ] **Step 1: Write the failing tests** (`test/content.test.js`)

Helper in the test: `img(name, extra)` → `{type:'image_url', image_url:{url:'data:image/webp;base64,AAAA'}, meta:{kind:'attachment', name, bytes:27, mime:'image/webp', ...extra}}`; `shot(pageId)` → same with `kind:'screenshot', name:'shot', pageId`.

```js
test('mergeContent joins strings and promotes to parts', () => {
  assert.equal(mergeContent('a', 'b'), 'a\n\nb');
  assert.deepEqual(mergeContent('a', [img('x.png')]), [{ type: 'text', text: 'a' }, img('x.png')]);
});
test('contentText with placeholders', () => {
  assert.equal(contentText([{ type: 'text', text: 'see' }, img('x.png'), shot('app')], { placeholders: true }),
    'see\n\n[image: x.png]\n\n[screenshot of "app"]');
});
test('strips meta and leaves the input untouched', () => {
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'hi' }, img('x.png')] }];
  const out = prepareHistory(msgs, { vision: true, documents: true, toolImages: true, clearedBefore: 0 });
  assert.equal(out[0].content[1].meta, undefined);
  assert.ok(msgs[0].content[1].meta, 'local copy keeps meta');
});
test('only the latest screenshot per page is sent', () => { /* two tool msgs with shot('app'), one with shot('b'): first app → '[earlier screenshot of "app" omitted; a newer one follows]', others kept */ });
test('clearedBefore replaces media before the watermark', () => { /* index 0 image → '[image: x.png — cleared from history]' (content collapses to a string); index 2 image kept */ });
test('vision off replaces images', () => { /* → '[image: x.png — not sent, this model can\'t see images]' */ });
test('documents off inlines text files and drops others', () => { /* meta.text 'a = 1' → 'notes.py:\n```\na = 1\n```'; a pdf → '[file: spec.pdf — not sent, this server can\'t read it]' */ });
test('fallback keeps tool messages contiguous', () => {
  // assistant with two tool_calls, then tool(c1, [text, shot('a')]), tool(c2, [text, shot('b')]), then nothing
  // → roles: assistant, tool, tool, user; tool contents are strings ending '(Image attached in the next message.)';
  //   the user content is [text 'Images returned by the tool calls above:', image a, image b]
});
test('fallback merges into a following user message', () => { /* tool with image, then user 'next' → one user message: [text 'Images returned…', image, text 'next'] */ });
```

Write each commented case out fully with `assert.deepEqual` on the resulting `role`/`content`.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/content.test.js` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `js/content.js`**

Pure, no DOM, no imports from modules that touch `window`.

- [ ] **Step 4: session.md**

In `session.js`, import `fence` and `contentText` from `content.js`. User content → `contentText(m.content, {placeholders: true})`; a tool result whose content is an array → the same, so a screenshot result reads `Screenshot of "app" (800×600).\n\n[screenshot of "app"]`. Add to `test/session.test.js`:

```js
test('media becomes placeholders, never base64', () => {
  const md = sessionToMarkdown([{ role: 'user', content: [{ type: 'text', text: 'look' },
    { type: 'image_url', image_url: { url: 'data:image/webp;base64,QUJD' }, meta: { kind: 'attachment', name: 'cat.webp' } }] }], { savedAt });
  assert.match(md, /## User\n\nlook\n\n\[image: cat\.webp\]\n/);
  assert.doesNotMatch(md, /base64/);
});
```

- [ ] **Step 5: Run all tests**

Run: `node --test test/` — Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add js/content.js js/session.js test/content.test.js test/session.test.js
git commit -m "Shape message content parts and media history per request"
```

---

### Task 4: File classification and image compression

**Files:**
- Create: `js/media.js`
- Test: `test/media.test.js` (create)

**Interfaces:**
- Produces constants: `MAX_IMAGE_PIXELS = 1024 * 1024`, `MAX_DOCUMENT_BYTES = 10 * 1024 * 1024`, `MAX_INLINE_TEXT_BYTES = 100 * 1024`, `IMAGE_QUALITY = 0.25`.
- Produces: `fitWithin(w, h, maxPixels = MAX_IMAGE_PIXELS) -> {width, height}` — scale `min(1, sqrt(maxPixels / (w*h)))`, floor, each side ≥ 1.
- Produces: `classifyFile({name, type, size}, {vision, documents}) -> {kind: 'image'|'document'|'text'} | {error: string}`.
- Produces: `looksLikeText(bytes: Uint8Array) -> boolean` — valid UTF-8 (`TextDecoder('utf-8', {fatal: true})`) and no `0x00` byte.
- Produces: `imageTokens(width, height) -> number` — `clamp(ceil(w/32) * ceil(h/32), 8, 4096)` (basalt geometry; an estimate elsewhere).
- Produces: `pickImageMime({basalt, canWebp}) -> 'image/webp'|'image/jpeg'`.
- Produces (DOM, browser only): `canEncodeWebp() -> boolean` (cached; a 1×1 canvas's `toDataURL('image/webp')` starts with `data:image/webp`), `compressImage(source: Blob|string, {mime, quality, acceptOriginal = () => false}) -> Promise<{dataUrl, mime, width, height, bytes}>` — decode with `createImageBitmap` (data URL strings go through `fetch(...).blob()` first), draw at `fitWithin` size onto a white-filled canvas, encode with `toBlob(mime, quality)`, read as a data URL; if `source` is a Blob, within `MAX_IMAGE_PIXELS`, `acceptOriginal(source.type)` is true and `source.size` is smaller than the re-encode, return the original instead. Rejects with `Error("Couldn't read this image.")` when decoding fails.
- Produces: `readAsDataUrl(blob, mime?) -> Promise<string>` (FileReader; `mime` overrides the blob's type in the prefix).

`classifyFile` rules (error copy exact):
- Extension/type is video (`video/*`, `.mp4 .mov .webm .mkv .avi`) → `{error: 'Video isn\'t supported yet.'}`.
- `image/svg+xml` or `.svg` → treated as text (below).
- Other `image/*` → `vision === false` ? `{error: 'This model can\'t see images.'}` : `{kind: 'image'}`.
- `.pdf .docx .pptx .xlsx` (or their MIME types) → `documents` ? (`size > MAX_DOCUMENT_BYTES` ? `{error: 'Files over 10 MB aren\'t supported.'}` : `{kind: 'document'}`) : `{error: 'This server can\'t read PDF or Office files.'}`.
- Anything else → `{kind: 'text'}`; the caller then checks `looksLikeText` (fail → `{error: 'Only images, text, PDF and Office files can be attached.'}`, or without `documents` support `'Only images and text files can be attached.'`) and size: `documents` ? `MAX_DOCUMENT_BYTES` : `MAX_INLINE_TEXT_BYTES` (→ `'Text files over 100 KB can\'t be attached to this server.'`).

- [ ] **Step 1: Write the failing tests**

```js
test('fitWithin caps pixels and never upscales', () => {
  assert.deepEqual(fitWithin(4000, 3000), { width: 1182, height: 886 });
  assert.deepEqual(fitWithin(640, 480), { width: 640, height: 480 });
});
test('imageTokens follows 32 px tiles within 8..4096', () => {
  assert.equal(imageTokens(128, 128), 16);
  assert.equal(imageTokens(1182, 886), 37 * 28);
  assert.equal(imageTokens(10, 10), 8);
});
test('classifyFile', () => {
  const caps = { vision: true, documents: true };
  assert.deepEqual(classifyFile({ name: 'a.jpg', type: 'image/jpeg', size: 9 }, caps), { kind: 'image' });
  assert.deepEqual(classifyFile({ name: 'a.jpg', type: 'image/jpeg', size: 9 }, { ...caps, vision: false }), { error: "This model can't see images." });
  assert.deepEqual(classifyFile({ name: 'logo.svg', type: 'image/svg+xml', size: 9 }, caps), { kind: 'text' });
  assert.deepEqual(classifyFile({ name: 'clip.mp4', type: 'video/mp4', size: 9 }, caps), { error: "Video isn't supported yet." });
  assert.deepEqual(classifyFile({ name: 'p.pdf', type: 'application/pdf', size: 11 * 1024 * 1024 }, caps), { error: "Files over 10 MB aren't supported." });
  assert.deepEqual(classifyFile({ name: 'p.pdf', type: 'application/pdf', size: 9 }, { ...caps, documents: false }), { error: "This server can't read PDF or Office files." });
  assert.deepEqual(classifyFile({ name: 'x.ts', type: 'video/mp2t', size: 9 }, caps), { kind: 'text' }, '.ts is TypeScript, not video');
});
test('looksLikeText', () => {
  assert.equal(looksLikeText(new TextEncoder().encode('héllo')), true);
  assert.equal(looksLikeText(new Uint8Array([0x68, 0x00, 0x69])), false);
  assert.equal(looksLikeText(new Uint8Array([0xff, 0xfe, 0x41])), false);
});
test('pickImageMime', () => {
  assert.equal(pickImageMime({ basalt: true, canWebp: true }), 'image/webp');
  assert.equal(pickImageMime({ basalt: true, canWebp: false }), 'image/jpeg');
  assert.equal(pickImageMime({ basalt: false, canWebp: true }), 'image/jpeg');
});
```

The `.ts` case pins that video detection is by extension list first: `.ts` is not in the video list, so a `video/mp2t` type alone must not make it video.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/media.test.js` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `js/media.js`**

DOM functions must not run at import time, so the module imports cleanly under Node.

- [ ] **Step 4: Run all tests**

Run: `node --test test/` — Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add js/media.js test/media.test.js
git commit -m "Classify attachable files and compress images in the browser"
```

---

### Task 5: Composer attachments end to end

**Files:**
- Create: `js/attachments.js`
- Modify: `index.html` (composer), `css/app.css` (composer section), `js/main.js` (composer, queue, `pushUser`, `addUserMessage`, `buildRequest`, `FALLBACKS`, `runTurn` fallback handling)
- Modify: `dev/mock_server.py` (`respond`, `do_POST` rejections), `README.md` (mock flags)

**Interfaces:**
- Consumes: Task 2 `state.caps`; Task 3 `mergeContent`, `contentText`, `prepareHistory`; Task 4 everything.
- Produces: `createAttachmentTray({tray, input, button, dropTarget, getOptions, onError}) -> {items(): Part[], take(): Part[], restore(parts: Part[]), get pending(): boolean}` — `getOptions()` returns `{caps, mime}`; `pending` is true while a file is still being read/compressed (Send waits for it or is disabled).
- Produces in `main.js`: `state.toolImages = true`; `imageMime() -> pickImageMime({basalt: state.caps.basalt, canWebp: canEncodeWebp()})`; `buildRequest() -> {body, used: {images, toolImages, files}}`; queue items `{text, parts, el}`; `pushUser(text, parts = [])`.
- Produces: `userContent(text, parts) -> string|Part[]` (in `content.js`, added in this task with a test: no parts → the string; else `[{type:'text', text}, ...parts]`, omitting the text part when `text` is empty).

- [ ] **Step 1: Write the failing test** for `userContent` in `test/content.test.js`; run `node --test test/content.test.js`, expect FAIL; implement; expect PASS.

- [ ] **Step 2: Markup and styles**

`index.html`: inside `#composer`, before `.prompt-wrap`, a `button#attach-btn.icon-btn` (`aria-label="Attach files"`, `title="Attach files"`, text `+`) and `<input type="file" id="attach-input" multiple hidden>`. Above the form (sibling before `#composer`, after `#queue`): `<div id="attachments" class="attachments" hidden></div>`.
`css/app.css`: chip row aligned with the composer (same `max-width: 892px` and padding as `#queue`); chips show a 40 px thumbnail or a file-name label, the size (`formatBytes`, below), and a × button; a chip in error state uses `--danger`; the `+` button matches `#send-btn` height. Add `formatBytes(n) -> string` to `media.js` with a test (`950` → `950 B`, `55_000` → `54 KB`, `1_900_000` → `1.8 MB`; KB/MB are 1024-based, KB rounded, MB one decimal).

- [ ] **Step 3: `js/attachments.js`**

Picker (`button` → `input.click()`, `accept` = `image/*` when vision isn't false, plus `.pdf,.docx,.pptx,.xlsx` when documents, plus `text/*,.md,.json,.csv,.yaml,.yml,.xml,.js,.ts,.py,.html,.css,.svg` — the accept list is a hint only; `classifyFile` decides). Paste on the textarea: only when `clipboardData.files.length` → `preventDefault` and add the files; otherwise do nothing. Drag-over/drop on `dropTarget` (the composer column) adds files. Per file: `classifyFile` → image: `compressImage(file, {mime, quality: IMAGE_QUALITY, acceptOriginal})` where `acceptOriginal` accepts `image/jpeg`, `image/png`, and `image/webp` when `caps.basalt` → `image_url` part with `meta {kind:'attachment', name, bytes: dataUrl.length, mime, width, height}`; document → `readAsDataUrl(file)` → `file` part `{filename: name, file_data}`; text → read bytes, `looksLikeText`, size check, then `readAsDataUrl(file, 'text/plain')` → `file` part with `meta.text` (decoded) when ≤ `MAX_INLINE_TEXT_BYTES`. Errors show on a chip for 4 s, then the chip removes itself; nothing is added.

- [ ] **Step 4: Wire into `main.js`**

Submit: text or parts required (was: text required). `pushUser(text, parts)` merges via `mergeContent(last.content, userContent(text, parts))`. `addUserMessage(text, parts)` renders the text and a row of thumbnails (`<img>` from the data URL) / file-name chips. `enqueue(text, parts)` shows `+N attachments` in the queue item; `takeQueue()` returns `{text, parts}[]`; the Stop path restores texts to the textarea and `tray.restore(parts)` for all queued parts. `buildRequest` maps tool calls as today, then `prepareHistory(history, {vision: state.caps.vision, documents: state.caps.documents, toolImages: state.toolImages, clearedBefore: 0})` (Task 7 replaces the `0`), and computes `used` from the prepared history. `FALLBACKS` entries gain `when(used)`; `fallbackFor(err, used)` requires both `when` and `match`. New entries, before the existing ones, in this order:
  - `{key: 'toolImages', when: (u) => u.toolImages, match: /image|content|multimodal|array/i}` (no notice; the fallback form works the same for the model)
  - `{key: 'documents', set: ['caps', 'documents'], when: (u) => u.files, match: /file|document|content|type/i, notice: 'This server can’t read attached files, so text files are sent inline and other files are skipped.'}`
  - `{key: 'vision', set: ['caps', 'vision'], when: (u) => u.images, match: /image|vision|multimodal|mmproj/i, notice: 'This model doesn’t accept images, so images and screenshots are off for this session.'}`
  The handler switches off `state[key]`, or `state.caps[name]` when `set` is given. The tray's `getOptions` returns `{caps: state.caps, mime: imageMime()}`.

- [ ] **Step 5: Mock server**

User text is now `contentText`-like: join `text` parts of array content (keep scripted keys working). The echo reply adds a line `Received: N image(s), M file(s)` when any were present. Rejections (400, before streaming): `--no-vision` and any `image_url` part → `"image input is not supported by this model"`; `--no-tool-images` and an `image_url` part in a `tool` message → `"tool message content must be a string"`; `--no-documents` and any `file` part → `"unsupported content part type: file"`. Update the docstring and README's mock-server paragraph with the three flags.

- [ ] **Step 6: Run unit tests**

Run: `node --test test/` — Expected: all PASS.

- [ ] **Step 7: Verify in the browser against the mock**

Run `python3 -m http.server 8080` and `python3 dev/mock_server.py --key sk-test`; connect. Check: attach a photo via +, paste a screenshot, drop a `.py` file → chips with sizes; send → bubble shows thumbnails/file chip; reply says `Received: 2 image(s), 1 file(s)`. Paste plain text → it pastes as text (Review Focus 2). Attach a `.heic` in Chrome or a renamed garbage `.png` → chip error, nothing sent (Review Focus 1). Send "slow", then queue a message with an image, press Stop → text back in the textarea, image back in the tray (Review Focus 5). Restart the mock with `--no-documents` → attach `.py` and send → notice, reply still arrives and the mock received the file inline (its echo shows the fenced text). Restart with `--no-vision` → `+` still works for text; images are rejected at attach time.

- [ ] **Step 8: Commit**

```bash
git add index.html css/app.css js/attachments.js js/content.js js/media.js js/main.js dev/mock_server.py README.md test/
git commit -m "Attach images and files to messages"
```

---

### Task 6: Screenshot tool

**Files:**
- Modify: `js/srcdoc.js` (bootstrap handles `screenshot`), `js/frames.js` (`captureFrame`), `js/panes.js` (`focus`), `js/tools.js` (`SCREENSHOT_DEF`, `toolDefs`, `runTool` result shape), `js/main.js` (tool loop, `buildRequest` tools)
- Modify: `dev/mock_server.py` (after a tool result with an image, the summary says `The tool returned an image.`)
- Test: `test/srcdoc.test.js` (add a case)

**Interfaces:**
- Consumes: Task 4 `compressImage`, `pickImageMime`, `canEncodeWebp`, `IMAGE_QUALITY`; Task 3 part/`meta` shape.
- Produces: frame protocol — parent → frame `{type:'screenshot', reqId, lib, viewport: boolean}`; frame → parent `{type:'screenshot-result', reqId, ok, dataUrl?, width?, height?, hasCanvas?, error?}`.
- Produces: `captureFrame(id, {viewport}) -> Promise<{ok:true, dataUrl, width, height, hasCanvas} | {ok:false, error}>` in `frames.js`; loads `vendor/html-to-image.js` once via `fetch(...).text()` and caches the source; times out after `10000` ms with `{ok:false, error:'no reply within 10s'}`; resolves `{ok:false, error:'the page was closed'}` if the frame is removed meanwhile.
- Produces: `panes.focus(id)` — activates that tab and shows the aside.
- Produces: `toolDefs({vision}) -> TOOL_DEFS` plus `SCREENSHOT_DEF` unless `vision === false`. `SCREENSHOT_DEF = fn('screenshot', 'See a page as an image, as the user sees it.', { id: idParam }, ['id'])`.
- Produces: `runTool` may return `{text: string, images: {dataUrl: string, meta: object}[]}` instead of a string; `ui.capture(id) -> Promise<…captureFrame result>` is supplied by main.

- [ ] **Step 1: Write the failing test** (`test/srcdoc.test.js`)

```js
test('bootstrap answers screenshot requests', () => {
  const doc = buildSrcdoc('<p>x</p>');
  assert.match(doc, /m\.type === 'screenshot'/);
  assert.match(doc, /screenshot-result/);
});
```

Run: `node --test test/srcdoc.test.js` — Expected: FAIL.

- [ ] **Step 2: Bootstrap handler in `srcdoc.js`**

In the existing `message` listener: on `screenshot`, if `window.htmlToImage` is undefined evaluate `m.lib` with `(0, eval)`; `htmlToImage.toCanvas(document.documentElement, {pixelRatio: 1})`; when `m.viewport`, crop to `innerWidth × innerHeight` at `scrollX/scrollY` onto a new canvas; reply with `toDataURL('image/png')`, size, and `hasCanvas: !!document.querySelector('canvas')`; on any error reply `ok:false, error: fmt(e)`. Keep the bootstrap on one line as `buildSrcdoc` requires (no `//` comments).

- [ ] **Step 3: `captureFrame`, `panes.focus`, tool**

`runTool('screenshot')`: unknown id → `Error: no widget or pane with id "…"` (same wording as `edit`). Pane → `ui.panes.focus(id)`, wait two animation frames, capture with `viewport: true`; widget → `viewport: false`. Failure → `Error: screenshot failed: ${error}`. Success → `compressImage(dataUrl, {mime: ui.imageMime(), quality: IMAGE_QUALITY})`, text `` `Screenshot of "${id}" (${width}×${height}).` `` plus, when `hasCanvas`, ` WebGL canvases may be blank unless created with preserveDrawingBuffer: true.`; image `meta {kind:'screenshot', name:`${id}.webp|jpg`, pageId: id, bytes, mime, width, height}`.

- [ ] **Step 4: Main tool loop**

`const text = typeof output === 'string' ? output : output.text;` the tool message content is `text` or `[{type:'text', text}, ...images as image_url parts]`. `chip.done(text)` as today (no thumbnail). Error checks (`startsWith('Error:')`) use `text`. `buildRequest` sends `toolDefs({vision: state.caps.vision})`.

- [ ] **Step 5: Run unit tests**

Run: `node --test test/` — Expected: all PASS.

- [ ] **Step 6: Verify in the browser**

Mock: send `pane`, then `call:{"name":"screenshot","args":{"id":"bouncer"}}` → the chip shows `Screenshot of "bouncer" (W×H).`; the reply says `The tool returned an image.` Open two panes, switch to the other tab, screenshot the first → it comes to the front. Send `call:{"name":"screenshot","args":{"id":"bouncer"}}` and immediately close the pane → tool result `Error: screenshot failed: the page was closed` within 10 s (Review Focus 3). Restart mock with `--no-tool-images`, screenshot again → no notice; the reply still arrives (fallback form). Repeat the first check in Safari.

- [ ] **Step 7: Commit**

```bash
git add js/srcdoc.js js/frames.js js/panes.js js/tools.js js/main.js dev/mock_server.py test/srcdoc.test.js
git commit -m "Let vision models screenshot widgets and panes"
```

---

### Task 7: Clear media control

**Files:**
- Modify: `js/content.js` (`clearableSummary`), `js/main.js` (`state.clearedBefore`, `forServer`, topbar button), `index.html` (button by `#ctx`), `css/app.css`
- Test: `test/content.test.js` (add cases)

**Interfaces:**
- Consumes: Task 3 `prepareHistory`, part `meta`; Task 4 `imageTokens`, `formatBytes`; `RENDER_TOOLS` (pass the names in, don't import `tools.js`).
- Produces: `clearableSummary(messages, {clearedBefore, renderTools: Set<string>, charsPerToken}) -> {bytes: number, tokens: number, items: number}`.
- Produces: `state.clearedBefore = 0`; clicking the button sets it to `state.messages.length`.

`clearableSummary` counts, for messages at index ≥ `clearedBefore`: image parts that `prepareHistory` would still send (i.e. not an older screenshot of the same page) → `bytes += meta.bytes`, `tokens += imageTokens(meta.width, meta.height)`; file parts → `bytes += meta.bytes`, `tokens += meta.text ? round(meta.text.length / charsPerToken) : 0`; render tool calls not marked `superseded` → `bytes += html.length`, `tokens += round(html.length / charsPerToken)`. `items` counts each of these.

- [ ] **Step 1: Write the failing tests**

```js
test('clearableSummary counts sendable media and live page HTML', () => {
  // msgs: user [text, img 800x600 bytes 30000], assistant tool_calls [inline html 'x'.repeat(4000)],
  //       tool [text, shot('a') 1024x768 bytes 20000], tool [text, shot('a') 1024x768 bytes 21000]
  const s = clearableSummary(msgs, { clearedBefore: 0, renderTools: new Set(['inline', 'pane']), charsPerToken: 4 });
  assert.deepEqual(s, { bytes: 30000 + 4000 + 21000, tokens: 475 + 1000 + 768, items: 3 });
});
test('nothing before the watermark counts', () => { /* same msgs, clearedBefore = msgs.length → {bytes:0, tokens:0, items:0} */ });
```

(`imageTokens(800, 600)` = 25 × 19 = 475; `imageTokens(1024, 768)` = 32 × 24 = 768.)

Run: `node --test test/content.test.js` — Expected: FAIL.

- [ ] **Step 2: Implement `clearableSummary`**; run, expect PASS.

- [ ] **Step 3: Wire the control**

`index.html`: `<button type="button" id="clear-media" class="ctx-btn" hidden></button>` right after `#ctx`. Label `` `Clear media · ${formatBytes(bytes)} · ~${formatTokens(tokens)} tok` `` (omit the token part when `tokens` is 0); `title="Stop re-sending images, files and page HTML with every request. The chat keeps them."`. Hidden when `bytes === 0`. Refresh it wherever `updateContext()` runs and after each message push. Click → `state.clearedBefore = state.messages.length`, refresh, and add a `notice('Cleared media from what is sent to the model. The chat still shows it.')`. `buildRequest` passes `clearedBefore: state.clearedBefore`; `forServer(call, cleared)` stubs the HTML when `superseded || cleared`, where `cleared` = the message index `< state.clearedBefore`. The stub uses a new `clearedHtml(id)` beside `omittedHtml` in `tools.js`: `` `${OMITTED_MARKER}: cleared from history. Use read("${id}") for the current source.]` `` (keeps `OMITTED_MARKER` so `checkHtml` still rejects it as page source).

- [ ] **Step 4: Verify in the browser**

Mock: attach an image, send; send `inline` → button shows e.g. `Clear media · 31 KB · ~500 tok`. Click → button hides, notice appears; send another message and confirm in DevTools (Network → request payload) the image is `[image: … — cleared from history]` and the widget HTML is the cleared stub; the chat still shows both.

- [ ] **Step 5: Run all tests and commit**

Run: `node --test test/` — Expected: all PASS.

```bash
git add js/content.js js/main.js js/tools.js index.html css/app.css test/content.test.js
git commit -m "Add a control to clear media from the re-sent history"
```

---

### Task 8: Verify against basalt and document

**Files:**
- Modify: `README.md`

- [ ] **Step 1: End to end on basalt**

Connect the app (served locally) to `https://whatdesktop.tailc9a2bb.ts.net/v1` with key `321` (local testing only; never commit the URL or key). Check: a photo attachment is described correctly and its chip size is in the tens of KB; a PDF or `.py` file is read (`file` part, no notice); "Build a small canvas game in a pane, then take a screenshot and describe it" → the model calls `screenshot` and describes the page; the clear button reports a plausible size and works. Note any server error text and, if a fallback fired unexpectedly, fix its `match`.

- [ ] **Step 2: README**

One short paragraph under the intro: attachments (+, paste, drop; images compressed in the browser; PDF/Office via basalt's documents support, text files otherwise), the `screenshot` tool for vision models, and the Clear media control. Mock-server paragraph already updated in Task 5.

- [ ] **Step 3: Full test run and commit**

Run: `node --test test/` — Expected: all PASS.

```bash
git add README.md
git commit -m "Document attachments, screenshots and clearing media"
```
