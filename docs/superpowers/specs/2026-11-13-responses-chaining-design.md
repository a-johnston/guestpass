# Responses API with chaining

## Intent

Guestpass re-sends the whole conversation with every request: images, attached files, page HTML,
tool results. Over a Tailscale funnel that is the dominant cost of a turn in a long or media-heavy
session. A proxy now sits between the funnel and the inference server and keeps recent
conversations, so a client can send only what is new plus `previous_response_id` (OpenAI's
Responses API). Guestpass should use that, and keep working with servers that can't.

## Goals

- Against the proxy: each request carries only the items added since the last response (the new
  user message, or the tool results of the last round) plus `previous_response_id`, `instructions`
  and `tools`.
- Prefer `POST /v1/responses`; fall back to `POST /v1/chat/completions` when the server has no
  Responses route. Detected once per connection, not per request.
- Servers with a Responses route that don't chain (basalt directly: stateless, refuses
  `previous_response_id`) get the full, trimmed history over `/responses` every request, as today.
- When the proxy has forgotten a response, the turn goes through anyway: Guestpass resends the
  full history once and chains from the new response.
- Everything that works today keeps working on every dialect: tools, reasoning display, images,
  screenshots, files, capability fallbacks, stop/interrupt, queued messages, usage and speed stats.

## Non-goals

- The Conversations API, server-side compaction, `background` mode.
- Keeping a chain across page reloads (Guestpass has no persistence).
- Proxy changes. We control the proxy, so smarter caching (or a way to rewrite stored history) is
  possible later; this design only needs what it does now.
- Branching or editing earlier messages (Guestpass has neither).

## Anti-goals

- A context that silently grows until the model hits its limit and the session dead-ends.
- Breaking chat-completions-only servers (llama.cpp, the mock server today) or share links.
- An extra round trip on every turn to probe the server.

## What the proxy does (probed 2026-11-13)

- `POST /v1/responses`, streaming and not. `/v1/chat/completions` is a plain-text 404.
- Chaining works: a chained turn recalled the earlier one, with 85 of 103 input tokens cached.
  `usage.input_tokens` is the whole context, including the chained part.
- Unknown id: HTTP 404, `{"error": {"code": "previous_response_not_found", "param":
  "previous_response_id", "message": "Response not found (evicted, deleted, store:false, or server
  restarted). Resend the full input without previous_response_id."}}`.
- Eviction: a response is dropped once something has chained from it (not LRU); in practice the
  parent survived a moment later, but the client must not rely on that.
- An unknown model is a JSON 404 `model_not_found`, so "route missing" must be told apart from
  "error from a route that exists" by the body, not the status.
- Responses carry `store: true`, reasoning as `reasoning` items with `reasoning_text` content, and a
  non-standard `bridge` object with `finish_reason` and llama.cpp-style `timings`.
- Streaming follows OpenAI's event names: `response.created`, `response.output_item.added`,
  `response.reasoning_text.delta`, `response.output_text.delta`,
  `response.function_call_arguments.delta`, `response.output_item.done`, `response.completed`
  (full response with usage). Tool calls arrive as `function_call` items with `call_id` and `name`.

## Approaches

