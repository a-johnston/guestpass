#!/usr/bin/env python3
"""Tiny fake OpenAI-compatible server for developing Guestpass without a real model.

    python3 dev/mock_server.py [--port 8099] [--key sk-test] [--no-tools]

Serves /v1/chat/completions and /v1/responses with the same scripted replies. /v1/responses keeps
each response's history in memory (resp_<n>) so `previous_response_id` chains, and drops a
response once another one chains from it, like the proxy. Unknown ids get the proxy's 404
`previous_response_not_found`. Every POST prints `POST <route> prev=<id|-> items=<n> bytes=<n>`.
--no-responses: /v1/responses is a plain-text 404 (route missing: clients fall back to chat).
--stateless-responses: rejects `previous_response_id` with a 400 and answers `store: false`, like basalt.
--forget-every N: every Nth chained request gets the not-found 404.
--hide-ctx: omit n_ctx from /models and /props.
--ctx-limit N: at N rough prompt tokens, stream a cut-off tool call and length finish.
History tool-call arguments must always be valid JSON (otherwise HTTP 400).

--no-tools rejects any request carrying `tools`, like llama-server without --jinja.
--no-reasoning rejects requests whose messages carry `reasoning_content`.
--no-vision reports a text-only model and rejects image parts; --no-documents rejects `file` parts;
--no-tool-images rejects images inside tool messages (as many servers do).
--no-caps reports no modalities and serves no /props (a barebones server: capabilities unknown).
/props reports vision, n_ctx, and basalt's `documents` capability, like basalt 0.3.3.
--models-delay / --models-status slow down or fail /models (for the connecting state).
/models reports mock-1 with meta.n_ctx 8192; with stream_options.include_usage, a rough token
count is sent OpenAI-style (a final chunk with empty choices).

Scripted behaviour, keyed off the last user message:
  call:{"name": "...", "args": {...}, "think": "optional reasoning"}
                    -> emits exactly that tool call (drive any tool from the chat box)
  contains "code"   -> replies with python, js, and unlabeled code blocks (for highlighting)
  call:{..., "loop": true}
                    -> after each tool result, reasons and calls another tool (round limit/compaction)
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
import itertools
import json
import threading
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


IMAGE_CARRIER = "Images returned by the tool calls above:"


def part_types(msg):
    """The content-part types in a message (empty for plain string content)."""
    content = msg.get("content")
    return {p.get("type") for p in content} if isinstance(content, list) else set()


def text_of(content):
    """A message's text: the string, or its text parts joined like the client joins them."""
    if isinstance(content, list):
        return "\n\n".join(p.get("text", "") for p in content if p.get("type") == "text")
    return content or ""


def media_note(msg):
    """'Received: 2 image(s), 1 file(s)' for a message with media, else ''."""
    content = msg.get("content")
    if not isinstance(content, list):
        return ""
    images = sum(p.get("type") == "image_url" for p in content)
    files = sum(p.get("type") == "file" for p in content)
    return f"Received: {images} image(s), {files} file(s)" if images or files else ""


NOT_FOUND = ("Response not found (evicted, deleted, store:false, or server restarted). "
             "Resend the full input without previous_response_id.")


def chat_parts(parts):
    """Responses input parts as chat content parts (the inverse of the client's conversion)."""
    if isinstance(parts, str):
        return parts
    out = []
    for p in parts or []:
        t = p.get("type")
        if t in ("input_text", "output_text"):
            out.append({"type": "text", "text": p.get("text", "")})
        elif t == "input_image":
            out.append({"type": "image_url", "image_url": {"url": p.get("image_url")}})
        elif t == "input_file":
            out.append({"type": "file", "file": {"filename": p.get("filename"), "file_data": p.get("file_data")}})
        else:
            out.append(p)
    return out


