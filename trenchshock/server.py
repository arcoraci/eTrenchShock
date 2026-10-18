import json
import mimetypes
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from .loop import run_until_human
from .setup import create_game
from .game import apply
from .view import enrich

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "src" / "data"

_lock = threading.Lock()
_catalog = None
_state = None


def load_catalog():
    global _catalog
    if _catalog is None:
        events = json.loads((DATA / "events.json").read_text(encoding="utf-8"))
        missions = json.loads((DATA / "missions.json").read_text(encoding="utf-8"))
        _catalog = {"events": events, "missions": missions}
    return _catalog


def start_game():
    catalog = load_catalog()
    state = create_game(catalog["events"], catalog["missions"], format="standard", human="uk")
    return run_until_human(state)


def payload(state):
    return {"state": enrich(state)}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        print(f"[trenchshock] {self.address_string()} {fmt % args}")

    def _json(self, data, code=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8") or "{}")

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            with _lock:
                self._json(payload(_state))
            return
        if path == "/":
            self.path = "/index.html"
        return SimpleHTTPRequestHandler.do_GET(self)

    def do_POST(self):
        global _state
        path = urlparse(self.path).path
        if path == "/api/start":
            with _lock:
                _state = start_game()
                self._json(payload(_state))
            return
        if path == "/api/action":
            action = self._read_json()
            with _lock:
                if _state is None:
                    self._json({"error": "No game in progress."}, 400)
                    return
                nxt = apply(_state, action)
                if not nxt.get("error"):
                    nxt = run_until_human(nxt)
                _state = nxt
                self._json(payload(_state))
            return
        self.send_error(404, "Unknown API route")

    def guess_type(self, path):
        guessed, _ = mimetypes.guess_type(path)
        if guessed:
            return guessed
        if str(path).endswith(".js"):
            return "application/javascript"
        return SimpleHTTPRequestHandler.guess_type(self, path)


def serve(host="127.0.0.1", port=8080):
    load_catalog()
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"Trench Shock (Python) at http://{host}:{port}", flush=True)
    httpd.serve_forever()
