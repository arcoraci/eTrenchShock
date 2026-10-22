"""Serve Trench Shock on this computer, plus a localhost-only update check.

The page is static. This process serves those files the same way
``python -m http.server`` does, and it is the only place that runs git.
"""

import json
import os
import re
import shutil
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = 8080
ORIGIN = f"http://{HOST}:{PORT}"
_git_lock = threading.Lock()
_BRANCH_NAME = re.compile(r"[A-Za-z0-9._/-]+")
_CACHE_TOKEN = re.compile(r"[A-Za-z0-9._-]{1,80}")
_FROM_SPEC = re.compile(r"""(\bfrom\s+)(['"])(\.\.?/[^'"]+)\2""")
_LOCAL_NEWER = "This copy already has newer local work than GitHub."


def loopback(address):
    host = address[0] if address else ""
    if host.startswith("::ffff:"):
        host = host.split("::ffff:", 1)[1]
    return host in ("127.0.0.1", "::1")


def git_env():
    env = os.environ.copy()
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_NAMESPACE"):
        env.pop(key, None)
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GCM_INTERACTIVE"] = "Never"
    return env


def run_git(args, timeout=30):
    kwargs = {
        "args": ["git", *args],
        "cwd": str(ROOT),
        "capture_output": True,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "timeout": timeout,
        "stdin": subprocess.DEVNULL,
        "env": git_env(),
    }
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        return subprocess.run(**kwargs)
    except subprocess.TimeoutExpired:
        return None
    except FileNotFoundError:
        return None


def git_text(result):
    if result is None:
        return "git timed out."
    text = (result.stderr or result.stdout or "").strip()
    if len(text) > 2000:
        text = text[:2000]
    return text


def same_repo(path_text):
    try:
        return Path(path_text.strip()).resolve() == ROOT.resolve()
    except OSError:
        return False


def git_missing():
    return shutil.which("git") is None


def is_clone():
    return (ROOT / ".git").exists()


def current_branch():
    result = run_git(["rev-parse", "--abbrev-ref", "HEAD"], timeout=15)
    if result is None or result.returncode != 0:
        return ""
    return result.stdout.strip()


def safe_branch(name):
    if not name or name == "HEAD" or name.startswith("-") or ".." in name:
        return None
    if not _BRANCH_NAME.fullmatch(name):
        return None
    return name


def cache_token(query):
    raw = (parse_qs(query, keep_blank_values=False).get("v") or [""])[0]
    if _CACHE_TOKEN.fullmatch(raw or ""):
        return raw
    return ""


def bust_imports(text, token):
    """Give each relative module a new URL so a normal browser cache misses."""

    def repl(match):
        prefix, quote, spec = match.group(1), match.group(2), match.group(3)
        if "?" in spec:
            return match.group(0)
        return f"{prefix}{quote}{spec}?v={token}{quote}"

    return _FROM_SPEC.sub(repl, text)


def index_html(token):
    text = (ROOT / "index.html").read_text(encoding="utf-8")
    if not token:
        return text
    text = text.replace('src="src/ui/app.js"', f'src="src/ui/app.js?v={token}"')
    text = text.replace("src='src/ui/app.js'", f"src='src/ui/app.js?v={token}'")
    text = text.replace('href="src/styles.css"', f'href="src/styles.css?v={token}"')
    text = text.replace("href='src/styles.css'", f"href='src/styles.css?v={token}'")
    return text


def safe_file(url_path):
    rel = unquote(url_path).lstrip("/")
    if not rel or rel.endswith("/"):
        return None
    candidate = (ROOT / rel).resolve()
    try:
        candidate.relative_to(ROOT)
    except ValueError:
        return None
    if not candidate.is_file():
        return None
    return candidate


def merge_conflict():
    listed = run_git(["ls-files", "-u"], timeout=15)
    if listed is not None and listed.returncode == 0 and listed.stdout.strip():
        return True
    diff = run_git(["diff", "--name-only", "--diff-filter=U"], timeout=15)
    return diff is not None and diff.returncode == 0 and bool(diff.stdout.strip())


def this_repo():
    top = run_git(["rev-parse", "--show-toplevel"], timeout=15)
    if top is None or top.returncode != 0:
        return False
    return same_repo(top.stdout)


def working_tree_dirty():
    result = run_git(["status", "--porcelain"], timeout=15)
    if result is None or result.returncode != 0:
        return None
    return bool(result.stdout.strip())


def local_newer_payload():
    return {
        "ok": True,
        "git": True,
        "clone": True,
        "updated": False,
        "reload": True,
        "localNewer": True,
        "upToDate": False,
        "behind": False,
        "message": _LOCAL_NEWER,
    }


def local_changes_blocked(text):
    low = (text or "").lower()
    return (
        "would be overwritten" in low
        or "please commit your changes or stash" in low
        or "local changes to the following files" in low
        or "untracked working tree files" in low
    )