def items_to_messages(items):
    """Responses input items as chat messages: reasoning, text and calls fold into one assistant message."""
    if isinstance(items, str):
        items = [{"role": "user", "content": items}]
    msgs = []
    for it in items:
        t = it.get("type", "message")
        last = msgs[-1] if msgs else {}
        if t == "reasoning":
            text = "".join(p.get("text", "") for p in it.get("content") or [])
            msgs.append({"role": "assistant", "content": "", "reasoning_content": text})
        elif t == "function_call":
            call = {"id": it.get("call_id"), "type": "function",
                    "function": {"name": it.get("name"), "arguments": it.get("arguments", "")}}
            if last.get("role") == "assistant":
                last.setdefault("tool_calls", []).append(call)
            else:
                msgs.append({"role": "assistant", "content": "", "tool_calls": [call]})
        elif t == "function_call_output":
            msgs.append({"role": "tool", "tool_call_id": it.get("call_id"), "content": chat_parts(it.get("output"))})
        elif it.get("role") == "assistant":
            text = text_of(chat_parts(it.get("content")))
            if last.get("role") == "assistant" and not last.get("content") and not last.get("tool_calls"):
                last["content"] = text
            else:
                msgs.append({"role": "assistant", "content": text})
        elif it.get("role") in ("system", "developer"):
            msgs.append({"role": "system", "content": text_of(chat_parts(it.get("content")))})
        else:
            msgs.append({"role": it.get("role", "user"), "content": chat_parts(it.get("content"))})
    return msgs


def chunk(delta, finish=None):
    return {"id": "mock", "object": "chat.completion.chunk", "model": "mock-1",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}


class ContextLimit(Exception):
    """Stop a scripted reply as soon as its output fills the remaining window."""


