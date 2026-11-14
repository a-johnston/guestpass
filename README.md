# Guestpass

A static, no-build chat front-end for any OpenAI-compatible server with tools for rendering widgets onto the page. After connecting to a server, a shareable url can be copied so others can easily connect using the same info. No persistence- Cmd/Ctrl+S to save the session to `session.md`. Prefers `/responses` and falls back to `/chat/completions`. Supports images and other media for models that support it.

Long conversations are compacted in deterministic, frozen steps when the reported context reaches 60% of the window and compaction would free at least 10%, aiming for roughly a third of the window. If a server hides its window, Guestpass can learn it from a context-limit reply, compact, and continue. The Compact button also clears sent media. Only the history sent to the model changes: the chat and saved session keep everything. The model's `recall` tool can retrieve original items by the ids in stubs, list preserved notes or removed ranges, or search the full history with a regex; large results are paged.

To keep the server's cached history prefix stable, superseded page HTML, older screenshots, and the “Current turn only” thinking setting are applied **at compaction**, not on every request. New steps are sent whole until the next automatic or manual Compact, so hidden-window servers can fill faster than with live trimming. With a known window, a `length` finish only triggers context-limit recovery when fresh usage reaches at least 90% of it; recovery retries once per run to avoid a no-progress loop. With an unknown window, the first `length` finish still uses the plan's heuristic to learn a size, which later higher usage can invalidate as an output cap.

Model-authored HTML runs in `<iframe sandbox="allow-scripts …">` without `allow-same-origin`. Its origin is opaque, so it cannot reach the parent page's DOM, JS state (including the API key) or storage. It can still load scripts from CDNs and make network requests of its own. Frames can only talk to each other through the `kv` store and patches, both relayed by the parent page via `postMessage`.

## Development

```sh
python3 -m http.server 8080
python3 dev/mock_server.py --key sk-test # fake API at http://localhost:8099/v1 (--no-tools / --no-reasoning / --no-vision / --no-documents / --no-tool-images simulate servers rejecting those)
node --test test/
```

The mock server serves both `/v1/responses` (chaining in memory, like the proxy) and `/v1/chat/completions`, and prints one line per request (`prev=<previous_response_id> items=<n> bytes=<n>`). `--no-responses` drops the Responses route (chat completions only), `--stateless-responses` refuses `previous_response_id` like basalt, and `--forget-every N` forgets the chain on every Nth chained request. `--hide-ctx` hides the context size from `/models` and `/props`; `--ctx-limit N` streams a tool call cut off mid-string with a `length` finish and exactly N usage tokens once the rough prompt reaches N, and truncates output that would fill the remaining window. History tool-call arguments are always checked as JSON (invalid arguments return HTTP 400). Run the mock's HTTP regressions with `python3 -m unittest discover -s test -p '*_test.py'`.

The mock server has scripted responses: `call:{"name":"kv","args":{},"loop":true}` keeps reasoning and calling tools (for compaction and the round limit); `call:{"name":"patch","args":{…}}` makes it emit exactly that tool call, "slow" streams ~3s of reasoning (for testing queued messages), "pane" opens a pane, "inline" renders a widget, "think" streams reasoning, and anything else gets echoed back as markdown.

## License

Apache License 2.0; see [LICENSE](LICENSE). The libraries in `vendor/` keep their own licenses, noted in each file's header: marked (MIT), DOMPurify (Apache-2.0 or MPL-2.0) and highlight.js (BSD-3-Clause). marked and DOMPurify ship no minified ES-module build, so they were minified from upstream with the command in their headers.
