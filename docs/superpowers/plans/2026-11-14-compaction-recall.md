# Deterministic Compaction with Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Long agentic turns stay inside the context window: Guestpass compacts the history it sends in rare, frozen steps (per-kind weighted budgets, deterministic stubs), and the model gets anything compacted back with a `recall` tool.

**Architecture:** Three new pure modules, unit tested under Node: `js/items.js` splits the local history into addressable items (ids, kinds, sizes, notes), `js/compact.js` turns the history into a compacted, frozen copy plus the trigger and window-learning helpers, and `js/recall.js` answers `recall` calls from the full local history. `js/main.js` keeps `state.compaction = {messages, upTo}` and sends `[...frozen, ...live messages after upTo]`, so between compactions the history only grows at the end on every server. Today's live trims (older screenshots, superseded page HTML, current-turn-only thinking) move into the compaction.

**Tech Stack:** Static ES modules, no build, no dependencies; `node --test test/`; `dev/mock_server.py` (Python stdlib).

**Spec:** `docs/superpowers/specs/2026-11-14-compaction-recall-design.md`

## Global Constraints

- No build step, no package manager, no new dependencies. Logic lives in pure modules (no DOM, no `state`, no import of `frames.js`) with Node tests; `js/main.js` only wires them.
- Token figures are `estimateTokens` units (chars/4, images 1024) unless they come from the server's usage report.
- Trigger: context used ≥ **60%** of the window and a compaction frees ≥ **10%** of it. Target total after compaction (the low mark): **⌊window / 3⌋**. Window when unknown: **131,072**.
- Weights (shares of the total at a 128k window): reasoning **8000**, plan **4000**, text **4000**, read **3000**, edit **3000**, page **10000**, other **2000**, recall **3000**, stubs **4000**, notes **1500**.
- Fixed sizes: a reasoning block over **2000** tokens is a plan; a kept plan is its first **1000** and last **3000** tokens; older user messages over **4000** tokens are stubbed; a note is cut at **200** characters; head/tail stubs take up to **30** words from each end; a recall page is at most **16,000** characters; a search page has **20** hits.
- Note markers: a line starting with `Key:`, `Important:` or `Preserve:` (case-insensitive, after optional `- `, `* ` or `> `).
- Recall ids: `r<i>` reasoning of message i, `m<i>` text of message i, `a<i>.<k>` arguments of call k in message i, `t<i>` tool result in message i, `notes`, `index:<A>-<B>`.
- Copy, verbatim:
  - auto/manual notice: `Compacted the history sent to the model: ~{before} → ~{after} tokens. The chat still shows everything.`
  - limit notice: `Reached the context limit at {window}. Compacted the history sent to the model (~{before} → ~{after} tokens) and continued.`
  - cut-off call result: `Error: this call was cut off at the context limit and was not run. Make it again.`
  - continue nudge (user message, only when the cut-off reply has no tool call): `Your previous reply was cut off at the context limit. Older history has been compacted; continue where you left off.`
  - added to `TOOL_SYSTEM_HINT`: `Older steps may be compacted into stubs with recall ids: recall brings any of them back, or searches the history. Start a line with "Key:" to keep a lasting finding (one line each, only what you will need later).`
- Baseline: `node --test test/` passes **116** tests before Task 1; every task ends with the full suite green.

## Review Focus

1. **A tool call without its result (or the reverse) after compaction**: the server rejects the request. Every `tool_calls[].id` in the output has exactly one `tool` message and vice versa, through stubbing and removal. Owner: Task 2 (pairing test), Task 3 (removal test).
2. **Two user messages in a row**: the compacted-history block and a stubbed or kept user message must merge, never stand alone next to each other. Owner: Task 3 (alternation test).
3. **The frozen copy changing between compactions**: `markSuperseded` and `markCleared` mutate local call and part objects later; the frozen messages must not share objects with `state.messages`. Owner: Task 2 (no-shared-objects test).
4. **A user message merged into a frozen one**: after a failed request, a new or queued message merges into the trailing user message (`pushUser`). `upTo` must stop before a trailing user message so it is sent live. Owner: Task 2 (`upTo` test).
5. **Recall misuse**: an invalid regex, an unknown id, or a 9k-token page must give an error string or pages, never an exception or an oversized result. Owner: Task 5 (tests).

