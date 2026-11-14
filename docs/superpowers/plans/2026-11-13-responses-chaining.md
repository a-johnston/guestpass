# Responses API with Chaining Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guestpass talks `POST /v1/responses` first, chains turns with `previous_response_id` where the server keeps history, and falls back to `/v1/chat/completions` when the server has no Responses route.

**Architecture:** Pure helpers do the work and are unit tested under Node: a request builder (`js/responses.js`), a Responses stream accumulator (`js/stream.js`), error classifiers (`js/api.js`), and a context estimate (`js/content.js`). `js/main.js` keeps the chat history in today's chat-completions shape and decides per request whether to send the whole (trimmed) history or only the messages after the chain head. The mock server gains a Responses route with in-memory chaining.

**Tech Stack:** Static ES modules, no build, no dependencies; `node --test test/`; `dev/mock_server.py` (Python stdlib).

**Spec:** `docs/superpowers/specs/2026-11-13-responses-chaining-design.md`

## Global Constraints

- No build step, no package manager, no new dependencies (README: "no-build").
- Modules with logic stay pure (no DOM, no `state`) and get Node tests; `js/main.js` only wires them.
- Error messages never name the server URL (share-link recipients see them; see `explainNetworkError`).
- No persistence: chain state lives in `state` and resets on connect.
- Auto-rebase thresholds: context used ≥ **75%** of the model's context and savings ≥ **10%** of it.
- Notice copy, verbatim:
  - auto-rebase: `Re-sent the history without superseded pages and older screenshots to free context.`
  - Clear media while chaining: `Cleared media: the next message re-sends the history without it. The chat still shows it.`
  - Clear media otherwise (unchanged): `Cleared media from what is sent to the model. The chat still shows it.`
- Dialect fallback to chat completions shows no notice.
- Baseline: `node --test test/` passes 85 tests before Task 1; every task ends with the full suite green.

## Review Focus

1. A chained request whose new items start with tool results (`function_call_output` for a call the server already holds) must be accepted, not rejected for a missing call. Owner: Task 1 (builder test), Task 5 (mock accepts it).
2. The proxy's JSON 404 `model_not_found` must not flip the dialect to chat; only a non-JSON 404/405 does. Owner: Task 3.
3. After an auto-rebase, the next turn must not rebase again (the estimate compares server-held tokens to the trimmed size, not to the untrimmed history). Owner: Task 4.
4. A stopped reply whose response the proxy stored can evict the chain head; the next turn must get through by resending the full history once, with no error shown. Owner: Task 5 (`--forget-every`), Task 6 (manual check).
5. A screenshot returned by a tool goes out as an `output` array; if the server rejects it, the existing `toolImages` fallback must apply and drop the chain head, so the full resend moves images into a user message. Owner: Task 1 (array output test), Task 6 (fallback drops head).

---

### Task 1: Responses request builder

**Files:**
- Create: `js/responses.js`
- Test: `test/responses.test.js`

**Interfaces:**
- Consumes: chat-shaped messages as `buildRequest` produces them after `prepareHistory` (meta stripped; assistant messages may carry `reasoning_content` and `tool_calls`; tool messages carry `tool_call_id` and string or part-array `content`).
- Produces:
  - `toResponsesInput(messages: object[]) -> object[]`
  - `toResponsesTools(tools: {type:'function', function:{name, description, parameters}}[]) -> {type:'function', name, description, parameters}[]`
  - `buildResponsesBody({ instructions?: string, messages: object[], tools?: object[], model?: string, previousResponseId?: string }) -> object` — always `stream: true`; omits empty/absent `instructions`, `tools`, `model`, `previous_response_id`.