- **A. Chain, and trim only when the full history is resent (chosen).** Normal turns send only new
  items. The trims Guestpass applies today (superseded page HTML, older screenshots, Clear media,
  earlier turns' thinking) take effect only when it starts a new chain with a full resend: on
  Clear media, after the proxy forgets a response, after a capability fallback, and automatically
  when the context nears the model's limit. Cost: a larger context between resends.
- B. Chain and never trim. Simplest, but Clear media does nothing on the proxy and widget-heavy
  sessions fill the context and stop.
- C. Full resend whenever a trim would apply. Re-renders happen nearly every turn in widget
  sessions, so it loses most of the savings exactly where they matter.

## Design

### Dialect and chaining detection (per connection)

`state.api = { dialect: 'responses' | 'chat', chain: null | true | false }`, reset on connect.

- Start with `dialect: 'responses'`. If a request fails with 404 or 405 and the body is not a JSON
  object with an `error`, the route is missing: set `dialect: 'chat'` and retry the same turn on
  `/chat/completions` (today's path, unchanged). No notice; it's invisible to the user.
- `chain` starts `null` (unknown). After a successful Responses call, a response with an `id` and
  `store !== false` makes it `true`; `store: false` or no `id` makes it `false`.
- If a request carrying `previous_response_id` fails with a 4xx that mentions
  `previous_response_id` and is not "not found" (code `previous_response_not_found`, or a message
  matching /not found|evicted/), the server can't chain: set `chain: false` and retry with the full
  history.

### What each request sends

A pure `buildResponsesRequest` (new `js/responses.js`) turns the history into a Responses body:

- System prompt (plus the tool hint) → `instructions`, every request (not inherited from the chain).
- `tools` → `{type: 'function', name, description, parameters}`, every request.
- User message → `{role: 'user', content: [input_text | input_image {image_url} | input_file
  {filename, file_data}]}`.
- Assistant message → a `reasoning` item (`content: [{type: 'reasoning_text', text}]`) when its
  thinking is sent under today's rules, an assistant message with `output_text`, then one
  `function_call` item per tool call (`call_id`, `name`, `arguments`).
- Tool message → `{type: 'function_call_output', call_id, output}`; `output` is the string, or an
  `input_text`/`input_image` array when it carries a screenshot.
- `stream: true`; `stream_options` is not sent (usage comes with `response.completed`).

**Chained request** (`chain` is true and `state.chainHead` is set): `previous_response_id:
chainHead.id` and `input` = the messages from `chainHead.sent` onward, converted. These are new,
so they go out as they are now: no pruning is needed on them except the capability fallbacks
already in `prepareHistory` (apply it to the slice).

**Full request** (no head, chaining off, or a rebase): `input` = the whole history through
`prepareHistory` as today, so every trim applies. No `previous_response_id`.

After a successful response: `chainHead = { id: result.responseId, sent: <index just past the
assistant message pushed for it> }`.

### When the chain is kept, and when it restarts

- **Stop / interrupt:** keep `chainHead` as it was. The partial assistant text kept locally goes
  out with the next request as an assistant input item. If the proxy evicted the parent because
  the stopped response was stored, the next request gets "not found" and rebases (below).
- **Request error and Retry:** keep `chainHead`; the retry resends the same new items.
- **"Not found":** drop `chainHead` and retry the same turn as a full request. Once per turn: a
  second "not found" on a full request is an ordinary error.
- **Clear media:** drop `chainHead`; the next request is a full, trimmed resend. Its notice says
  so ("…the next message re-sends the history without them").
- **Capability fallback** (vision, documents, tool images, tools, reasoning): drop `chainHead`
  before the retry, since the server's copy holds what it now can't take.
- **Context nearly full:** before a chained request, if the last usage is ≥ 75% of the model's
  context and a rebase would remove at least 10% of it (superseded page HTML, screenshots with a
  newer one of the same page, earlier turns' thinking, all estimated with the existing
  chars-per-token figure), drop `chainHead` and send a full request. Show a short notice: "Re-sent
  the history without superseded pages and older screenshots to free context." It never clears
  attachments; that stays the user's call.

### Reading the stream

A Responses accumulator beside the chat one in `js/stream.js`, returning the same shape
`{content, reasoning, toolCalls, finishReason, usage, timings}` plus `responseId`:

- `response.created` → `responseId`.
- `response.output_text.delta` → content; `response.reasoning_text.delta` and
  `response.reasoning_summary_text.delta` → reasoning.
- `response.output_item.added` with a `function_call` item → a new tool call (`id: call_id`,
  `function.name`); `response.function_call_arguments.delta` → its arguments, matched by
  `item_id`/`output_index`.
- `response.completed` / `response.incomplete` → usage mapped to `{prompt_tokens: input_tokens,
  completion_tokens: output_tokens, total_tokens}`, `timings` from `bridge.timings`,
  `finishReason` from `bridge.finish_reason`, else `incomplete_details.reason ===
  'max_output_tokens'` → `'length'`, tool calls → `'tool_calls'`, else `'stop'`.
- `response.failed` or an `error` event → throw with its message (and `code`).
- A non-streaming JSON reply (server ignored `stream`) is folded from its `output` array.

The SSE line parser is reused as is (it ignores `event:` lines; every `data:` payload carries
`type`).

### API layer

`streamChat` gains the dialect: it posts to `/responses` or `/chat/completions` with the matching
body builder and accumulator, and errors carry `status`, the parsed `error.code`, and whether the
body was a JSON API error (for route detection). `runTurn` owns the retry decisions above, next to
the existing fallback handling.

### Mock server

`dev/mock_server.py` serves `/v1/responses` with the same scripted behaviour, emitting Responses
events, and stores responses in memory so chaining works. New flags: `--no-responses` (route
missing, to exercise the chat fallback), `--stateless-responses` (rejects
`previous_response_id` like basalt), `--forget-every N` (answers "not found" every Nth chained
request).

### Tests

Unit tests (Node, as now) for the request builder (each message kind, chained slice vs full),
the Responses accumulator (split events, tool calls, reasoning, usage, incomplete, failed, the
non-streaming body), route-missing vs API-error detection, and the rebase-threshold estimate.

### Docs

README: Guestpass prefers the Responses API, chains with `previous_response_id` where the server
keeps history, and falls back to chat completions; Clear media's description reflects that on a
chaining server it takes effect with the next message.

## Left to the builder

- Module boundaries beyond `js/responses.js` and the accumulator, and how `runTurn`'s retry
  branches are arranged.
- The exact savings estimate for the auto-rebase, within the rule above.
- Mock server event pacing and how its scripted replies are shared between the two routes.