---

### Task 1: History items

**Files:**
- Create: `js/items.js`
- Test: `test/items.test.js`

**Interfaces:**
- Consumes: local messages as kept in `state.messages` (assistant messages may carry `reasoning`, `thinkingMs`, `tool_calls` with local flags `superseded`/`cleared`/`cutOff`; tool messages carry `tool_call_id` and string or part content; parts may carry `meta`). `estimateTokens` from `js/content.js`.
- Produces:
  - `historyItems(messages) -> Item[]` in history order, where `Item = {id, kind, msg, text, tokens, call?, resultMsg?, resultId?, tool?, pageId?}`; `kind` ∈ `'reasoning'|'plan'|'text'|'user'|'read'|'edit'|'page'|'shot'|'other'|'recall'`. A tool call and its result are one item (`id` = `a<i>.<k>`, `resultId` = `t<j>`); its `text` is the arguments JSON, a newline, and the result text; its `tokens` include result images.
  - `toolKind(name) -> kind`: `read`→read, `edit`→edit, `inline`/`pane`→page, `screenshot`→shot, `recall`→recall, else other.
  - `findNotes(text) -> string[]`: marked lines in order, trimmed, each cut to 200 characters (with `…` when cut).
  - `headTail(text, words = 30) -> {head, tail}`: first and last sentence, each cut to `words` words; `tail` is `''` when the text is one sentence.

- [ ] **Step 1: Write the failing tests** in `test/items.test.js`:
  - `ids and kinds`: a history `[user 'go', assistant {reasoning:'r', content:'c', tool_calls:[read#0, edit#1]}, tool(read), tool(edit)]` gives ids `m0`, `r1`, `m1`, `a1.0` (kind read, resultId `t2`), `a1.1` (kind edit, resultId `t3`), in that order.
  - `plan threshold`: reasoning of 8001 chars is kind `plan`; 8000 chars is `reasoning`.
  - `screenshot item`: a screenshot result with one image part counts 1024 + text tokens and has `pageId` from the part's `meta.pageId`.
  - `notes`: `findNotes('x\nKey: grid is 16x16\n- important: use raycasting\n> Preserve: a\nnot Key: this')` → `['Key: grid is 16x16', 'important: use raycasting', 'Preserve: a']`; a 300-char note is 200 chars ending in `…`.
  - `headTail`: `headTail('The wall textures render. Then more. Then I am done; give a short summary.')` → `{head:'The wall textures render.', tail:'Then I am done; give a short summary.'}`; one sentence → tail `''`; a 50-word first sentence → head of 30 words ending in `…`.