- [ ] **Step 1: Write the failing tests** in `test/responses.test.js`:
  - `user text and parts`: `{role:'user', content:'hi'}` → `{role:'user', content:[{type:'input_text', text:'hi'}]}`; a part array with `{type:'image_url', image_url:{url:'data:image/webp;base64,AA'}}` and `{type:'file', file:{filename:'a.pdf', file_data:'data:application/pdf;base64,AA'}}` → `input_image` with `image_url: 'data:image/webp;base64,AA'` and `input_file` with `filename`, `file_data`.
  - `assistant with reasoning, text and tool calls`: `{role:'assistant', reasoning_content:'plan', content:'ok', tool_calls:[{id:'call_1', type:'function', function:{name:'inline', arguments:'{"id":"x"}'}}]}` → in order `{type:'reasoning', content:[{type:'reasoning_text', text:'plan'}]}`, `{role:'assistant', content:[{type:'output_text', text:'ok'}]}`, `{type:'function_call', call_id:'call_1', name:'inline', arguments:'{"id":"x"}'}`. Empty `content` emits no assistant message item; no `reasoning_content` emits no reasoning item.
  - `tool result string`: `{role:'tool', tool_call_id:'call_1', content:'done'}` → `{type:'function_call_output', call_id:'call_1', output:'done'}`.
  - `tool result with screenshot` (Review Focus 5): content `[{type:'text', text:'shot'}, {type:'image_url', image_url:{url:'data:image/webp;base64,AA'}}]` → `output: [{type:'input_text', text:'shot'}, {type:'input_image', image_url:'data:image/webp;base64,AA'}]`.
  - `slice starting with tool results` (Review Focus 1): `toResponsesInput([{role:'tool', tool_call_id:'call_9', content:'r'}])` → exactly one `function_call_output` item, no error.
  - `system messages are not input`: a `{role:'system'}` message in `messages` is dropped (instructions carry it).
  - `tools flatten`: `toResponsesTools([{type:'function', function:{name:'kv', description:'d', parameters:{type:'object'}}}])` → `[{type:'function', name:'kv', description:'d', parameters:{type:'object'}}]`.
  - `body`: `buildResponsesBody({instructions:'sys', messages:[{role:'user', content:'hi'}], tools:[…], model:'m', previousResponseId:'resp_1'})` deep-equals `{model:'m', instructions:'sys', input:[…], tools:[…flattened], previous_response_id:'resp_1', stream:true}`; with only `messages` it has just `input` and `stream`.
- [ ] **Step 2: Run** `node --test test/responses.test.js` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the three exports in `js/responses.js` with a header comment like the other pure modules ("Pure, so it is unit tested under Node.").
- [ ] **Step 4: Run** `node --test test/` — Expected: all pass.
- [ ] **Step 5: Commit** `git add js/responses.js test/responses.test.js && git commit -m "Build Responses API request bodies from the chat history"`

### Task 2: Responses stream accumulator

**Files:**
- Modify: `js/stream.js` (add beside `createAccumulator`; update the header comment)
- Test: `test/stream.test.js`

**Interfaces:**
- Produces: `createResponsesAccumulator() -> { apply(event: object): void, result(): {content, reasoning, toolCalls, finishReason, usage, timings, responseId, stored} }`. `toolCalls` have the chat shape `{id, type:'function', function:{name, arguments}}` (so `runTurn`/`runTool` are unchanged). `usage` is chat-shaped `{prompt_tokens, completion_tokens, total_tokens}`. `stored` is `true` when the final response has an `id` and `store !== false`.

