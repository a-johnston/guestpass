# Media attachments and page screenshots

Status: approach agreed; basalt probed (see Basalt probe results). Awaiting design approval.

## Intent

Two related abilities, mainly for models that can see images:

1. **Attachments.** Users attach images and files to a message via a "+" to the left of the
   message box.
2. **Screenshots.** The model can call a tool to see a rendered page. In one-shot prompts, models
   repeatedly named "can't see what I built" as the missing piece.

Primary target is a custom basalt fork (exposes rich model info over its API, streams llama.cpp
style). ninfer is a later, barebones target: it must degrade cleanly, not necessarily work fully.

The deciding cost is **upload time, not context**: Chat Completions is stateless, so the whole
history (every image and file in it) is re-sent on every request, including every tool round of a
turn. Over Funnel, 0.9 MB took ~34 s to send. Everything below keeps bytes on the wire small.

## Goals

- "+" button in the composer, always shown; file picker, paste, and drag-and-drop all add
  attachments.
- Attachments show as removable chips (thumbnail or file name, plus size) above the message box.
- Images are downscaled and compressed in the browser, then sent as `image_url` parts.
- Files go as `file` parts when the server reads documents (basalt), else text files are inlined
  as fenced blocks.
- A `screenshot` tool that returns an image of a widget or pane, offered only to vision models.
- A prominent "clear media" control next to the context counter showing what it would free.
- Works with basalt end to end; on servers that reject images or files, those switch off for the
  session with a notice (same mechanism as tools today).

## Non-goals

- **Video.** Basalt supports it (see probe results), but upload size makes it impractical without
  in-browser re-encoding. Deferred; see "Later: video".
- Server-side history (`previous_response_id` etc.): basalt's Responses API is stateless by
  design.
- Persistence: like the rest of the app, attachments live in memory only.
- Making ninfer fully work now.

## Anti-goals

- Weakening the iframe sandbox (no `allow-same-origin`, no same-origin re-render) to get pixels.
- A screenshot flow that needs a user click/permission prompt per capture (kills one-shot use).
- Silently re-uploading megabytes per request with no way for the user to see or stop it.
- Breaking existing share links or the no-build, no-dependency-manager setup.

## Constraints (from the code today)

- `api.js#listModels` keeps only `id` and context length; capability info must be added there
  and read from `/props` (`contextLengthFromProps` already fetches it).
- `state.messages` content is a string everywhere: `pushUser` merges consecutive user messages by
  string concat, `session.js` renders `content` as text, `enqueue`/`takeQueue` carry text only,
  Stop hands queued text back to the textarea. All need to handle content-part arrays or carry
  attachments alongside text.
- Frames are sandboxed with an opaque origin; the parent cannot read their pixels. Inactive pane
  tabs are `hidden` (display:none), so they have no layout to capture.
- `TOOL_DEFS` / `TOOL_SYSTEM_HINT` are deliberately terse and measured; additions stay minimal.
- `buildRequest`/`forServer` already rewrite history for the server (superseded HTML stubs);
  pruning and clearing belong there, with the local copy kept intact.
- Third-party code is vendored in `vendor/` with license headers.

## Approaches

### Taking the screenshot

- **(a) Rasterize inside the frame — chosen.** Vendor a small DOM-to-image library
  (html-to-image or similar). On a `screenshot` call the parent posts the library source to the
  frame; the bootstrap evaluates it, renders `document.documentElement` to a canvas, and posts back
  an encoded image. Keeps the sandbox intact and needs no user interaction. Trade-offs:
  cross-origin fonts/images may render imperfectly (no CORS for inlining); WebGL canvases come out
  blank unless created with `preserveDrawingBuffer`; Safari has historically tainted foreignObject
  renders.
- (b) `getDisplayMedia` tab capture. Pixel-perfect but prompts the user every time. Rejected.
- (c) Re-render the HTML in a same-origin hidden frame and capture that. Rejected: breaks the
  sandbox.

### Delivering the screenshot to the model

- **(a) Image parts inside the `role: "tool"` message.** Cleanest history; many servers reject it.
- **(b) Text tool result ("Screenshot attached below.") plus a following `role: "user"` message
  holding the image.** Works on any vision server.
- **Chosen: (a), falling back to (b)** via a new `FALLBACKS` entry. Basalt accepts (a).

### Getting media out of the history