class Handler(BaseHTTPRequestHandler):
    key = None
    no_tools = False
    no_reasoning = False
    no_vision = False
    no_documents = False
    no_tool_images = False
    no_caps = False
    models_delay = 0.0
    models_status = 200
    no_responses = False
    stateless_responses = False
    forget_every = 0
    hide_ctx = False
    ctx_limit = 0
    usage = None
    dialect = "chat"
    # /v1/responses state, shared by all request threads.
    lock = threading.Lock()
    responses = {}  # id -> chat history including that response's reply
    response_ids = itertools.count(1)
    call_ids = itertools.count(1)
    chained_requests = 0

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
        path = self.path.rstrip("/")
        if path.endswith("/props"):
            return self.props()
        if not path.endswith("/models"):
            return self.send_error(404)
        if not self.authorized():
            return
        time.sleep(self.models_delay)
        if self.models_status != 200:
            return self.reject(self.models_status, "model list unavailable (--models-status)")
        mock1 = {"id": "mock-1"}
        if not self.hide_ctx:
            mock1["meta"] = {"n_ctx": 8192}
        if not self.no_caps:
            mock1["architecture"] = {"input_modalities": ["text"] if self.no_vision else ["text", "image"]}
        body = json.dumps({"object": "list", "data": [mock1, {"id": "mock-2"}]}).encode()
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def props(self):
        """llama.cpp's /props at the server root, with basalt's extra key (as basalt 0.3.3 reports it)."""
        if self.no_caps:
            return self.send_error(404)
        if not self.authorized():
            return
        body = json.dumps({
            "default_generation_settings": {} if self.hide_ctx else {"n_ctx": 8192},
            "modalities": {"vision": not self.no_vision},
            "basalt": {"version": "mock", "capabilities": [] if self.no_documents else ["documents"]},
        }).encode()
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = self.path.rstrip("/")
        responses = path.endswith("/responses")
        if not responses and not path.endswith("/chat/completions"):
            return self.missing()
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        req = json.loads(raw or b"{}")
        prev = req.get("previous_response_id") if responses else None
        items = req.get("input", []) if responses else req.get("messages", [])
        print(f"POST {path} prev={prev or '-'} items={len(items) if isinstance(items, list) else 1} bytes={len(raw)}", flush=True)
        if responses and self.no_responses:
            return self.missing()
        if not self.authorized():
            return
        if not responses:
            self.dialect = "chat"
            return self.serve(items, req, req.get("stream_options") or {})

        history = []
        if prev:
            if self.stateless_responses:
                return self.reject(400, "previous_response_id is not supported; send the whole conversation",
                                   type="invalid_request_error", param="previous_response_id")
            with self.lock:
                Handler.chained_requests += 1
                forget = self.forget_every and Handler.chained_requests % self.forget_every == 0
                history = None if forget else self.responses.get(prev)
            if history is None:
                return self.reject(404, NOT_FOUND, type="invalid_request_error", param="previous_response_id",
                                   code="previous_response_not_found")
        history = history + items_to_messages(items)
        system = [{"role": "system", "content": req["instructions"]}] if req.get("instructions") else []
        self.dialect = "responses"
        self.prev = prev
        self.history = history
        self.response_id = f"resp_{next(self.response_ids)}"
        self.serve(system + history, req, {"include_usage": True})

    def serve(self, msgs, req, stream_options):
        """Checks the rejection flags, then streams a scripted reply in the request's dialect."""
        try:
            for m in msgs:
                for call in m.get("tool_calls") or []:
                    json.loads(call.get("function", {}).get("arguments", ""))
        except (json.JSONDecodeError, TypeError) as e:
            return self.reject(400, str(e))
        has_tools = bool(req.get("tools"))
        if has_tools and self.no_tools:
            return self.reject(500, "tools param requires --jinja flag")
        if self.no_reasoning and any("reasoning_content" in m for m in msgs):
            return self.reject(400, "unsupported field: reasoning_content")
        if self.no_tool_images and any(m.get("role") == "tool" and part_types(m) & {"image_url"} for m in msgs):
            return self.reject(400, "tool message content must be a string")
        if self.no_vision and any(part_types(m) & {"image_url"} for m in msgs):
            return self.reject(400, "image input is not supported by this model")
        if self.no_documents and any(part_types(m) & {"file"} for m in msgs):
            return self.reject(400, "unsupported content part type: file")
        # Rough token count (4 chars/token) so the client's context counter has numbers to show.
        self.usage = None
        # Tool definitions take context too, even when usage wasn't requested.
        prompt = (len(json.dumps(msgs)) + len(json.dumps(req.get("tools") or []))) // 4
        at_limit = self.ctx_limit > 0 and prompt >= self.ctx_limit
        if stream_options.get("include_usage") or self.ctx_limit > 0:
            self.usage = {"prompt_tokens": self.ctx_limit if at_limit else prompt, "completion_tokens": 0}
        self.output_chars = 0
        self.forced_limit = at_limit
        self.reply = {"content": "", "reasoning": "", "calls": [], "finish": None}
        self.items = []  # Responses output items; the last one may still be open
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            if self.dialect == "responses":
                self.event({"type": "response.created", "response": self.response_object("in_progress")})
            if at_limit:
                self.emit(chunk({"role": "assistant", "tool_calls": [
                    {"index": 0, "id": f"call_{next(self.call_ids)}", "type": "function",
                     "function": {"name": "edit", "arguments": '{"id": "a'}}]}))
                self.emit(chunk({}, "length"))
                self.end_stream()
            else:
                self.respond(msgs, has_tools)
        except ContextLimit:
            self.end_stream()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            # Kept even when the client hung up: the proxy stores a stopped response too.
            if self.dialect == "responses":
                self.store()

    def store(self):
        if self.stateless_responses:
            return
        r = self.reply
        msg = {"role": "assistant", "content": r["content"]}
        if r["reasoning"]:
            msg["reasoning_content"] = r["reasoning"]
        if r["calls"]:
            msg["tool_calls"] = r["calls"]
        with self.lock:
            self.responses[self.response_id] = self.history + [msg]
            self.responses.pop(self.prev, None)  # evicted once something chains from it

    def missing(self):
        """A route this server doesn't have: a plain-text 404 (with CORS, so browsers can read it)."""
        body = b"Not Found"
        self.send_response(404)
        self.cors()
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def reject(self, status, message, **fields):
        body = json.dumps({"error": {"message": message, **fields}}).encode()
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def emit(self, obj, split=True):
        """Sends a chat chunk, or on /responses the equivalent Responses events."""
        cut_off = False
        for c in obj.get("choices", []):
            d = c.get("delta", {})
            if self.usage is not None and not self.forced_limit:
                fields = [(d, "content"), (d, "reasoning_content")]
                fields += [(tc.get("function", {}), "arguments") for tc in d.get("tool_calls") or []]
                for owner, key in fields:
                    text = owner.get(key) or ""
                    if self.ctx_limit > 0:
                        available = max(0, (self.ctx_limit - self.usage["prompt_tokens"]) * 4 - self.output_chars)
                        if len(text) > available:
                            owner[key] = text = text[:available]
                            cut_off = True
                    self.output_chars += len(text)
                self.usage["completion_tokens"] = self.output_chars // 4
            if cut_off:
                c["finish_reason"] = "length"
            self.record(d, c.get("finish_reason"))
            if self.dialect == "responses":
                self.translate(d)
        if self.dialect == "chat":
            self.send(f"data: {json.dumps(obj)}\n\n".encode(), split)
        if cut_off:
            raise ContextLimit

    def send(self, data, split=True):
        parts = [data[: len(data) // 2], data[len(data) // 2:]] if split else [data]
        for p in parts:
            self.wfile.write(p)
            self.wfile.flush()
            time.sleep(0.01)

    def event(self, ev):
        self.send(f"event: {ev['type']}\ndata: {json.dumps(ev)}\n\n".encode())

    def record(self, d, finish):
        """Keeps the reply in chat shape, to store it for chaining."""
        r = self.reply
        r["content"] += d.get("content") or ""
        r["reasoning"] += d.get("reasoning_content") or ""
        for tc in d.get("tool_calls") or []:
            if tc.get("id"):
                r["calls"].append({"id": tc["id"], "type": "function", "function": {"name": tc["function"]["name"], "arguments": ""}})
            r["calls"][-1]["function"]["arguments"] += tc.get("function", {}).get("arguments") or ""
        if finish:
            r["finish"] = finish

    def open_item(self, item):
        self.close_item()
        item["status"] = "in_progress"
        self.items.append(item)
        self.event({"type": "response.output_item.added", "output_index": len(self.items) - 1, "item": item})
        return item

    def close_item(self):
        item = self.items[-1] if self.items else None
        if item and item["status"] == "in_progress":
            item["status"] = "completed"
            self.event({"type": "response.output_item.done", "output_index": len(self.items) - 1, "item": item})

    def current(self, kind):
        item = self.items[-1] if self.items else None
        return item if item and item["status"] == "in_progress" and item["type"] == kind else None

    def translate(self, d):
        n = len(self.items)
        if d.get("reasoning_content"):
            item = self.current("reasoning") or self.open_item(
                {"id": f"rs_{n}", "type": "reasoning", "content": [{"type": "reasoning_text", "text": ""}]})
            item["content"][0]["text"] += d["reasoning_content"]
            self.event({"type": "response.reasoning_text.delta", "item_id": item["id"],
                        "output_index": len(self.items) - 1, "content_index": 0, "delta": d["reasoning_content"]})
        if d.get("content"):
            item = self.current("message") or self.open_item(
                {"id": f"msg_{n}", "type": "message", "role": "assistant", "content": [{"type": "output_text", "text": ""}]})
            item["content"][0]["text"] += d["content"]
            self.event({"type": "response.output_text.delta", "item_id": item["id"],
                        "output_index": len(self.items) - 1, "content_index": 0, "delta": d["content"]})
        for tc in d.get("tool_calls") or []:
            fn = tc.get("function", {})
            if tc.get("id"):
                self.open_item({"id": f"fc_{n}", "type": "function_call", "call_id": tc["id"],
                                "name": fn.get("name"), "arguments": ""})
            item = self.current("function_call")
            if item and fn.get("arguments"):
                item["arguments"] += fn["arguments"]
                self.event({"type": "response.function_call_arguments.delta", "item_id": item["id"],
                            "output_index": len(self.items) - 1, "delta": fn["arguments"]})

    def response_object(self, status):
        r = {"id": self.response_id, "object": "response", "status": status, "model": "mock-1",
             "store": not self.stateless_responses, "previous_response_id": self.prev, "output": self.items}
        if status == "completed":
            u = self.usage
            r["usage"] = {"input_tokens": u["prompt_tokens"], "output_tokens": u["completion_tokens"],
                          "total_tokens": u["prompt_tokens"] + u["completion_tokens"]}
            r["bridge"] = {"finish_reason": self.reply["finish"] or ("tool_calls" if self.reply["calls"] else "stop")}
        return r

    def stream_text(self, text, field="content"):
        step = max(6, len(text) // 300)  # long echoes (e.g. a big read result) stay a few seconds
        for i in range(0, len(text), step):
            self.emit(chunk({field: text[i:i + step]}))

    def tool_call(self, name, args):
        raw = json.dumps(args)
        call_id = f"call_{next(self.call_ids)}"  # unique, as a chained history holds many calls
        self.emit(chunk({"role": "assistant", "tool_calls": [
            {"index": 0, "id": call_id, "type": "function", "function": {"name": name, "arguments": ""}}]}))
        step = max(40, len(raw) // 100)  # big pages stream in ~100 chunks instead of hundreds
        for i in range(0, len(raw), step):
            self.emit(chunk({"tool_calls": [{"index": 0, "function": {"arguments": raw[i:i + step]}}]}))
        self.emit(chunk({}, "tool_calls"))

    def respond(self, msgs, has_tools):
        last = msgs[-1] if msgs else {}
        # A user message the client adds to carry tool images (servers rejecting them in tool results).
        carrier = last.get("role") == "user" and text_of(last.get("content")).startswith(IMAGE_CARRIER)
        user_msg = next((m for m in reversed(msgs) if m.get("role") == "user"
                         and not text_of(m.get("content")).startswith(IMAGE_CARRIER)), {})
        user = text_of(user_msg.get("content"))
        received = media_note(user_msg)
        # The client merges user messages, and may append a compaction block to the first one.
        scripted = [s for s in user.split("\n\n") if not s.startswith("[Compacted history]")]
        key = scripted[-1] if scripted else ""
        if last.get("role") == "tool" and has_tools and key.startswith("call:") and json.loads(key[5:]).get("loop"):
            # Real tool loops accumulate reasoning, not just JSON envelopes. Give the compactor
            # actual content to budget, keeping this in one chunk so smoke tests remain fast.
            self.emit(chunk({"reasoning_content": "I will inspect the shared state, check the last result, and keep working on the user's task. " * 8}))
            self.tool_call("kv", {})  # never satisfied: keeps calling tools until the client's round limit
            return self.end_stream()
        elif last.get("role") == "tool" or carrier:
            tool = next(m for m in reversed(msgs) if m.get("role") == "tool")
            image = "image_url" in part_types(last)
            self.stream_text("Done. The tool reported:\n\n```\n" + text_of(tool.get("content")) + "\n```" +
                             ("\n\nThe tool returned an image." if image else ""))
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
            self.tool_call("inline", {"id": "svg-demo", "title": "SVG demo", "html": INLINE_HTML})
            return self.end_stream()
        else:
            if "think" in key.lower():
                self.stream_text("Let me consider this carefully... ok.", field="reasoning_content")
            self.stream_text(
                f"You said: **{user}**\n\n" + (f"{received}\n\n" if received else "") +
                f"| tools sent | messages |\n|---|---|\n| {has_tools} | {len(msgs)} |\n\n"
                "Here is a runnable block:\n\n```html\n<button onclick=\"this.textContent='clicked!'\">Click me</button>\n```\n")
        self.emit(chunk({}, "stop"))
        self.end_stream()

    def end_stream(self):
        if self.dialect == "responses":
            self.close_item()
            self.event({"type": "response.completed", "response": self.response_object("completed")})
            return
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
    ap.add_argument("--no-vision", action="store_true", help="report and act like a text-only model")
    ap.add_argument("--no-documents", action="store_true", help="reject file content parts")
    ap.add_argument("--no-tool-images", action="store_true", help="reject images inside tool messages")
    ap.add_argument("--no-caps", action="store_true", help="report no modalities and no /props, like a barebones server")
    ap.add_argument("--models-delay", type=float, default=0.0, help="seconds before /models answers")
    ap.add_argument("--models-status", type=int, default=200, help="make /models fail with this status")
    ap.add_argument("--no-responses", action="store_true", help="no /v1/responses route (plain-text 404)")
    ap.add_argument("--stateless-responses", action="store_true", help="reject previous_response_id, answer store: false")
    ap.add_argument("--forget-every", type=int, default=0, metavar="N", help="every Nth chained request: not found")
    ap.add_argument("--hide-ctx", action="store_true", help="omit the context window from /models and /props")
    ap.add_argument("--ctx-limit", type=int, default=0, metavar="N", help="cut off a tool call at N rough prompt tokens")
    a = ap.parse_args()
    Handler.key = a.key
    Handler.no_tools = a.no_tools
    Handler.no_reasoning = a.no_reasoning
    Handler.no_vision = a.no_vision
    Handler.no_documents = a.no_documents
    Handler.no_tool_images = a.no_tool_images
    Handler.no_caps = a.no_caps
    Handler.models_delay = a.models_delay
    Handler.models_status = a.models_status
    Handler.no_responses = a.no_responses
    Handler.stateless_responses = a.stateless_responses
    Handler.forget_every = a.forget_every
    Handler.hide_ctx = a.hide_ctx
    Handler.ctx_limit = a.ctx_limit
    print(f"mock server on http://localhost:{a.port}/v1" + (f" (key: {a.key})" if a.key else ""))
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()