- [ ] **Step 1: Write the failing tests** (events as the proxy sent them, see spec "What the proxy does"):
  - `responses: text, reasoning, usage, timings`: `response.created` (`response.id:'resp_1'`), `response.reasoning_text.delta` ×2 (`'We'`, `' need'`), `response.output_text.delta` ×2 (`'Hel'`, `'lo'`), `response.completed` with `response:{id:'resp_1', store:true, status:'completed', output:[…], usage:{input_tokens:103, output_tokens:26, total_tokens:129}, bridge:{finish_reason:'stop', timings:{predicted_per_second:85.2}}}` → `{content:'Hello', reasoning:'We need', toolCalls:[], finishReason:'stop', usage:{prompt_tokens:103, completion_tokens:26, total_tokens:129}, timings:{predicted_per_second:85.2}, responseId:'resp_1', stored:true}`.
  - `responses: reasoning summary deltas count as reasoning`: `response.reasoning_summary_text.delta` appends to `reasoning`.
  - `responses: tool call`: `response.output_item.added` with `output_index:1, item:{id:'fc_1', type:'function_call', call_id:'call_2', name:'get_time', arguments:''}`, then `response.function_call_arguments.delta` with `item_id:'fc_1'`, deltas `'{"tz":'`, `'"UTC"}'`, then `response.completed` without `bridge` → `toolCalls: [{id:'call_2', type:'function', function:{name:'get_time', arguments:'{"tz":"UTC"}'}}]`, `finishReason:'tool_calls'`.
  - `responses: incomplete`: `response.incomplete` with `incomplete_details:{reason:'max_output_tokens'}` → `finishReason:'length'`.
  - `responses: store false is not chainable`: completed response with `store:false` → `stored:false`.
  - `responses: failure throws`: `apply({type:'response.failed', response:{error:{message:'boom', code:'server_error'}}})` throws an Error with message `'boom'` and `.code === 'server_error'`; `apply({type:'error', message:'bad', code:'x'})` throws `'bad'`.
  - `responses: non-streaming body folds output`: `apply({type:'response.completed', response:{id:'r', output:[{type:'reasoning', content:[{type:'reasoning_text', text:'t'}]}, {type:'message', content:[{type:'output_text', text:'hi'}]}, {type:'function_call', call_id:'c', name:'n', arguments:'{}'}]}})` with no prior deltas → `content:'hi'`, `reasoning:'t'`, one tool call `c`/`n`. When deltas were seen, `output` is not folded again (no doubled text).
- [ ] **Step 2: Run** `node --test test/stream.test.js` — Expected: FAIL (`createResponsesAccumulator` is not exported).
- [ ] **Step 3: Implement** `createResponsesAccumulator` in `js/stream.js`. Track calls by `item_id` (fall back to `output_index`). `finishReason`: `bridge.finish_reason`, else `'length'` for `incomplete_details.reason === 'max_output_tokens'`, else `'tool_calls'` if any calls, else `'stop'`. `total_tokens` falls back to input + output.
- [ ] **Step 4: Run** `node --test test/` — Expected: all pass.
- [ ] **Step 5: Commit** `git commit -am "Accumulate Responses API stream events into a reply"` (add the test file if new hunks are untracked).

### Task 3: API layer: dialects and error classification

**Files:**
- Modify: `js/api.js` (`streamChat`, header comment; new exports)
- Test: `test/api.test.js`

**Interfaces:**
- Consumes: `createResponsesAccumulator` (Task 2).
- Produces:
  - `streamChat({ baseUrl, apiKey, body, signal, onUpdate, dialect = 'chat' })`: `dialect: 'responses'` posts to `${baseUrl}/responses` with `body` as is (already `stream: true`), parses with the Responses accumulator, and a JSON reply is applied as `{type:'response.completed', response: json}`. `'chat'` is today's behaviour. HTTP errors are `Error` with `.status`, `.code` (the body's `error.code`, if any) and `.apiError` (`true` when the body parsed as JSON with an `error` object).
  - `isMissingRoute(err) -> boolean`: `(err.status === 404 || err.status === 405) && !err.apiError`.
  - `chainError(err) -> 'not_found' | 'unsupported' | null`: `'not_found'` when `err.code === 'previous_response_not_found'` or (4xx and message matches `/previous_response_id/i` and `/not found|evicted/i`); `'unsupported'` for any other 4xx whose message matches `/previous_response_id/i`; else `null`. Callers only consult it for requests that carried `previous_response_id`.