- Clear video automatically after its turn (moot now video is deferred).
- **A visible clear control by the context counter — chosen.** The user decides when to pay the
  one-time prefix-cache miss; nothing the model might still need disappears on its own.

## Decisions

**Capability detection.** On connect, for the selected model:
- `vision`: `architecture.input_modalities` includes `"image"` on its `/models` entry, else
  `/props` `modalities.vision`. If neither is reported, assume on; the first rejected image
  request flips it off with a notice ("This model doesn't accept images…").
- `documents`: `/props` → `basalt.capabilities` includes `"documents"`. Off when absent.

**Composer.**
- "+" icon button left of the textarea opens a file input (`multiple`; `accept` from
  capabilities). Paste and drop onto the composer add files too.
- A chip row above the textarea: image thumbnails / file-name chips, each showing the size that
  will be sent, each with ×.
- Sending with attachments but no text is allowed.
- Queued messages carry `{text, attachments}`; the queue item shows a count; Stop hands both text
  and attachments back to the composer.

**Image compression** (attachments and screenshots alike).
- Basalt reads an image as 32 px tiles, one token each, up to 4,096 tokens (~4 MP); anything
  bigger is downscaled server-side, so sending more is pure waste.
- Guestpass caps images at **1 MP** (≈1,000 tokens on basalt; e.g. 1365×768, 1000×1000) and
  never upscales (*my call*: plenty for screenshots and most photos; raise later if detail
  suffers).
