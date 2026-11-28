# Guestpass

A static, no-build chat front-end for any OpenAI-compatible server with tools for rendering widgets onto the page. After connecting to a server, a shareable url can be copied so others can easily connect using the same info. Cmd/Ctrl+S to download the session as a markdown file. Prefers `/responses` and falls back to `/chat/completions`. Supports images and other media for models that support it.

Long conversations are compacted in deterministic, frozen steps when the reported context reaches 60% of the window and compaction would free at least 10%, aiming for roughly a third of the window. If a server does not advertise its window, Guestpass can learn it from a context-limit reply, compact, and continue. The Compact button also clears sent media. Only the history sent to the model changes: the chat and saved session keep everything. The model's `recall` tool can retrieve original items by the ids in stubs, list preserved notes or removed ranges, or search the full history with a regex; large results are paged.

Model-authored HTML widgets run in `<iframe sandbox="allow-scripts …">` without `allow-same-origin`. Its origin is opaque, so it cannot reach the parent page's DOM, JS state (including the API key) or storage. It can still load scripts from CDNs and make network requests of its own. Individual widgets can coordinate through the `kv` store.

## Development

```sh
python3 -m http.server
python3 dev/mock_server.py --key sk-test # fake API at http://localhost:8099/v1
node --test test/
```

The mock server supports the following options:
```
--no-tools
--no-reasoning
--no-vision
--no-documents
--no-tool-images
--one-model (only advertises mock-1 and not mock-2)
--hide-ctx (hides context size from /models and /props)
--no-responses (only serves /v1/chat/completions and not /v1/responses)
--stateless-responses (refuses previous_response_id)
--ctx-limit N (streams a cut off tool call)
```
Run the mock server's tests with `python3 -m unittest discover -s test -p '*_test.py'`.

The mock server has scripted responses: `call:{"name":"kv","args":{},"loop":true}` keeps reasoning and calling tools (for compaction and the round limit); `call:{"name":"patch","args":{…}}` makes it emit exactly that tool call, "slow" streams ~3s of reasoning (for testing queued messages), "pane" opens a pane, "inline" renders a widget, "think" streams reasoning, and anything else gets echoed back as markdown.

## License

[Apache 2.0](LICENSE). The libraries in `vendor/` keep their own licenses, noted in each file's header: marked (MIT), DOMPurify (Apache-2.0 or MPL-2.0) and highlight.js (BSD-3-Clause). marked and DOMPurify ship no minified ES-module build, so they were minified from upstream with the command in their headers.