- [ ] **Step 1: Write the failing tests:**
  - `isMissingRoute`: `{status:404, apiError:false}` → true; `{status:405, apiError:false}` → true; `{status:404, apiError:true, code:'model_not_found'}` → false (Review Focus 2); `{status:400, apiError:false}` → false.
  - `chainError`: the proxy's error (`status:404, code:'previous_response_not_found'`, message from the spec) → `'not_found'`; `{status:400, message:'HTTP 400: previous_response_id is not supported; send the whole conversation'}` → `'unsupported'`; `{status:500, message:'previous_response_id'}` → null; `{status:400, message:'bad image'}` → null.
  - `streamChat responses dialect`: stub `globalThis.fetch` to record the URL and return `new Response(sse, {headers:{'content-type':'text/event-stream'}})` where `sse` is `response.created` + one `response.output_text.delta` + `response.completed` as `event:`/`data:` pairs; assert the URL ends with `/responses` and the result has the content and `responseId`. Restore `fetch` after.
  - `streamChat error fields`: stub returns `new Response('{"error":{"message":"nope","code":"previous_response_not_found"}}', {status:404})` → rejects with `status 404`, `code 'previous_response_not_found'`, `apiError true`; stub returns `new Response('Not Found', {status:404})` → `apiError false`.
- [ ] **Step 2: Run** `node --test test/api.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** as specified. Keep the existing error message format (`HTTP <status>: <message>`), so `fallbacks.js` matching is unchanged.
- [ ] **Step 4: Run** `node --test test/` — Expected: all pass.
- [ ] **Step 5: Commit** `git commit -am "Stream from /responses and classify route and chain errors"`

### Task 4: Context estimate for auto-rebase

**Files:**
- Modify: `js/content.js` (new exports beside `clearableSummary`)
- Test: `test/content.test.js`

**Interfaces:**
- Produces:
  - `estimateTokens(messages: object[], { charsPerToken = 4 } = {}) -> number`: over prepared (sent-shape) messages: string content, text parts, `reasoning_content`, and each tool call's `function.arguments` count as chars / `charsPerToken`; each `image_url` part counts **1024** (images are scaled to about 1 MP, see `MAX_IMAGE_PIXELS`); each `file` part counts its decoded size (`file_data` base64 length × 3/4) / `charsPerToken`.
  - `shouldRebase({ used, max, trimmed }) -> boolean`: false unless `used` and `max` are positive numbers; true when `used >= 0.75 * max && used - trimmed >= 0.10 * max`.

- [ ] **Step 1: Write the failing tests:**
  - `estimateTokens`: `[{role:'user', content:'abcdefgh'}]` with `charsPerToken: 4` → 2; a user message with one image part and text `'abcd'` → 1025; an assistant message with `reasoning_content:'abcd'` and a tool call with arguments `'abcdefgh'` → 3.
  - `shouldRebase`: `{used:80, max:100, trimmed:60}` → true; `{used:70, max:100, trimmed:10}` → false (under 75%); `{used:80, max:100, trimmed:75}` → false (saves under 10%); `{used:null, max:100, trimmed:0}` → false; `{used:80, max:null, trimmed:0}` → false.
  - `no repeat after a rebase` (Review Focus 3): after a rebase the server holds the trimmed history, so `used ≈ trimmed`: `{used:80, max:100, trimmed:79}` → false.
- [ ] **Step 2: Run** `node --test test/content.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** both in `js/content.js`.
- [ ] **Step 4: Run** `node --test test/` — Expected: all pass.
- [ ] **Step 5: Commit** `git commit -am "Estimate context a full resend would use, for auto-rebase"`

### Task 5: Mock server: Responses route with chaining

**Files:**
- Modify: `dev/mock_server.py` (docstring, `do_POST`, emitters, flags)