- Encoded as **WebP** when the server is basalt (decodes WebP via Pillow) and the browser can
  encode it (Safari's `toBlob` can't); else **JPEG** (llama.cpp's stb_image has no WebP).
  Transparent images are flattened onto white.
- **Quality is fixed at q=0.25**, with no option to raise it (user's call). Their tests (JPEG): a darktable photo 1.84 MB → 55 kB at
  q25 (106 kB at q75); a detailed photo 10.6 MB → 189 kB at q25 (993 kB at q75); a diagram/text
  screenshot 106 kB → 19 kB at q25 (28 kB at q75), artifacts visible but fine for a model.
- Every image is re-encoded, even small ones; the original bytes are sent only in the rare case
  they're smaller than the re-encode and in a format the server takes.
- Screenshots render at device-pixel-ratio 1 (CSS pixels), then go through the same cap.

**Documents and text files.**
- With `documents`: files go as `{type:"file", file:{filename, file_data}}` parts. Accepted: PDF,
  .docx, .pptx, .xlsx, and text-like files (`text/*`, JSON, YAML, XML, source code). Cap 10 MB per
  file on disk (*my call*, well under basalt's 64 MiB, since it's re-sent every request); the chip
  shows the on-the-wire size, which is ~4/3 of that because the body is base64 and uncompressed.
- Without it, or after a `file` part is rejected (fallback): a file counts as text if it decodes
  as UTF-8 with no NUL bytes, and is inserted into the message text as a fenced block headed by
  its filename (fence longer than any backtick run, as `session.js#fence` does), capped at ~100 KB
  (*my call*; larger is rejected, not silently truncated). Other binaries are rejected with a
  short message.

**Message shape.** A user message with attachments has `content` as an array:
`[{type:"text", text}, {type:"image_url", …}, {type:"file", …}…]`. Text-only messages stay
strings. `pushUser` merging handles strings, arrays, and mixed (normalize to an array when either
side has parts).

**`screenshot` tool.** `screenshot(id)` captures that widget or pane. Only in `TOOL_DEFS` when
vision is on. A hidden pane is brought to the front first so it has layout (the user sees the
model looking; *my call*). Captures the frame's visible area for panes and the full content for
inline widgets. The result text includes size and any caveat (e.g. "WebGL canvases may appear
blank unless created with preserveDrawingBuffer"); a failed capture returns `Error: …`. The tool
chip in the chat shows only the text result, no thumbnail (user's call).

**Automatic pruning.** In `buildRequest`, only the latest screenshot per page id is sent; older
ones become a text placeholder (`[earlier screenshot of "x" omitted]`), mirroring `forServer`.

**Clear media.** A button beside the context counter, shown only while there is something to
clear, e.g. `Clear media · 1.8 MB · ~3k tok`. Clicking it replaces, in what is sent from then on:
- every image and file part with a placeholder (`[image: photo.jpg — cleared]`,
  `[file: spec.pdf — cleared]`, `[screenshot of "app" — cleared]`);
- the HTML of every page render in tool-call history with a stub (as `omittedHtml` does today;
  the model can `read()` current source).
The chat display and session.md keep everything. MB is the exact size of what would be dropped;
tokens are estimated per item from the jump in `prompt_tokens` on the request that first carried
it (`~`, best effort; shown as MB only when usage isn't reported).

**Saving (Cmd/Ctrl+S).** session.md shows `[image: name.webp]` / `[file: name.pdf]` /
`[screenshot of "id"]` placeholders, not base64. Inlined text files are already in the text.

**Mock server.** `dev/mock_server.py` gains: vision and documents advertised the way basalt does;
replies that acknowledge received image/file parts; `--no-vision` (reject image parts),
`--no-tool-images` (reject images in tool messages), `--no-documents` (reject file parts).

**Tests.** Unit tests for the pure pieces: content merging, history pruning and clearing,
tool-image fallback shaping, text-file detection and fencing, size/token accounting for the clear
button, session.md placeholders.

## Basalt probe results (2026-11-13, basalt 0.3.3, Qwen-style template)

1. **Capabilities.** Per model in `/v1/models`: `architecture.input_modalities`
   (`["text","image","video"]`, OpenRouter-style). Server-wide in `/props`:
   `modalities: {vision, video}` and `basalt.capabilities` (`answer_now`, `logprobs`,
   `documents`, `video`).
2. **Images in tool messages work.** A `role: "tool"` message with
   `[{type:"text"}, {type:"image_url"}]` content was described correctly.
3. **PNG and JPEG data URLs both work.** A 128×128 image cost ~70 prompt tokens. Basalt also
   decodes WebP, GIF, AVIF and others via Pillow (`serve/engine/vision.py`).
4. **Image sizing.** 16 px patches merged 2×2 → 32 px per token, 8–4,096 tokens per image
   (`include/basalt/vision/preprocess.hpp`).
5. **Documents.** `{type:"file", file:{filename, file_data:"data:<mime>;base64,…"}}` works in
   user messages and tool results (verified with a text file and a CSV). Basalt reads PDF (text
   layer; scanned pages as images), .docx, .pptx, .xlsx, text/JSON/YAML/XML; 64 MiB max.
6. The `model` field must be an id basalt lists (unknown → 404); Guestpass already sends the first
   listed id.
7. No server-side history: `/v1/responses` refuses `previous_response_id`
   (`serve/api/responses.py`).

## Later: compressed request bodies

Request bodies go out uncompressed: browsers don't gzip `fetch` bodies on their own, and basalt's
handler reads the body raw (no `Content-Encoding` support, `serve/handler.py`). Base64 media would
shrink ~25% under gzip and page HTML/JSON several-fold, on every request. That needs a small basalt
change (decompress `Content-Encoding: gzip`, allow the header in CORS, advertise it in
`basalt.capabilities`); Guestpass would then compress with `CompressionStream('gzip')` when the
capability is present.

## Later: video

Basalt (Qwen3.8-Flash-Next, FFmpeg present) takes
`{type:"video_url", video_url:{url:"data:video/mp4;base64,…"}}`; `{type:"video"}` is rejected.
It samples 2 frames/s (4–768 frames; a part may set `fps` and `max_frames`), reads each pair of
frames as one picture, and scales all frames so the video fits `video-max-tokens` (default 8,192).
Measured prompt tokens: 10 s 360p (0.9 MB) 2,342; 30 s 360p (2.7 MB) 6,922; 30 s 720p (10 MB)
8,242; 120 s 720p (41 MB) 9,072. A long clip is therefore read at a few hundred pixels wide, so
most uploaded bytes are thrown away. The path to making it practical: re-encode in the browser
(WebCodecs plus a vendored MP4 demuxer/muxer) to roughly basalt's sampled frame rate and canvas
size before sending, likely ~40× smaller. A basalt-side alternative is content-addressed media
(send `sha256:…`, re-send bytes only on a miss).

## Left to the builder

- Choice of DOM-to-image library (small, vendorable, permissive license). Spike it first: confirm
  it works inside an opaque-origin sandboxed frame in Chrome and Safari before building on it.
- Chip, thumbnail, "+", and clear-button styling, consistent with the existing icon buttons.
- Error and placeholder wording, within the existing tone.
