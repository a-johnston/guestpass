# Guestpass

A static, no-build chat front-end for any OpenAI-compatible server with tools for rendering widgets onto the page. After connecting to a server, a shareable url can be copied so others can easily connect using the same info. No persistence- Cmd/Ctrl+S to save the session to `session.md`.

Guestpass prefers the Responses API (`/responses`). Where the server keeps history, it chains turns with `previous_response_id` and sends only what's new: the next message, or the last round's tool results. Elsewhere it re-sends the whole history every request, over `/responses`, or `/chat/completions` when the server has no Responses route. If the server forgets a response, the next request re-sends the history once and chains from there. Near the model's context limit, it re-sends the history without superseded pages and older screenshots to free context.

Files can be attached with **+**, pasted, or dropped onto the chat. Images are scaled to about 1 MP and re-encoded at low quality in the browser (WebP on basalt, JPEG elsewhere), since servers that don't chain get the whole history with every request. On servers that read documents (basalt advertises `documents` in `/props`), PDF, Office and text files go as `file` parts; elsewhere text files are inlined. Models that accept images also get a `screenshot` tool to see the pages they render. **Clear media**, next to the context counter, stops re-sending images, files and page HTML from earlier in the chat. On a server that chains, it takes effect with the next message, which re-sends the history without them.

Model-authored HTML runs in `<iframe sandbox="allow-scripts …">` without `allow-same-origin`. Its origin is opaque, so it cannot reach the parent page's DOM, JS state (including the API key) or storage. It can still load scripts from CDNs and make network requests of its own. Frames can only talk to each other through the `kv` store and patches, both relayed by the parent page via `postMessage`.

## Development

```sh
python3 -m http.server 8080
python3 dev/mock_server.py --key sk-test # fake API at http://localhost:8099/v1 (--no-tools / --no-reasoning / --no-vision / --no-documents / --no-tool-images simulate servers rejecting those)
node --test test/
```

The mock server serves both `/v1/responses` (chaining in memory, like the proxy) and `/v1/chat/completions`, and prints one line per request (`prev=<previous_response_id> items=<n> bytes=<n>`). `--no-responses` drops the Responses route (chat completions only), `--stateless-responses` refuses `previous_response_id` like basalt, and `--forget-every N` forgets the chain on every Nth chained request.

The mock server has scripted responses: `call:{"name":"patch","args":{…}}` makes it emit exactly that tool call, "slow" streams ~3s of reasoning (for testing queued messages), "pane" opens a pane, "inline" renders a widget, "think" streams reasoning, and anything else gets echoed back as markdown.

## License

Apache License 2.0; see [LICENSE](LICENSE). The libraries in `vendor/` keep their own licenses, noted in each file's header: marked (MIT), DOMPurify (Apache-2.0 or MPL-2.0) and highlight.js (BSD-3-Clause).
