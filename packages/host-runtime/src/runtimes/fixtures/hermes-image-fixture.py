"""Confined fake provider and stdio tool for the opt-in image qualification."""

import http.server
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path


PORT = 7766
CAPTURE = []
CAPTURE_LOCK = threading.Lock()
START = time.monotonic()


def stamp():
    return round((time.monotonic() - START) * 1000)


def capture(kind, value):
    item = {"kind": kind, "ms": stamp(), "value": value}
    with CAPTURE_LOCK:
        CAPTURE.append(item)
        sys.stderr.write("ARDUR_EVIDENCE:" + json.dumps(item) + "\n")
        sys.stderr.flush()


class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        body = json.dumps({"object": "list", "data": [{"id": "fixture-model", "object": "model"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        value = json.loads(raw)
        if self.path == "/capture":
            capture("mcp", value)
            self.send_response(204)
            self.end_headers()
            return
        capture("provider", {"path": self.path, "request": value})
        messages = value.get("messages") or []
        if any(
            message.get("content") == "hold"
            or any(part.get("text") == "hold" for part in message.get("content", []) if isinstance(part, dict))
            for message in messages
        ):
            time.sleep(30)
        tools = value.get("tools") or []
        tool_names = [item.get("function", {}).get("name") for item in tools]
        tool_reply = any(message.get("role") == "tool" for message in messages)
        tool_available = "mcp__ardur__fixture_echo" in tool_names
        if not tool_reply and tool_available:
            delta = {
                "role": "assistant",
                "tool_calls": [{
                    "index": 0,
                    "id": "call_fixture_1",
                    "type": "function",
                    "function": {
                        "name": "mcp__ardur__fixture_echo",
                        "arguments": '{"value":"hello"}',
                    },
                }],
            }
            finish = "tool_calls"
        else:
            delta = {"role": "assistant", "content": "completed"}
            finish = "stop"
        if value.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            for part in (
                {"id": "chatcmpl-fixture", "object": "chat.completion.chunk", "created": 0, "model": "fixture-model", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                {"id": "chatcmpl-fixture", "object": "chat.completion.chunk", "created": 0, "model": "fixture-model", "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]},
            ):
                self.wfile.write(f"data: {json.dumps(part)}\n\n".encode())
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        else:
            body = json.dumps({
                "id": "chatcmpl-fixture",
                "object": "chat.completion",
                "created": 0,
                "model": "fixture-model",
                "choices": [{"index": 0, "message": delta, "finish_reason": finish}],
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


def report_mcp(value):
    data = json.dumps(value).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}/capture",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=2).close()
    except Exception:
        pass


def mcp():
    for line in sys.stdin:
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = value.get("method")
        if method == "tools/list":
            report_mcp({"event": "tool-discovery"})
            result = {"tools": [{
                "name": "fixture_echo",
                "description": "Return the supplied value.",
                "inputSchema": {"type": "object", "properties": {"value": {"type": "string"}}},
            }]}
        elif method == "tools/call":
            report_mcp({"event": "tool-call", "params": value.get("params")})
            result = {"content": [{"type": "text", "text": "echoed"}], "isError": False}
        elif method == "initialize":
            result = {
                "protocolVersion": value.get("params", {}).get("protocolVersion", "2025-06-18"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "fixture", "version": "0.1.0"},
            }
        else:
            if "id" not in value:
                continue
            result = {}
        if "id" in value:
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": value["id"], "result": result}) + "\n")
            sys.stdout.flush()


def launcher():
    home = Path("/tmp/hermes")
    home.mkdir(mode=0o700)
    Path("/work").mkdir(exist_ok=True)
    for name in ("config.yaml", "SOUL.md"):
        source = Path("/fixtures") / name
        if source.exists():
            (home / name).write_bytes(source.read_bytes())
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Provider)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env = {
        "HOME": str(home),
        "HERMES_HOME": str(home),
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "HERMES_ACP_SKIP_CONFIGURED_MCP": "1",
        "ARDUR_HERMES_PROVIDER_KEY": os.environ["ARDUR_HERMES_PROVIDER_KEY"],
    }
    child = subprocess.Popen(
        ["/opt/hermes/.venv/bin/hermes-acp"],
        stdin=sys.stdin.buffer,
        stdout=sys.stdout.buffer,
        stderr=subprocess.DEVNULL,
        cwd="/work",
        env=env,
    )

    def stop(_signal, _frame):
        child.terminate()

    signal.signal(signal.SIGTERM, stop)
    try:
        child.wait()
    finally:
        server.shutdown()


if __name__ == "__main__":
    if sys.argv[1] == "mcp":
        mcp()
    else:
        launcher()