def plain_pull_error(text):
    low = (text or "").lower()
    if (
        "not possible to fast-forward" in low
        or "diverging branches" in low
        or "divergent branches" in low
        or "need to specify how to reconcile" in low
    ):
        return "This copy and GitHub have different commits. Update was not applied."
    if (
        "could not resolve host" in low
        or "failed to connect" in low
        or "unable to access" in low
        or "could not read from remote" in low
        or "timed out" in low
    ):
        return "Could not reach GitHub. Check the connection and try again."
    if "authentication failed" in low or "permission denied" in low or "terminal prompts disabled" in low:
        return "GitHub refused the update. This copy was left as it is."
    if "merge conflict" in low or "fix conflicts" in low:
        return "This copy has a merge conflict. Update was not run."
    cleaned = " ".join((text or "").split())
    if not cleaned:
        return "The update failed."
    if len(cleaned) > 280:
        cleaned = cleaned[:280].rstrip() + "."
    return cleaned


def already_current(text):
    low = (text or "").lower()
    return "already up to date" in low or "already up-to-date" in low


def rev_count(spec):
    result = run_git(["rev-list", "--count", spec], timeout=20)
    if result is None or result.returncode != 0:
        return None
    try:
        return int(result.stdout.strip())
    except ValueError:
        return None


def status():
    if git_missing():
        return {
            "ok": False,
            "git": False,
            "clone": False,
            "upToDate": False,
            "behind": False,
            "message": "Git is not installed.",
        }
    if not is_clone():
        return {
            "ok": True,
            "git": True,
            "clone": False,
            "upToDate": False,
            "behind": False,
            "message": "This folder is not a git clone.",
        }
    if not this_repo():
        return {
            "ok": False,
            "git": True,
            "clone": True,
            "upToDate": False,
            "behind": False,
            "reload": False,
            "message": "This folder is not the git repo being served.",
        }
    if merge_conflict():
        return {
            "ok": True,
            "git": True,
            "clone": True,
            "branch": current_branch(),
            "conflict": True,
            "upToDate": False,
            "behind": False,
            "reload": False,
            "message": "This copy has a merge conflict. Update was not run.",
        }
    dirty = working_tree_dirty()
    if dirty is None:
        return {
            "ok": False,
            "git": True,
            "clone": True,
            "branch": current_branch(),
            "upToDate": False,
            "behind": False,
            "reload": False,
            "message": "Could not read this copy. Update was not run.",
        }
    if dirty:
        payload = local_newer_payload()
        payload.update({
            "git": True,
            "clone": True,
            "branch": current_branch(),
            "conflict": False,
            "dirty": True,
        })
        return payload
    local = run_git(["rev-parse", "master"], timeout=15)
    if local is None or local.returncode != 0:
        return {
            "ok": False,
            "git": True,
            "clone": True,
            "branch": current_branch(),
            "upToDate": False,
            "behind": False,
            "reload": False,
            "message": plain_pull_error(git_text(local)) if git_text(local) else "Could not read the local master commit.",
        }
    local_commit = local.stdout.strip()
    fetched = run_git(["fetch", "origin", "master"], timeout=60)
    if fetched is None or fetched.returncode != 0:
        return {
            "ok": False,
            "git": True,
            "clone": True,
            "branch": current_branch(),
            "localCommit": local_commit,
            "upToDate": False,
            "behind": False,
            "reload": False,
            "message": plain_pull_error(git_text(fetched)),
        }
    remote = run_git(["rev-parse", "origin/master"], timeout=15)
    if remote is None or remote.returncode != 0:
        return {
            "ok": False,
            "git": True,
            "clone": True,
            "branch": current_branch(),
            "localCommit": local_commit,
            "upToDate": False,
            "behind": False,
            "reload": False,
            "message": plain_pull_error(git_text(remote)) if git_text(remote) else "Could not read origin/master.",
        }
    remote_commit = remote.stdout.strip()
    behind_n = rev_count("master..origin/master")
    ahead_n = rev_count("origin/master..master")
    if behind_n is None or ahead_n is None:
        return {
            "ok": False,
            "git": True,
            "clone": True,
            "branch": current_branch(),
            "localCommit": local_commit,
            "remoteCommit": remote_commit,
            "upToDate": False,
            "behind": False,
            "reload": False,
            "message": "Could not compare master with origin/master.",
        }
    up_to_date = behind_n == 0 and ahead_n == 0
    fast_forward = behind_n > 0 and ahead_n == 0
    on_master = current_branch() == "master"
    local_newer = ahead_n > 0 and behind_n == 0
    if up_to_date:
        message = "The game is already the latest."
        reload = True
    elif fast_forward and on_master:
        message = "A newer version is on origin/master."
        reload = False
    elif fast_forward:
        message = "origin/master is newer, but this copy is not on master. Update was not run."
        reload = False
    elif local_newer:
        message = _LOCAL_NEWER
        reload = True
    else:
        message = "This copy and GitHub have different commits. Update was not applied."
        reload = True
    return {
        "ok": True,
        "git": True,
        "clone": True,
        "branch": current_branch(),
        "localCommit": local_commit,
        "remoteCommit": remote_commit,
        "behind": fast_forward and on_master,
        "ahead": ahead_n > 0,
        "conflict": False,
        "dirty": False,
        "localNewer": local_newer,
        "reload": reload,
        "upToDate": up_to_date,
        "message": message,
    }


