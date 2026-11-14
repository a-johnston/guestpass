# Deterministic compaction with recall

## Intent

Long agentic turns fill the context long before the work is done. In a saved session (one user
message asking for a small doom-like game, then a single assistant turn of ~210 steps), the model
hit the 131k limit while still making progress. Before the screenshot tool existed the same model
finished in ~40k tokens with poor results; checking its work is what made it better, and what made
it run out.

Measured from that session (chars/4 estimate, which reads ~20% low on code and reasoning; the
shares are what matter):

| What | Est. tokens | Share |
|---|---|---|
| Reasoning (97 blocks: median 134, one 22k plan block, one 5k) | 58.6k | 55% |
| Tool call arguments (mostly two full page renders, ~9k each) | 24.0k | 22% |
| Tool results (mostly 35 `read`s, 10.7k) | 12.2k | 12% |
| Screenshot images (11) | 11.3k | 11% |
| User and assistant text | 0.4k | <1% |

The whole session is one user turn, so "Current turn only" thinking does nothing, and the existing
"Compact" (media and page HTML) leaves the largest part, reasoning, untouched. Simulated per-kind
budgets (below) end that session at ~29k estimated tokens instead of ~107k.

Generic LLM-summary compaction is not an option: on a 128k model it compacts often and badly, and
the inference server has a single slot, so a summarizer would compete with the model it serves.
Deterministic, structural compaction (as in pi-blackhole) has worked well for Adam; this brings
that to Guestpass, with a `recall` tool so nothing compacted is lost to the model.

## Goals

- A session like the one above runs to completion inside 131k, and plausibly much less.
- Compaction is deterministic: the same history and settings always compact the same way.
- Nothing is lost: everything compacted stays in the local history and the model can get it back
  by id or by search.
- Compaction is rare and stepwise, so between compactions the server's prompt cache and the
  Responses chain keep working.
- The model can mark lasting findings so they survive compaction.

## Non-goals

- LLM-written summaries, or any background worker on the inference server.
- Persistence across page reloads (Guestpass has none; the local history is the recall store).
- Changing what the user sees in the chat: compaction only changes what is sent.
- Relevance scoring beyond recency and kind.
- Tuning the numbers now. They start as the defaults below and get tuned against real sessions.

## Anti-goals

- History that shifts every request: a re-prefill of most of the context each turn on a single slot.
- Losing the user's task or the model's plan.
- A request the server rejects: a tool call without its result, a result without its call, or
  role alternation broken by inserted messages.
- Recall that crowds out the recent context it was meant to complement: a search spree evicting
  the tool results the model is actually working from.
- A model that marks everything as a note and fills the context with notes.

## Approaches

- **A. Compact in steps, only on a full resend (chosen).** When the context crosses a high mark,
  compute the compacted history once, freeze it, and send it in full (which also starts a new
  Responses chain). Between compactions, requests chain as today and the history only grows at
  the end. Cost: the context runs between the low and high marks instead of at its minimum.
- B. Compact every request (a sliding window). Smallest context, but the compaction cutoff moves
  every turn, so every request is a full resend and the server re-reads most of the prompt each
  turn; on one slot that costs more time than the smaller context saves.
- C. LLM-written summaries. Rejected: low quality at 128k in Adam's experience, and they need the
  same single slot.
- D. A `compact` tool the model calls. The model can't see how full its context is, and would
  have to remember to call it; automatic triggering is simpler and predictable.

## Design

### Overview

A new pure module, `js/compact.js` (unit tested under Node like `content.js`), computes a
**compaction plan** from `state.messages`: for each compactable item, keep it, stub it, or drop it
into a removed range. The plan is stored (`state.compaction`) and applied by `sendableHistory` on
every request until the next compaction. The local history is never modified; `session.md` still
saves everything.

### When compaction runs

