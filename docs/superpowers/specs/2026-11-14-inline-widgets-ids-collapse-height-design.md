# Inline widgets: required ids, collapsing, content height

## Intent

Models often render an anonymous scratch widget right after thinking, iterate on it, then present
the result as a second, named widget. The scratch copy gets an auto id (`widget-N`), so the named
render doesn't replace it and the user sees two near-identical widgets. Separately, the `height`
parameter misfires: widgets end up too short for their content or clamped and scrolling.

## Goals

- Every inline widget has a model-chosen id, so a model that re-renders to present its result
  replaces its draft instead of duplicating it.
- The user can collapse any inline widget to its title bar and expand it again.
- Inline widgets size to their content; the model no longer picks a height.

## Non-goals

- New system-hint guidance about reusing ids. The hint already says reusing an id replaces the
  page and that large pages should be built up with `edit`; the model is expected to infer the rest.
- Changes to panes (they already require an id).
- Remembering collapsed state across reloads (no persistence).

## Anti-goals

- A page that fills its window (`100vh`, `height: 100%`, full-window canvas) collapsing to a
  sliver because it has no intrinsic height.
- Breaking `edit`, `read_console`, `patch` or `screenshot` on a collapsed widget.

## Approaches

- **A. Treat anonymous widgets as drafts:** when a named widget lands in the same reply, collapse
  earlier anonymous ones. Robust to model behaviour, but relies on models continuing to render
  anonymous drafts, and misfires when an anonymous widget was meant to stay.
- **B. Require ids (chosen):** `id` becomes required on `inline`; no auto ids. Simple, and the
  existing "reusing an id replaces it" rule does the deduplication. Depends on the model reusing
  the id when it presents its result.

Adam picked B: models given a required id shouldn't produce throwaway draft ids.

## Design

**Required id.** In `TOOL_DEFS`, `inline`'s `id` uses the shared `idParam` ("Page id") and is in
`required`. `runTool` returns `Error: "id" is required.` when it's missing or sanitizes to empty,
rather than inventing one (Claude's call: an error makes the requirement real; a silent fallback
would bring the duplicates back). The mock server's scripted `inline` call passes an id.

**No height.** Drop `height` from the `inline` definition, `mountInline`, and `widgetCard`; ignore
it if a model still sends it. A widget frame starts at 480px, then takes the height the page
reports, with no upper bound (minimum 40px). A page that fills its window reports exactly the
frame's height, so it stays at 480px with no special detection.

**Collapse.** Clicking a widget's title bar (anything but its pop-out button) toggles it between
expanded and collapsed to the title bar; no extra toggle symbol. The title is a button carrying
`aria-expanded` so the toggle is keyboard reachable. Collapsed widgets keep running and stay addressable by every
tool. `edit` keeps the current collapsed state; a fresh render of the id (replacement) starts
expanded. `screenshot` of a collapsed widget expands it first, as it already focuses a hidden pane.
Applies to the "▶ Run" code-preview cards too, since they share `widgetCard`.

## Left to the builder

- How the frame is hidden. It must not make the page report a bogus height that sticks after
  expanding (e.g. `display: none` can yield a 0 resize report; re-measure on expand or hide a
  wrapper instead).
- Exact caption styling and accessible labels for the toggle.
- Tests for the `runTool` id requirement if a lightweight harness fits; DOM parts verified by
  running the app against the mock server.
