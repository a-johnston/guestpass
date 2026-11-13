#!/usr/bin/env python3
"""Tiny fake OpenAI-compatible server for developing Guestpass without a real model.

    python3 dev/mock_server.py [--port 8099] [--key sk-test] [--no-tools]

--no-tools rejects any request carrying `tools`, like llama-server without --jinja.
--no-reasoning rejects requests whose messages carry `reasoning_content`.
/models reports mock-1 with meta.n_ctx 8192; with stream_options.include_usage, a rough token
count is sent OpenAI-style (a final chunk with empty choices).

Scripted behaviour, keyed off the last user message:
  call:{"name": "...", "args": {...}, "think": "optional reasoning"}
                    -> emits exactly that tool call (drive any tool from the chat box)
  contains "code"   -> replies with python, js, and unlabeled code blocks (for highlighting)
  call:{..., "loop": true}
                    -> after each tool result, calls another tool (for the round limit)
  contains "long"   -> streams 80 paragraphs over ~4s (for auto-scroll tests)
  contains "slow"   -> streams reasoning for ~3s before answering (for queue/steering tests)
  contains "pane"   -> calls pane with a small canvas app (logs one console.error)
  contains "inline" -> calls inline with an SVG
  contains "think"  -> streams reasoning_content before the answer
  otherwise         -> echoes back markdown with a runnable ```html block
After a tool result it replies with a short summary that quotes the tool output.
Chunks are deliberately split mid-line to exercise the client's SSE parser.
"""
import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PANE_HTML = """<!doctype html><html><head><title>Bouncer</title>
<style>html,body{margin:0;height:100%;background:#111}canvas{display:block}</style></head>
<body><canvas id=c></canvas><script>
const c=document.getElementById('c'),x=c.getContext('2d');let b={x:50,y:50,vx:3,vy:2};
function size(){c.width=innerWidth;c.height=innerHeight}size();addEventListener('resize',size);
(function f(){b.x+=b.vx;b.y+=b.vy;
// Clamp and point velocity inward, so a shrinking pane can't strand the ball off-screen.
if(b.x<10){b.x=10;b.vx=Math.abs(b.vx)}if(b.x>c.width-10){b.x=Math.max(10,c.width-10);b.vx=-Math.abs(b.vx)}
if(b.y<10){b.y=10;b.vy=Math.abs(b.vy)}if(b.y>c.height-10){b.y=Math.max(10,c.height-10);b.vy=-Math.abs(b.vy)}
x.fillStyle='rgba(17,17,17,.25)';x.fillRect(0,0,c.width,c.height);x.fillStyle='#5b8cff';x.beginPath();x.arc(b.x,b.y,10,0,7);x.fill();requestAnimationFrame(f)})();
console.log('bouncer started');console.error('demo error: this is intentional');
</script></body></html>"""

INLINE_HTML = """<svg viewBox="0 0 200 60" width="100%" height="60"><rect width="200" height="60" rx="8" fill="#2f6fed"/>
<text x="100" y="37" fill="#fff" text-anchor="middle" font-family="sans-serif">Hello from a widget</text></svg>
<script>console.log('inline widget loaded at', new Date().toISOString())</script>"""


def chunk(delta, finish=None):
    return {"id": "mock", "object": "chat.completion.chunk", "model": "mock-1",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}