- **Trigger:** before a request, when the context the server last reported is at least the high
  mark (default 60% of the model's context) and a new plan would free at least 10% of the context.
  This replaces today's `shouldRebase` check and reuses its bias-cancelling comparison of
  estimates against the reported figure. A compaction aims at the low mark (default ~33%: the sum
  of the budgets below), so the context runs between about a third and 60% full.
- **Unknown size: learn it at the limit.** When the server reports no context size, automatic
  compaction waits until the window is found by running into it. A response that ends with
  `finish_reason: 'length'` (Responses: `bridge.finish_reason`, or `incomplete_details`) while
  Guestpass sets no output cap means the context filled up, and the usage reported with it is the
  window: in the saved session both read 131k. Guestpass then sets `state.context.max` from that
  usage, shows it in the context counter, turns on automatic compaction, compacts, and continues
  the turn once (a notice says so). If a later response reports more usage than the learned size,
  the cut-off was an output cap on the server rather than the window (Claude's call): the learned
  size is dropped and replaced by the new figure as a lower bound. Without usage reports the size
  can't be learned; automatic compaction stays off and the Compact button uses the budgets for a
  128k context.
- **A response cut off mid tool call** (fixes an existing bug): the cut-off call's arguments are
  unfinished JSON, and sending them back makes the server reject the next request (`HTTP 400:
  Unterminated string…`; the empty `edit()` at the end of the saved session). Such a call is not
  run; it stays in the local history but is sent with arguments `{}` and a result saying it was
  cut off at the context limit and should be made again.
- **Effect:** recompute the plan over the whole history, drop `state.chainHead`, send a full
  request. The plan freezes: items added afterwards are sent whole until the next compaction.
- **Compact button:** "Compact" forces a compaction now, ignoring the marks, and clears media as
  it does today (`markCleared`). It shows whenever a compaction would free anything.
- **Both dialects:** the frozen plan matters for chat completions too, where the full history goes
  every request and the server's prefix cache is the only thing avoiding a full re-read.
- **Notice:** one line in the chat, e.g. "Compacted the history sent to the model: ~96k → ~31k
  tokens. The chat still shows everything."

### What gets compacted, and how

**One shared budget, split by weight.** A compaction has a single total to fill: the low mark,
about a third of the context (~42k tokens on a 128k model; ~2.7k on the mock server's 8k, so
compaction triggers there after a few scripted turns). Each kind gets a weighted share of it, and
a kind that needs less than its share gives the rest to the others, in proportion to their
weights, until every share is either used or full (weighted water-filling; deterministic). A
session that never screenshots or never reads lends that room to its reasoning and edits, so the
budget follows what the model actually uses. Within a kind, items are kept newest first until
its share is spent; older ones are stubbed. All weights and sizes live in one exported constants
object.

The column below shows each kind's share at a 128k context when every kind uses its full share;
the weights are those numbers relative to each other. Per-block sizes (the 2k "plan" threshold,
the 1k/3k plan head and tail, the 4k user-message cap, the ~200-character note cap) are fixed
token counts, not shares.

| Kind | Share at 128k (weight) | Stub |
|---|---|---|
| Reasoning, blocks ≤ 2k | 8k | first and last sentence (each ≤ ~30 words) + recall id |
| Reasoning, blocks > 2k ("plans") | 4k | first ~1k and last ~3k tokens + recall id, for the newest that fit; older become ordinary reasoning stubs |
| Assistant text | 4k | first and last sentence + recall id |
| User messages | never stubbed below the latest; older ones over 4k each are stubbed head/tail | head/tail + recall id |
| `read` results | 3k | `[read "id" lines a–b; stale, recall r42]` |
| `edit` calls (arguments) | 3k | `{"id":…, "start":a, "end":b, "new":"[edit of lines a–b, recall r43]"}` (result kept: it is short) |
| Page source (`inline`/`pane` `html`), latest render per page | 10k | `[current source: read("id")]`; older renders are already stubbed by `superseded` |
| Screenshots | latest per page (existing rule) | `[earlier screenshot of "id", recall r44]` |
| Other tool calls and results | 2k | first/last line + recall id |
| `recall` results | 3k | `[recall result, recall r45]` |
| Stubs (all kinds together) | 4k | oldest stubs fold into removed ranges (below) |
| Notes | 1.5k | see Notes |

Rules that cut across kinds:

- **Calls and results stay paired.** A tool call and its result are stubbed or removed together,
  never one without the other. An assistant message left with no content, reasoning or calls is
  dropped.
- **The latest user message is always sent whole**, and so is the first user message of the
  session (usually the task), unless it is over 4k.
- **Recall ids** are stable and derived from the local history (e.g. message index plus part:
  `r12` reasoning of message 12, `a14.0` arguments of its first call, `t15` the result in message
  15). The exact format is the builder's call; ids must survive later compactions.

### Removed ranges (the hierarchy)

When the stubs themselves exceed their share, the oldest stubs (with their items) are removed
from what is sent and replaced by one marker per contiguous removed range:

`[Steps 3–40 compacted (52 items). recall("index", "3-40") lists them.]`

A range marker, together with the Notes block, is carried in a single synthetic user message at
the start of the oldest remaining range, merged into an adjacent user message where alternation
requires it (consecutive user messages are already merged for this reason). Only one such message
exists; it changes only at a compaction.

### Notes

- A line in reasoning or assistant text starting with `Key:` (case-insensitive; `Important:` and
  `Preserve:` accepted too) is a note. Each note is capped at ~200 characters (longer: cut, with
  a recall id).
- Notes are collected at each compaction into the Notes block, newest first, deduplicated by exact
  text; re-marking a note makes it newest again, so a finding the model keeps relying on stays.
- Over its share, the block ends with `[14 older notes: recall("notes")]`.
- A note's line is kept even when the item it came from is stubbed or removed.
- `TOOL_SYSTEM_HINT` gains one short sentence: mark only lasting findings, one line each, with
  `Key:`; older steps may be compacted, and `recall` brings them back.

### The `recall` tool

```
recall({ id?: string, search?: string, page?: integer })
```

- `id`: the item's full original text (tool calls as their arguments, with page HTML as text;
  screenshots as the image again). Special ids: `"notes"` (all notes, newest first) and
  `"index"` with a range (one line per item: id, kind, first words).
- `search`: a JavaScript regex, case-insensitive, over the original text of every item in the
  history; returns up to 20 hits per page as id, kind and a one-line snippet around the match.
- Every result is capped at ~4k tokens, with "continue with page=N" when there is more.
- Results are ordinary tool results appended to the history (never inflated in place) and are
  their own kind with a small weight: they only borrow room other kinds aren't using, so a search
  spree evicts old recalls rather than the model's recent working context.
- `recall` is in the tool list only when tools are on, like the others; its description stays
  terse (the tool definitions are sent every request).

### Interaction with existing behaviour

- **Today's trims move into the plan** (Claude's call). Three existing rules rewrite the middle of
  the history on ordinary requests: an older screenshot of a page becomes a placeholder when a
  newer one arrives, a re-render marks older renders `superseded`, and `thinkingMode: 'turn'`
  drops earlier turns' reasoning when a new user message arrives. With chaining they only take
  effect at a resend already; on servers that don't chain (chat completions, basalt directly) each
  one makes the server re-read the prompt from that point. They become part of the plan instead,
  applied only at a compaction (or another full resend), so the history only grows at the end on
  every server. The context grows a little faster between compactions as a result; the high mark
  absorbs that. The local `superseded` marks can stay as they are; what changes is when
  `sendableHistory` honours them.
