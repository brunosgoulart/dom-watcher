"""Local static preview that forwards the read-only API without changing it."""
from __future__ import annotations

import argparse
import http.client
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "web"

def handler(api_port: int):
    class PreviewHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.split("?", 1)[0] == "/api/v1/status":
                connection = http.client.HTTPConnection("127.0.0.1", api_port, timeout=5)
                try:
                    connection.request("GET", "/api/v1/status")
                    response = connection.getresponse()
                    body = response.read()
                    self.send_response(response.status)
                    self.send_header("Content-Type", response.getheader("Content-Type", "application/json; charset=utf-8"))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers(); self.wfile.write(body)
                finally:
                    connection.close()
                return
            relative = self.path.split("?", 1)[0].lstrip("/") or "index.html"
            target = (ROOT / relative).resolve()
            if ROOT not in target.parents and target != ROOT or not target.is_file():
                self.send_error(404); return
            body = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(str(target))[0] or "application/octet-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body)
        def log_message(self, format, *args): pass
    return PreviewHandler

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8769)
    parser.add_argument("--api-port", type=int, default=8768)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler(args.api_port))
    print(f"Interface preview: http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()
