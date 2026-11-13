# Guestpass

A static, no-build chat front-end for any OpenAI-compatible server with tools for rendering widgets onto the page. After connecting to a server, a shareable url can be copied so others can easily connect using the same info. No persistence- Cmd/Ctrl+S to save the session to `session.md`.

Files can be attached with **+**, pasted, or dropped onto the chat. Images are scaled to about 1 MP and re-encoded at low quality in the browser (WebP on basalt, JPEG elsewhere), since the whole history is re-sent with every request. On servers that read documents (basalt advertises `documents` in `/props`), PDF, Office and text files go as `file` parts; elsewhere text files are inlined. Models that accept images also get a `screenshot` tool to see the pages they render. **Clear media**, next to the context counter, stops re-sending images, files and page HTML from earlier in the chat.

Model-authored HTML runs in `<iframe sandbox="allow-scripts …">` without `allow-same-origin`. Its origin is opaque, so it cannot reach the parent page's DOM, JS state (including the API key) or storage. It can still load scripts from CDNs and make network requests of its own. Frames can only talk to each other through the `kv` store and patches, both relayed by the parent page via `postMessage`.

## Development

```sh
python3 -m http.server 8080
python3 dev/mock_server.py --key sk-test # fake API at http://localhost:8099/v1 (--no-tools / --no-reasoning / --no-vision / --no-documents / --no-tool-images simulate servers rejecting those)
node --test test/
```

The mock server has scripted responses: `call:{"name":"patch","args":{…}}` makes it emit exactly that tool call, "slow" streams ~3s of reasoning (for testing queued messages), "pane" opens a pane, "inline" renders a widget, "think" streams reasoning, and anything else gets echoed back as markdown.

## License

Apache License 2.0; see [LICENSE](LICENSE). The libraries in `vendor/` keep their own licenses, noted in each file's header: marked (MIT), DOMPurify (Apache-2.0 or MPL-2.0) and highlight.js (BSD-3-Clause).