class Handler(BaseHTTPRequestHandler):
    key = None
    no_tools = False
    no_reasoning = False
    usage = None

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def authorized(self):
        if not self.key or self.headers.get("Authorization") == f"Bearer {self.key}":
            return True
        self.send_response(401)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"error": {"message": "invalid api key"}}).encode())
        return False

    def do_GET(self):
        if not self.path.rstrip("/").endswith("/models"):
            return self.send_error(404)
        if not self.authorized():
            return
        body = json.dumps({"object": "list", "data": [
            {"id": "mock-1", "meta": {"n_ctx": 8192}}, {"id": "mock-2"}]}).encode()
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if not self.path.rstrip("/").endswith("/chat/completions"):
            return self.send_error(404)
        if not self.authorized():
            return
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        msgs = req.get("messages", [])
        has_tools = bool(req.get("tools"))
        if has_tools and self.no_tools:
            return self.reject(500, "tools param requires --jinja flag")
        if self.no_reasoning and any("reasoning_content" in m for m in msgs):
            return self.reject(400, "unsupported field: reasoning_content")
        # Rough token count (4 chars/token) so the client's context counter has numbers to show.
        self.usage = None
        if (req.get("stream_options") or {}).get("include_usage"):
            self.usage = {"prompt_tokens": len(json.dumps(msgs)) // 4, "completion_tokens": 0}
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            self.respond(msgs, has_tools)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def reject(self, status, message):
        body = json.dumps({"error": {"message": message}}).encode()
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def emit(self, obj, split=True):
        if self.usage is not None:
            for c in obj.get("choices", []):
                d = c.get("delta", {})
                self.usage["completion_tokens"] += len(d.get("content") or "") // 4 + len(d.get("reasoning_content") or "") // 4
        data = f"data: {json.dumps(obj)}\n\n".encode()
        parts = [data[: len(data) // 2], data[len(data) // 2:]] if split else [data]
        for p in parts:
            self.wfile.write(p)
            self.wfile.flush()
            time.sleep(0.01)

    def stream_text(self, text, field="content"):
        for i in range(0, len(text), 6):
            self.emit(chunk({field: text[i:i + 6]}))

    def tool_call(self, name, args):
        raw = json.dumps(args)
        self.emit(chunk({"role": "assistant", "tool_calls": [
            {"index": 0, "id": "call_1", "type": "function", "function": {"name": name, "arguments": ""}}]}))
        for i in range(0, len(raw), 40):
            self.emit(chunk({"tool_calls": [{"index": 0, "function": {"arguments": raw[i:i + 40]}}]}))
        self.emit(chunk({}, "tool_calls"))

    def respond(self, msgs, has_tools):
        last = msgs[-1] if msgs else {}
        user = next((m.get("content") or "" for m in reversed(msgs) if m.get("role") == "user"), "")
        key = user.split("\n\n")[-1]  # the client merges queued messages into one user turn
        if last.get("role") == "tool" and has_tools and key.startswith("call:") and json.loads(key[5:]).get("loop"):
            self.tool_call("kv", {})  # never satisfied: keeps calling tools until the client's round limit
            return self.end_stream()
        elif last.get("role") == "tool":
            self.stream_text("Done. The tool reported:\n\n```\n" + last.get("content", "") + "\n```")
        elif has_tools and key.startswith("call:"):
            spec = json.loads(key[5:])
            if spec.get("think"):
                self.stream_text(spec["think"], field="reasoning_content")
            self.tool_call(spec["name"], spec.get("args", {}))
            return self.end_stream()
        elif "code" in key.lower():
            self.stream_text(
                "Python:\n\n```python\ndef greet(name):\n    # say hi\n    return f\"hi {name}\"\n```\n\n"
                "JS:\n\n```js\nconst n = 42; // answer\nconsole.log(`n=${n}`);\n```\n\n"
                "Unlabeled:\n\n```\nplain text block\n```\n")
        elif "long" in key.lower():
            for i in range(80):
                self.emit(chunk({"content": f"Line {i} of a long answer.\n\n"}))
                time.sleep(0.05)
        elif "slow" in key.lower():
            for i in range(30):
                self.emit(chunk({"reasoning_content": f"step {i}... "}))
                time.sleep(0.1)
            self.stream_text(f"You said: **{user}**")
        elif has_tools and "pane" in key.lower():
            self.stream_text("Opening a pane for you.")
            self.tool_call("pane", {"id": "bouncer", "title": "Bouncer", "html": PANE_HTML})
            return self.end_stream()
        elif has_tools and "inline" in key.lower():
            self.tool_call("inline", {"title": "SVG demo", "html": INLINE_HTML})
            return self.end_stream()
        else:
            if "think" in key.lower():
                self.stream_text("Let me consider this carefully... ok.", field="reasoning_content")
            self.stream_text(
                f"You said: **{user}**\n\n| tools sent | messages |\n|---|---|\n| {has_tools} | {len(msgs)} |\n\n"
                "Here is a runnable block:\n\n```html\n<button onclick=\"this.textContent='clicked!'\">Click me</button>\n```\n")
        self.emit(chunk({}, "stop"))
        self.end_stream()

    def end_stream(self):
        if self.usage is not None:  # OpenAI placement: a final chunk with empty choices
            u = dict(self.usage, total_tokens=self.usage["prompt_tokens"] + self.usage["completion_tokens"])
            self.wfile.write(f"data: {json.dumps({'choices': [], 'usage': u})}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--key", default=None)
    ap.add_argument("--no-tools", action="store_true")
    ap.add_argument("--no-reasoning", action="store_true")
    a = ap.parse_args()
    Handler.key = a.key
    Handler.no_tools = a.no_tools
    Handler.no_reasoning = a.no_reasoning
    print(f"mock server on http://localhost:{a.port}/v1" + (f" (key: {a.key})" if a.key else ""))
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()