- [ ] **Step 2: Run** `node --test test/items.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the four exports in `js/items.js` (header comment: pure, unit tested under Node). Sentences split on `.`, `!`, `?` or newline followed by whitespace.
- [ ] **Step 4: Run** `node --test test/`. Expected: all pass.
- [ ] **Step 5: Commit** `git add js/items.js test/items.test.js && git commit -m "Compaction: address history items by id"`

### Task 2: Compaction core

**Files:**
- Create: `js/compact.js`
- Modify: `js/tools.js` (import `OMITTED_MARKER`, `omittedHtml`, `clearedHtml` from `compact.js` instead of defining them)
- Test: `test/compact.test.js`

**Interfaces:**
- Consumes: `historyItems`, `headTail`, `toolKind` (Task 1); `estimateTokens` (`js/content.js`).
- Produces:
  - `COMPACTION` constants object: `highMark: 0.6`, `minFree: 0.1`, `lowMark: 1/3`, `nominalWindow: 131072`, `weights` as listed, and the fixed sizes (`planTokens: 2000`, `planHead: 1000`, `planTail: 3000`, `userCap: 4000`, `noteChars: 200`, `stubWords: 30`, `recallChars: 16000`, `searchHits: 20`).
  - `allocate(demand: Record<kind, number>, weights: Record<kind, number>, total: number) -> Record<kind, number>`.
  - `compactHistory(messages, { window, thinkingMode, sendReasoning, tools }) -> { messages, upTo, before, after }`: `messages` are fresh objects in send shape (`reasoning_content` instead of `reasoning`, no `thinkingMs`; part `meta` kept for `prepareHistory`); `before`/`after` are `estimateTokens` of the uncompacted and compacted send shape.
  - `OMITTED_MARKER`, `omittedHtml(id)`, `clearedHtml(id)` (moved unchanged from `js/tools.js`).

- [ ] **Step 1: Write the failing tests** in `test/compact.test.js` (build histories with a small helper; use `window: 3 * 4000` etc. so totals are easy to read):
  - `allocate lends unused shares by weight`: `allocate({a:100, b:1000, c:1000}, {a:1, b:1, c:2}, 1200)` → `{a:100, b:367, c:733}` (±1); every value ≤ its demand; sum ≤ total.
  - `newest first within a kind`: five 1000-token reasoning blocks with a reasoning share of 2000 keep the last two whole; the older three become `"<head> [… recall r<i>] <tail>"`.
  - `plan blocks`: a 20k-token reasoning block within the plan share is sent as its first 4000 chars, `[… recall r<i> …]`, its last 12000 chars.
  - `tool stubs`: an old `read` keeps its arguments and its result becomes `[read "doom" lines 10–40; stale, recall t<j>]`; an old `edit` sends arguments `{"id":"doom","start":40,"end":52,"new":"[edit of lines 40–52, recall a<i>.<k>]"}` (for an `old`/`new` edit, the line numbers come from its result text `(lines 40-52)` or `(line 40)`) and keeps its result; an `other` tool keeps the first and last line of its result plus `[… recall t<j>]`.
  - `pages`: a superseded render sends `omittedHtml(id)`; a cleared one `clearedHtml(id)`; the latest render over its share sends html `[current source: read("doom")]`.
  - `screenshots`: of three screenshots of one page only the newest keeps its image; older ones become a text part `[earlier screenshot of "doom", recall t<j>]`.
  - `pairing` (Review Focus 1): for random budgets over the saved-session-like fixture, every `tool_calls[].id` appears in exactly one tool message and every tool message's `tool_call_id` in exactly one call.
  - `users`: the first and the latest user message are sent whole; an older 5000-token user message is head/tail stubbed with `recall m<i>`.
  - `thinking modes`: `sendReasoning: false` sends no `reasoning_content`; `thinkingMode: 'turn'` drops (not stubs) reasoning before the last user message.
  - `tools off`: with `tools: false` no stub contains `recall`.
  - `no shared objects` (Review Focus 3): mutating any call or part in the input after `compactHistory` leaves the output unchanged (deep-compare against a `structuredClone` of the output).
  - `upTo` (Review Focus 4): for a history ending in a user message, `upTo` is that message's index; otherwise `messages.length`; the output covers exactly messages `[0, upTo)`.
  - `deterministic`: the same input twice gives deep-equal output.
  - Move the two screenshot tests (`only the latest screenshot per page is sent`, from `test/content.test.js`) here in their compaction form.
- [ ] **Step 2: Run** `node --test test/compact.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** in `js/compact.js`. `allocate` is weighted water-filling: give each unfilled kind `remaining × weight / Σ unfilled weights`, cap kinds whose demand is below that at their demand, repeat with the rest until nothing changes. `compactHistory`:
  1. Items via `historyItems(messages.slice(0, upTo))`; apply the fixed rules first (superseded/cleared renders, older screenshots, reasoning dropped by `thinkingMode`/`sendReasoning`).
  2. Always kept, taken off the total first: the first and the latest user message, and the latest screenshot image of each page. Older user messages are not budgeted: kept, or stubbed when over 4000 tokens.
  3. `total = ⌊window / 3⌋`; `allocate` the rest over the budgeted kinds' demands; within each kind keep newest first while it fits, else stub.
  4. Build fresh send-shape messages from the decisions (an assistant message left with nothing is dropped). Stub copy is in the tests; `tools: false` drops every `recall …` reference from it.
- [ ] **Step 4: Run** `node --test test/`. Expected: all pass (content tests still pass: `prepareHistory` is untouched until Task 4).
- [ ] **Step 5: Commit** `git add js/compact.js js/tools.js test/compact.test.js test/content.test.js && git commit -m "Compaction: weighted budgets and deterministic stubs"`

### Task 3: Removed ranges and the notes block

**Files:**
- Modify: `js/compact.js`
- Test: `test/compact.test.js`

