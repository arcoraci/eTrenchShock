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
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = 8080
ORIGIN = f"http://{HOST}:{PORT}"
_git_lock = threading.Lock()
_BRANCH_NAME = re.compile(r"[A-Za-z0-9._/-]+")


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
            "message": "This folder is not the git repo being served.",
        }
    local = run_git(["rev-parse", "master"], timeout=15)
    if local is None or local.returncode != 0:
        return {
            "ok": False,
            "git": True,
            "clone": True,
            "branch": current_branch(),
            "upToDate": False,
            "behind": False,
            "message": git_text(local) or "Could not read the local master commit.",
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
            "message": git_text(fetched) or "Could not reach origin/master.",
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
            "message": git_text(remote) or "Could not read origin/master.",
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
            "message": "Could not compare master with origin/master.",
        }
    up_to_date = behind_n == 0 and ahead_n == 0
    fast_forward = behind_n > 0 and ahead_n == 0
    on_master = current_branch() == "master"
    if up_to_date:
        message = "The game is already the latest."
    elif fast_forward and on_master:
        message = "A newer version is on origin/master."
    elif fast_forward:
        message = "origin/master is newer, but this copy is not on master. Update was not run."
    else:
        message = "This copy and origin/master have different commits. Update was not run."
    return {
        "ok": True,
        "git": True,
        "clone": True,
        "branch": current_branch(),
        "localCommit": local_commit,
        "remoteCommit": remote_commit,
        "behind": fast_forward and on_master,
        "ahead": ahead_n > 0,
        "conflict": merge_conflict(),
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
        return 409, {"ok": False, "message": "The working tree has a merge conflict. Update was not run."}
    branch = safe_branch(current_branch())
    if not branch:
        return 409, {"ok": False, "message": "This copy is not on a branch. Update was not run."}
    # Fixed argv: fast-forward this repo's current branch. The request body is never a command.
    result = run_git(["pull", "--ff-only", "origin", branch], timeout=120)
    if result is None or result.returncode != 0:
        return 200, {"ok": False, "message": git_text(result) or "git pull failed."}
    text = (result.stdout or result.stderr or "").strip()
    updated = "Already up to date" not in text
    return 200, {"ok": True, "updated": updated, "message": text or "Updated."}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _json(self, data, code=200):
        body = json.dumps(data).encode("utf-8")
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
        path = urlparse(self.path).path
        if path != "/local-update/status":
            return SimpleHTTPRequestHandler.do_GET(self)
        if not loopback(self.client_address) or self.headers.get("X-Trench-Local") != "1":
            self._reject(403, "Update status is only available on this computer.")
            return
        with _git_lock:
            payload = status()
        self._json(payload)

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
