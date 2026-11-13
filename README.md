# Chat Bridge

A static, no-build chat front-end for any OpenAI-compatible server with tool calls for rendering model outputs into the page.

- After connecting to a server, a shareable url can be copied so others can easily connect using the same info. The connection info is is *encoded, not encrypted*: anyone with the link can connect and api keys should be temporary.
- The model gets tools that run in the browser:
  - `render_inline`: an HTML/JS widget inside the chat
  - `open_pane`: a full page or app in a tabbed side pane (passing the same id updates a pane in place)
  - `close_pane`
  - `read_console`
  - If the server rejects a request because of tools, the client drops them for the rest of the session and shows a notice.

  Console output and errors are captured and returned as the tool result, so the model can fix its own code. Fenced ```` ```html ```` blocks also get Run and Open-in-pane buttons, for models without tool support.
- No localStorage, sessionStorage or cookies. Reloading the page is how you clear the chat. Bookmark a link to reuse it.

## Security model

Model-authored HTML runs in `<iframe sandbox="allow-scripts …">` without `allow-same-origin`. Its origin is opaque, so it cannot reach the parent page's DOM, JS state (including the API key) or storage. It can still load scripts from CDNs and make network requests of its own.

## Development

```sh
python3 -m http.server 8080              # serve the site
python3 dev/mock_server.py --key sk-test # fake API at http://localhost:8099/v1 (add --no-tools to simulate a server without tool support)
node --test test/                        # unit tests (share codec, SSE/stream parsing, srcdoc injection)
```

The mock server has scripted responses: a message containing "pane" opens a pane, "inline" renders a widget, "think" streams reasoning, and anything else gets echoed back as markdown.

`vendor/` holds pinned copies of marked 12.0.2 and DOMPurify 3.1.6, so the page has no CDN dependency.