**Interfaces:**
- Consumes: `findNotes` (Task 1), the stub decisions of Task 2.
- Produces: `compactHistory` output now has stubs over the `stubs` share removed (oldest first, call and result together) and a compacted-history block appended to the first user message as a text part.

- [ ] **Step 1: Write the failing tests:**
  - `stub overflow removes the oldest`: 200 small stubbed items with a stubs share of ~20 stubs leave the newest ~20 stubs; removed messages 3–40 give the block line `Messages 3–40 compacted (N items): recall id "index:3-40" lists them.`; two separate removed runs give two lines, oldest first.
  - `removal keeps pairs` (Review Focus 1): after removal, the pairing invariant from Task 2 still holds.
  - `alternation` (Review Focus 2): no two consecutive messages in the output have the same role `user`; the block is part of the first user message, never its own message.
  - `notes block`: notes from stubbed or removed items appear under `Notes (newest first):` as `- <note>`; notes from items sent whole are not repeated; an exact duplicate appears once, at its newest position; over the notes share the block ends with `[<n> older notes: recall id "notes"]`.
  - `no block`: with nothing removed and no notes from compacted items, the first user message is unchanged.
- [ ] **Step 2: Run** `node --test test/compact.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** in `compactHistory`: after the per-kind pass, if stub tokens exceed the stubs share, remove stubbed items oldest first until they fit; collect contiguous removed message indices into ranges; gather notes; append the block (`[Compacted history]`, the range lines, the notes section) to the first user message.
- [ ] **Step 4: Run** `node --test test/`. Expected: all pass.
- [ ] **Step 5: Commit** `git add js/compact.js test/compact.test.js && git commit -m "Compaction: removed ranges and a notes block"`

### Task 4: Triggers, window learning, and send shaping

**Files:**
- Modify: `js/compact.js`, `js/content.js` (`prepareHistory`, `finalize`; remove `shouldRebase`; keep `latestShots` for `clearableSummary` but stop applying it in `prepareHistory`)
- Test: `test/compact.test.js`, `test/content.test.js`

**Interfaces:**
- Produces:
  - `shouldCompact({ used, max, held, compacted }) -> boolean`: `used ≥ 0.6·max` and `used − compacted·(used/held) ≥ 0.1·max` (`held ≤ 0`: use `compacted` unscaled); false when `used` or `max` is missing.
  - `learnWindow(win: {max: number|null, floor: number}, { finishReason, used }) -> {max, floor}`: `'length'` with `used ≥ floor` sets `max = used`; `used > max` (an output cap, not the window) sets `{max: null, floor: used}`; otherwise unchanged.
  - `prepareHistory` sends tool calls as `{id, type, function}` only; a call with `cutOff` goes with `arguments: '{}'`.

- [ ] **Step 1: Write the failing tests:**
  - `shouldCompact`: `{used:80000, max:131072, held:80000, compacted:40000}` → true; `used:70000` → false (under 60%); `{used:80000, held:80000, compacted:72000}` → false (frees under 10%); `max:null` → false.
  - `learnWindow`: `({max:null, floor:0}, {finishReason:'length', used:131000})` → `{max:131000, floor:0}`; then `{finishReason:'stop', used:140000}` → `{max:null, floor:140000}`; then `{finishReason:'length', used:20000}` → unchanged (an output cap below the floor); `{finishReason:'stop', used:5000}` → unchanged.
  - `prepareHistory strips local call fields`: a call with `superseded`, `cleared`, `cutOff: true` goes out as `{id, type, function:{name, arguments:'{}'}}`.
  - `prepareHistory sends every screenshot` (the rule moved to compaction); replace the old content-module screenshot test.
  - Delete the three `shouldRebase` tests.
- [ ] **Step 2: Run** `node --test test/`. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement** the two helpers in `js/compact.js` and the `prepareHistory`/`finalize` changes in `js/content.js`; remove `shouldRebase` and its import in `js/main.js` (Task 7 replaces its call; until then leave the call site using `shouldCompact` with `held: req.rebase.held, compacted: req.rebase.trimmed` so the app still runs).
- [ ] **Step 4: Run** `node --test test/`. Expected: all pass.
- [ ] **Step 5: Commit** `git add js/compact.js js/content.js js/main.js test/compact.test.js test/content.test.js && git commit -m "Compaction: trigger, learned window, cut-off calls on the wire"`

### Task 5: The recall tool

**Files:**
- Create: `js/recall.js`
- Modify: `js/tools.js` (definition, hint sentence, `runTool` case)
- Test: `test/recall.test.js`, `test/tools.test.js`

**Interfaces:**
- Consumes: `historyItems`, `findNotes` (Task 1).
- Produces:
  - `runRecall(messages, { id?, search?, page? }) -> string | { text, images }` (images as `{dataUrl, meta}`, the shape `runTool` already returns for screenshots).
  - Tool definition `recall`: description `Get back compacted history: an item by id (from a stub, "notes", or "index:A-B"), or search it with a regex.`; properties `id` (string), `search` (string), `page` (integer); none required.
  - `runTool('recall', args, ui)` calls `ui.recall(args)`.

- [ ] **Step 1: Write the failing tests** in `test/recall.test.js`:
  - `by id`: `r<i>` returns the reasoning; `a<i>.<k>` the arguments with page HTML as text; `t<j>` the result text; `m<i>` the message text; a screenshot `t<j>` returns `{text, images:[…]}` with the original image.
  - `paging` (Review Focus 5): a 40,000-char page source returns `Item a3.0 (page "doom", message 3), page 1 of 3:` plus at most 16,000 chars, and `… continue with page=2`; `page: 3` returns the rest without the continue line.
  - `search`: `search: 'wall\\s+tex'` returns `Hits for /wall\s+tex/i, page 1:` and lines `r12 (reasoning, message 12): …The wall textures render…` (snippet ±60 chars); 25 hits give 20 and a continue line; no hits → `No matches for /…/i.`
  - `notes`: `id: 'notes'` lists every note in the history newest first, deduplicated.
  - `index`: `id: 'index:3-5'` lists one line per item in messages 3–5: `<id> <kind>: <first 12 words>`.
  - `errors` (Review Focus 5): `search: '('` → `Error: invalid regex …`; `id: 'zz9'` → `Error: no item "zz9". Use an id from a stub, "notes", "index:A-B", or search.`; neither id nor search → `Error: give "id" or "search".`
  - In `test/tools.test.js`: `recall` is in `TOOL_DEFS` with no required properties; `runTool('recall', {id:'r1'}, {recall: (a) => a.id})` returns `'r1'`.
- [ ] **Step 2: Run** `node --test test/recall.test.js test/tools.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `js/recall.js`, then the `recall` definition (after `read_console` in `TOOL_DEFS`), the `runTool` case, and the hint sentence (Global Constraints) appended to `TOOL_SYSTEM_HINT`.
- [ ] **Step 4: Run** `node --test test/`. Expected: all pass.
- [ ] **Step 5: Commit** `git add js/recall.js js/tools.js test/recall.test.js test/tools.test.js && git commit -m "Recall tool: compacted history by id or search"`