- Capability fallbacks and `prepareHistory` run after compaction, unchanged. A capability fallback
  already forces a full resend; it also recomputes the plan.
- **Tools off** (Claude's call): compaction still runs; with no tools there are no tool items, so
  it compacts reasoning and messages only. Stubs leave out recall ids and the system hint leaves
  out the recall and `Key:` sentences, since the model couldn't act on them; nothing is lost
  locally. If tools drop out mid-session (the tools fallback), the full resend that follows
  recomputes the plan with that wording.
- The context counter shows the server's figure as today.

## Testing and tuning

- Unit tests for `compact.js`: shares split by weight, with unused shares lent to the others;
  each kind filled newest first; call/result pairing; latest and first
  user message kept; notes collected, deduplicated, refreshed, capped; removed ranges and the
  synthetic message respecting alternation; determinism (same input, same plan); ids stable across
  a second compaction.
- Unit tests for `recall`: by id (each kind), search with paging, notes, index, caps.
- The mock server reports an 8k context, so compaction triggers after a few scripted turns.
- Tuning against real sessions: `session.md` is lossy for this. The builder may add a dev-only
  export of the raw message list so a script can replay `compact.js` over real sessions and report
  sizes per kind.

## Left to the builder

- The exact recall id format, stub wording, and sentence/clause splitting for head/tail stubs.
- Where the plan is stored and how `sendableHistory` applies it.
- Whether the Compact button's visibility check reuses `clearableSummary` or the plan.
- UI beyond the notice (for example marking compacted steps in the chat) is optional.