**Interfaces:**
- Produces, for Task 6's manual checks:
  - `POST /v1/responses` (streaming): converts `input` items back to chat messages (inverse of Task 1), prepends the stored history of `previous_response_id`, then runs the existing `respond()` scripts and the existing rejection flags on the result; emits Responses events (`response.created`, `response.output_item.added`, `response.reasoning_text.delta`, `response.output_text.delta`, `response.function_call_arguments.delta`, `response.output_item.done`, `response.completed` with `usage` as `input_tokens`/`output_tokens`/`total_tokens` and `store: true`), split mid-line like the chat stream.
  - Stores each response's full chat history in memory keyed by its id (`resp_<n>`), and evicts a response once another response chains from it (like the proxy).
  - Unknown `previous_response_id`: 404 JSON `{"error":{"message":"Response not found (evicted, deleted, store:false, or server restarted). Resend the full input without previous_response_id.","type":"invalid_request_error","param":"previous_response_id","code":"previous_response_not_found"}}`.
  - `--no-responses`: `/v1/responses` is a plain `send_error(404)` (route missing).
  - `--stateless-responses`: any `previous_response_id` gets 400 JSON `previous_response_id is not supported; send the whole conversation`, and responses carry `store: false`.
  - `--forget-every N`: every Nth chained request answers the not-found 404.
  - Every POST prints one line to stdout: `POST <route> prev=<id or -> items=<n> bytes=<request body length>`.

- [ ] **Step 1: Implement.** Suggested shape: `respond()` keeps calling `self.emit(chunk(...))`/`self.tool_call(...)`; when the request came in on `/responses`, `emit` translates each chat delta to Responses events and `end_stream` sends `response.completed`.
- [ ] **Step 2: Verify chaining.** Start `python3 dev/mock_server.py --key sk-test`, then:
  - `curl -s -N -H 'Authorization: Bearer sk-test' -H 'Content-Type: application/json' -d '{"model":"mock-1","stream":true,"input":[{"role":"user","content":[{"type":"input_text","text":"hello"}]}]}' localhost:8099/v1/responses` — Expected: events ending in `response.completed` with `"id": "resp_1"` and `"store": true`; the text includes `You said: **hello**`.
  - Same with `"previous_response_id":"resp_1"` and text `again` — Expected: the reply's table shows 3 messages (user, assistant, user); the server line shows `prev=resp_1 items=1`.
  - Again with `"previous_response_id":"resp_1"` — Expected: the not-found 404 body above (resp_1 was evicted).
- [ ] **Step 3: Verify flags.** `--no-responses`: the first curl gets a plain-text 404. `--stateless-responses`: a chained curl gets the 400; an unchained one completes with `"store": false`. `--forget-every 2`: the second chained request gets the not-found 404.
- [ ] **Step 4: Verify the chat route still works:** the existing `/v1/chat/completions` behaviour is unchanged (send `{"messages":[{"role":"user","content":"hi"}]}`; Expected: chat chunks and `[DONE]`). Run `node --test test/` — Expected: all pass.
- [ ] **Step 5: Commit** `git commit -am "Mock server: /v1/responses with in-memory chaining and failure flags"`

### Task 6: Wire dialects and chaining into the app

**Files:**
- Modify: `js/main.js` (`state`, `connect`, `buildRequest`, `runTurn`, `clearMedia`)

**Interfaces:**
- Consumes: `buildResponsesBody` (Task 1), `streamChat` with `dialect`, `isMissingRoute`, `chainError` (Task 3), `estimateTokens`, `shouldRebase` (Task 4).
- Produces: `state.api = { dialect: 'responses' | 'chat', chain: null | true | false }` and `state.chainHead = null | { id: string, sent: number }`, both reset in `connect()`.