### Task 6: Mock server: hidden window, hard limit, strict arguments

**Files:**
- Modify: `dev/mock_server.py`, `README.md` (mock flags paragraph)

**Interfaces:**
- Produces flags for Task 7's manual checks:
  - `--hide-ctx`: `/models` and `/props` report no `n_ctx`.
  - `--ctx-limit N`: when the rough prompt token count is ≥ N, the reply is a tool call whose arguments stop mid-string, `finish_reason` `length` (Responses: `bridge.finish_reason`), and usage totalling exactly N.
  - Always: a request whose history holds tool-call arguments that are not valid JSON gets HTTP 400 with Python's `json` error text (as the real server does).

- [ ] **Step 1: Implement** the three behaviours; add both flags to the README mock-server paragraph.
- [ ] **Step 2: Verify** with the server running as `python3 dev/mock_server.py --key sk-test --hide-ctx --ctx-limit 3000`: `curl -s localhost:8099/v1/models -H 'Authorization: Bearer sk-test'` shows no `n_ctx`; a chat-completions request with ~13,000 chars of history streams `"finish_reason": "length"` and usage `total_tokens` 3000; a request whose assistant tool call has `"arguments": "{\"id\": \"a"` returns 400 `Unterminated string starting at…`.
- [ ] **Step 3: Commit** `git add dev/mock_server.py README.md && git commit -m "Mock server: --hide-ctx, --ctx-limit, reject broken tool arguments"`