def pull():
    """Fast-forward the current branch of this repo. No other git command runs."""
    if git_missing():
        return 200, {
            "ok": False,
            "git": False,
            "clone": False,
            "message": "Git is not installed.",
        }
    if not is_clone():
        return 200, {
            "ok": False,
            "git": True,
            "clone": False,
            "message": "This folder is not a git clone.",
        }
    if not this_repo():
        return 403, {"ok": False, "message": "Refused. This is not a pull of this repo."}
    if merge_conflict():
        return 409, {"ok": False, "reload": False, "message": "The working tree has a merge conflict. Update was not run."}
    dirty = working_tree_dirty()
    if dirty is None:
        return 200, {"ok": False, "reload": False, "message": "Could not read this copy. Update was not run."}
    if dirty:
        # Local edits stay. A fast-forward would stop or, worse, mix with them.
        return 200, local_newer_payload()
    branch = safe_branch(current_branch())
    if not branch:
        return 409, {"ok": False, "reload": False, "message": "This copy is not on a branch. Update was not run."}
    # Fixed argv: fast-forward this repo's current branch. The request body is never a command.
    result = run_git(["pull", "--ff-only", "origin", branch], timeout=120)
    if result is None or result.returncode != 0:
        text = git_text(result)
        if local_changes_blocked(text):
            return 200, local_newer_payload()
        return 200, {"ok": False, "reload": False, "message": plain_pull_error(text)}
    text = (result.stdout or result.stderr or "").strip()
    if already_current(text):
        return 200, {
            "ok": True,
            "updated": False,
            "reload": True,
            "localNewer": False,
            "upToDate": True,
            "message": "The game is already the latest.",
        }
    return 200, {
        "ok": True,
        "updated": True,
        "reload": True,
        "localNewer": False,
        "upToDate": False,
        "message": "The update is downloaded.",
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        if not getattr(self, "_cache_locked", False):
            self.send_header("Cache-Control", "no-store, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def _send_bytes(self, body, content_type, extra_headers=None):
        data = body if isinstance(body, (bytes, bytearray)) else body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in extra_headers or ():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def _json(self, data, code=200):
        body = json.dumps(data).encode("utf-8")
        self._cache_locked = True
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _reject(self, code, message):
        self._json({"ok": False, "message": message}, code)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/local-update/status":
            if not loopback(self.client_address) or self.headers.get("X-Trench-Local") != "1":
                self._reject(403, "Update status is only available on this computer.")
                return
            with _git_lock:
                payload = status()
            self._json(payload)
            return
        token = cache_token(parsed.query)
        if path in ("/", "/index.html"):
            try:
                body = index_html(token)
            except OSError:
                self.send_error(404, "Not found")
                return
            extra = [("Clear-Site-Data", '"cache"')] if token else None
            self._send_bytes(body, "text/html; charset=utf-8", extra)
            return
        if token and path.endswith(".js"):
            file = safe_file(path)
            if file is None:
                self.send_error(404, "Not found")
                return
            try:
                text = bust_imports(file.read_text(encoding="utf-8"), token)
            except OSError:
                self.send_error(404, "Not found")
                return
            self._send_bytes(text, "text/javascript; charset=utf-8")
            return
        return SimpleHTTPRequestHandler.do_GET(self)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._reject(400, "Refused.")
            return
        if length < 0 or length > 4096:
            self._reject(400, "Refused.")
            return
        if length:
            self.rfile.read(length)
        if path != "/local-update/pull":
            self.send_error(404, "Not found")
            return
        if not loopback(self.client_address):
            self._reject(403, "Update only runs on this computer.")
            return
        origin = self.headers.get("Origin")
        if origin and origin.rstrip("/") != ORIGIN:
            self._reject(403, "Update only runs on this computer.")
            return
        if self.headers.get("X-Trench-Local") != "1":
            self._reject(403, "Update only runs on this computer.")
            return
        with _git_lock:
            code, payload = pull()
        self._json(payload, code)


def main():
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as err:
        print(f"Could not listen on {ORIGIN}.", flush=True)
        print(err, flush=True)
        return 1
    server.daemon_threads = True
    print("Trench Shock", flush=True)
    print(f"Open {ORIGIN} if the browser does not.", flush=True)
    print("Leave this window open while you play.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
