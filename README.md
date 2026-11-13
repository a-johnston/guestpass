# Guestpass

A static, no-build chat front-end for any OpenAI-compatible server with tool calls for rendering model outputs into the page.

- After connecting to a server, a shareable url can be copied so others can easily connect using the same info. The connection info is is *encoded, not encrypted*: anyone with the link can connect and api keys should be temporary. The link fragment is the unpadded base64url of `baseUrl apiKey [system prompt]`, and chats use the first model the server lists.
- The model gets tools that run in the browser:
  - `inline`: an HTML/JS widget inside the chat (re-rendering the same id replaces the earlier widget)
  - `pane`: a full page or app in a tabbed side pane (passing the same id reloads it with new content)
  - `patch`: send JSON to a running widget/pane's `window.onPatch(data)` without reloading it; the return value comes back to the model
  - `kv`: read/update a key/value store shared live by every widget and pane (exposed inside them as `kv.get/set/delete/all/subscribe`)
  - `edit`: replace text in a page's source (exactly one match) and reload it in place; each page is treated as a single-file app, so fixes don't resend the whole page
  - `read`: a page's current source with line numbers, optionally a line range
  - `close`: close a pane or remove a widget
  - `read_console`

  Widgets and panes share one id namespace.
  - If the server rejects a request because of tools, the client drops them for the rest of the session and shows a notice.

  Console output and errors are captured and returned as the tool result, so the model can fix its own code. Fenced ```` ```html ```` blocks also get Run and Open-in-pane buttons, for models without tool support.
- No localStorage, sessionStorage or cookies. Reloading the page is how you clear the chat. Bookmark a link to reuse it.
- Cmd/Ctrl+S saves the conversation as `session.md`, including tool calls and the HTML they rendered, but never the server URL or API key.
- The top bar shows context use (`12.3k / 131k`): tokens from the server's `usage` report, out of the window size found in `/models` (`meta.n_ctx`, `max_model_len`, `context_length`) or `/props`.
- Context handling: the model's thinking is sent back (as `reasoning_content`) only within the current turn, so it keeps its plan across a tool loop; earlier turns' thinking is dropped. Once a widget or pane is re-rendered under the same id, the older HTML is replaced by a stub in what's sent to the server. Optional request fields (`tools`, `reasoning_content`, `stream_options`) are dropped for the session if the server rejects them.

## Security model

Model-authored HTML runs in `<iframe sandbox="allow-scripts …">` without `allow-same-origin`. Its origin is opaque, so it cannot reach the parent page's DOM, JS state (including the API key) or storage. It can still load scripts from CDNs and make network requests of its own. Frames can only talk to each other through the `kv` store and patches, both relayed by the parent page via `postMessage`.

## Development

```sh
python3 -m http.server 8080              # serve the site
python3 dev/mock_server.py --key sk-test # fake API at http://localhost:8099/v1 (--no-tools / --no-reasoning simulate servers rejecting those)
node --test test/                        # unit tests (share codec, SSE/stream parsing, srcdoc injection)
```

The mock server has scripted responses: `call:{"name":"patch","args":{…}}` makes it emit exactly that tool call, "slow" streams ~3s of reasoning (for testing queued messages), "pane" opens a pane, "inline" renders a widget, "think" streams reasoning, and anything else gets echoed back as markdown.

`vendor/` holds pinned copies of marked 12.0.2, DOMPurify 3.1.6 and highlight.js 11.9.0 (common-languages build), so the page has no CDN dependency.

## License

Apache License 2.0; see [LICENSE](LICENSE). The libraries in `vendor/` keep their own licenses, noted in each file's header: marked (MIT), DOMPurify (Apache-2.0 or MPL-2.0) and highlight.js (BSD-3-Clause).