### Task 7: Wire compaction into the app

**Files:**
- Modify: `js/main.js` (`state`, `sendableHistory`, `buildRequest`, `runTurn`, `updateClearMedia`/`clearMedia`, connect), `README.md` (one paragraph on compaction and recall)

**Interfaces:**
- Consumes: `compactHistory`, `shouldCompact`, `learnWindow`, `COMPACTION` (Tasks 2–4), `runRecall` (Task 5).
- Produces (in `main.js`):
  - `state.compaction: {messages, upTo} | null` (frozen; reset with the history).
  - `state.context: {used, max, reported: boolean, floor: number}`: `reported` when the server gave the window at connect.
  - `adoptCompaction(reason: 'auto'|'manual'|'limit'|'quiet')`: runs `compactHistory(state.messages, {window: max ?? COMPACTION.nominalWindow, thinkingMode, sendReasoning, tools: toolsSupported})`, stores it, drops `state.chainHead`, shows the notice for `reason` (none for `quiet`).

- [ ] **Step 1: `sendableHistory(from, toolsOn)`** returns `[...frozen, ...live]`: `frozen` is `state.compaction.messages` when `from < upTo`, else empty; `live` is `state.messages.slice(max(from, upTo))` in send shape (reasoning sent whenever `sendReasoning`; `forServer` is gone). Tools-off filtering and `prepareHistory` run on the result as today.
- [ ] **Step 2: Trigger in `runTurn`** (replacing the `shouldRebase` block): when `max` is known and `used ≥ 0.6·max`, compute a candidate; `held` is the chained `req.rebase.held` or, unchained, `estimate(system + tools) + estimate(sendableHistory(0))`; if `shouldCompact` is true, `adoptCompaction('auto')` and rebuild the request.
- [ ] **Step 3: Limit handling in `runTurn`**, after a result with `finishReason === 'length'`:
  - every call whose arguments don't parse gets `cutOff = true`, is not run, and gets the cut-off result text (Global Constraints) as its tool message;
  - when `!state.context.reported`, `state.context` takes `learnWindow`'s result (also on every other result, so an output cap is caught); the counter shows the learned window;
  - once per `runTurn`, when the window is known: `adoptCompaction('limit')`; if the reply had no tool call, push the continue nudge as a user message; continue the loop.
- [ ] **Step 4: Compact button**: click runs `markCleared` then `adoptCompaction('manual')`; visible when `clearableSummary` finds media or a candidate compaction is at least 1000 estimated tokens smaller than `sendableHistory(0)`.
- [ ] **Step 5: Capability fallbacks** (any `fallbackFor` retry, including tools turning off): if a compaction exists, `adoptCompaction('quiet')` before the retry, so the frozen copy matches what the server can now take (and, with tools off, stubs lose their recall references). Pass `recall: (args) => runRecall(state.messages, args)` in the `runTool` ui object.
- [ ] **Step 6: Run** `node --test test/`. Expected: all pass.
- [ ] **Step 7: Verify in the browser** (headless Chromium driver as in earlier sessions; mock server `--key sk-test`, 8k window):
  - send `call:{"name":"kv","args":{},"loop":true}` and Continue past the round limit until the counter passes ~4.9k: the auto notice appears once, the counter drops, and the mock log shows one request without `prev=` followed by chained ones;
  - send `call:{"name":"recall","args":{"search":"kv"}}`: the tool result lists hits;
  - restart the mock with `--hide-ctx --ctx-limit 3000`, repeat the loop: the limit notice appears with `3k`, the counter shows `/ 3k`, the turn continues, and no request gets a 400.
- [ ] **Step 8: README**: one paragraph under the intro on compaction (when it runs, that the chat keeps everything) and the `recall` tool.
- [ ] **Step 9: Commit** `git add js/main.js README.md && git commit -m "Compact the sent history in frozen steps; learn the window at the limit"`

## Later (not in this plan)

- Telling a server's per-response output cap apart from the context window more reliably than the usage-based `learnWindow` rule (Adam: welcome later; the heuristic is fine for now).
- A dev-only export of the raw message list, to replay `compactHistory` over real sessions while tuning the weights.