- [ ] **Step 1: Split `buildRequest`.** `buildRequest({ from = 0 } = {})` returns `{ body, used, chained, trimmedTokens }`:
  - Map the full `state.messages` as today (strip `reasoning`/`thinkingMs`, `forServer` tool calls, `reasoning_content` by today's rule using full-history indices), then `slice(from)`, then today's tools-off filter and `prepareHistory` (in that order: `moveToolImages` changes message count, so slice before preparing).
  - `trimmedTokens`: `estimateTokens` of the full prepared history (`from = 0`) plus `instructions`, using `state.charsPerToken`. Compute it only when a chained request is being considered.
  - Chat dialect: today's body exactly. Responses dialect: `buildResponsesBody({ instructions: system, messages: history, tools: toolsOn ? toolDefs(...) : undefined, model, previousResponseId })`.
  - `chained` is true when `previousResponseId` was set. Use the chain head only when `state.api.dialect === 'responses'`, `state.api.chain !== false`, `state.chainHead` is set, and the slice is non-empty; otherwise build the full request.
- [ ] **Step 2: Auto-rebase before sending.** In `runTurn`, before a chained request: if `shouldRebase({ used: state.context.used, max: state.context.max, trimmed: trimmedTokens })`, set `state.chainHead = null`, show the auto-rebase notice (Global Constraints), and build the full request.
- [ ] **Step 3: Retry branches** in `runTurn`'s catch, after the `AbortError` branch and before `fallbackFor`, each doing `view.remove(); rounds--; continue;`:
  - `state.api.dialect === 'responses' && isMissingRoute(e)` → `state.api.dialect = 'chat'`, `state.chainHead = null`.
  - `chained && chainError(e) === 'not_found'` → `state.chainHead = null`.
  - `chained && chainError(e) === 'unsupported'` → `state.api.chain = false`, `state.chainHead = null`.
  - Existing capability fallback branch: also set `state.chainHead = null` (Review Focus 5).
  - Stop/interrupt and the Retry button leave `state.chainHead` unchanged.
- [ ] **Step 4: Advance the chain** after a successful reply, right after pushing the assistant message: on the Responses dialect, `state.api.chain = result.stored` unless it is already `false`; `state.chainHead = result.stored && state.api.chain ? { id: result.responseId, sent: state.messages.length } : null`.
- [ ] **Step 5: Clear media** sets `state.chainHead = null`; its notice uses the "while chaining" copy when a head was set, else today's copy.
- [ ] **Step 6: Verify against the mock** (`python3 -m http.server 8080` and `python3 dev/mock_server.py --key sk-test`, open the app linked to `http://localhost:8099/v1` with key `sk-test`), watching the mock's per-request lines:
  - Three plain messages: first line `prev=-`, later lines `prev=resp_<n> items=1`.
  - `pane`, then a follow-up: the request after the tool round carries only the `function_call_output` (and the follow-up only the user message).
  - Clear media after the pane, then a message: that request has `prev=-` and the mock's reply table counts the whole history; the notice uses the "while chaining" copy.
  - `--forget-every 2`: every turn still answers, with no error shown; the forgotten turns show two lines (a chained one, then `prev=-`) (Review Focus 4).
  - `--no-responses`: chat works; requests go to `/v1/chat/completions` after the first turn's one `/v1/responses` attempt; no notice.
  - `--stateless-responses`: every request is `prev=-`; no errors shown.
  - `--no-tool-images` with a screenshot: the fallback applies and the retried request is `prev=-`.
- [ ] **Step 7: Run** `node --test test/` — Expected: all pass. **Commit** `git commit -am "Prefer the Responses API, chain turns, fall back to chat completions"`

### Task 7: README and end-to-end check

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README.** Intro: Guestpass prefers the Responses API and chains turns with `previous_response_id` where the server keeps history (sending only what's new), and otherwise re-sends the history over `/responses` or `/chat/completions`. Clear media: on a chaining server it takes effect with the next message, which re-sends the history without the media. Development: list the new mock flags `--no-responses`, `--stateless-responses`, `--forget-every N`.
- [ ] **Step 2: End-to-end against the proxy, if the machine can reach it** (ask the user for its URL and key; never commit either): a plain turn, a `pane` turn and a follow-up, a screenshot, Clear media. Expected: replies stream with reasoning, tool calls run, and the browser's network panel shows chained requests (`previous_response_id` set) with small bodies after the first. Skip and say so if unreachable.
- [ ] **Step 3: Run** `node --test test/` — Expected: all pass. **Commit** `git commit -am "README: Responses API, chaining, and the new mock flags"`
