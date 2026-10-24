#!/usr/bin/env node
/**
 * Rebuild player/ from the current readable game.
 * Reads src/ and index.html. Writes only under player/. Does not minify or edit src/.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "player");
const assetsDir = join(root, "assets");
const dataDir = join(root, "src", "data");
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const SOURCE_COMMENT = "The toggle still changes for this page view if storage is blocked.";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(dir);
  return out;
}

function hashTree(dir) {
  const hash = createHash("sha256");
  const files = listFiles(dir)
    .map((file) => relative(root, file).replaceAll("\\", "/"))
    .sort();
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(root, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function sourceTexts() {
  const files = [join(root, "index.html"), ...listFiles(join(root, "src"))];
  return files.filter((file) => /\.(js|css|html)$/i.test(file)).map((file) => readText(file)).join("\n");
}

function assetIndex() {
  const index = new Map();
  for (const file of listFiles(assetsDir)) {
    const rel = relative(assetsDir, file).replaceAll("\\", "/");
    index.set(rel.toLowerCase(), { rel, file });
  }
  return index;
}

function referencedAssets(text, index) {
  const wanted = new Map();
  const add = (rel) => {
    const found = index.get(rel.toLowerCase());
    if (!found) return false;
    wanted.set(found.rel, found.file);
    return true;
  };
  const missing = [];
  const pattern = /assets\/([A-Za-z0-9_./-]+\.(?:png|jpe?g|gif|webp|svg|avif))/gi;
  for (const match of text.matchAll(pattern)) {
    const rel = match[1];
    if (!add(rel)) missing.push(rel);
  }
  for (const { rel, file } of index.values()) {
    const base = rel.split("/").pop();
    if (text.includes(base) || /^game-board\./i.test(base)) add(rel);
    else if (IMAGE.test(file) && text.includes(rel)) add(rel);
  }
  return { wanted, missing };
}

function rewriteIndex(html) {
  const css = /(<link\s+rel=["']stylesheet["']\s+href=["'])src\/styles\.css(["'])/i;
  const script = /(<script\s+type=["']module["']\s+src=["'])src\/ui\/app\.js(["'])/i;
  if (!css.test(html)) fail("index.html has no src/styles.css stylesheet link.");
  if (!script.test(html)) fail("index.html has no src/ui/app.js module script.");
  const next = html.replace(css, "$1game.css$2").replace(script, "$1ui/game.js$2");
  if (next.includes("src/styles.css") || next.includes("src/ui/app.js")) {
    fail("player index.html still points at the readable source.");
  }
  if (/<(?:script|link)\b[^>]+(?:src|href)=["']https?:/i.test(next)) {
    fail("player index.html would load a remote script or stylesheet.");
  }
  return next;
}

function esbuild(args) {
  const result = spawnSync("npx", ["--yes", "esbuild", ...args], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function writePlayerServer() {
  const serve = `#!/usr/bin/env python3
"""Serve the minified player copy on port 8081.

The development server (serve.py in the project root) is port 8080 and only
serves the folder that contains it. Run this file from the player folder.
"""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = 8081

TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".html": "text/html",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def guess_type(self, path):
        return TYPES.get(Path(path).suffix.lower(), super().guess_type(path))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    if PORT == 8080:
        print("Refusing to use port 8080. That port is the development game.", flush=True)
        return 1
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as err:
        print(f"Could not listen on http://{HOST}:{PORT}.", flush=True)
        print(err, flush=True)
        return 1
    print("Trench Shock player copy", flush=True)
    print(f"Open http://{HOST}:{PORT} if the browser does not.", flush=True)
    print("Leave this window open while you play.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\\nStopped.", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;
  writeFileSync(join(outDir, "serve.py"), serve.replaceAll("\r\n", "\n"), "utf8");

  const start = [
    "@echo off",
    'cd /d "%~dp0"',
    "echo.",
    "echo  Trench Shock player copy",
    "echo  Open http://127.0.0.1:8081 if the browser does not.",
    "echo  Port 8080 is the readable development game. This window uses 8081.",
    "echo.",
    'start "" cmd /c "ping -n 2 127.0.0.1 >nul & start http://127.0.0.1:8081"',
    "python serve.py",
    "if errorlevel 1 py serve.py",
    "pause",
    "",
  ].join("\r\n");
  writeFileSync(join(outDir, "start.bat"), start, "utf8");

  const note = `Trench Shock player copy
This folder is the minified game. The readable source stays in src/ one folder up.

Windows: double-click start.bat
Mac or Linux: python3 serve.py

Then open http://127.0.0.1:8081
Leave that window open while you play. Do not use port 8080 for this folder.
`;
  writeFileSync(join(outDir, "PLAY.txt"), note.replaceAll("\r\n", "\n"), "utf8");
}

function main() {
  const srcBefore = hashTree(join(root, "src"));
  const text = sourceTexts();
  const index = assetIndex();
  const { wanted, missing } = referencedAssets(text, index);
  if (missing.length) fail(`Source requests missing assets: ${missing.join(", ")}`);
  if (!wanted.size) fail("No assets were referenced. Refusing to build an empty player copy.");

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "ui"), { recursive: true });
  mkdirSync(join(outDir, "assets"), { recursive: true });
  mkdirSync(join(outDir, "data"), { recursive: true });

  esbuild([
    "src/ui/app.js",
    "--bundle",
    "--minify",
    "--format=esm",
    "--legal-comments=none",
    "--charset=utf8",
    "--outfile=player/ui/game.js",
  ]);
  esbuild([
    "src/styles.css",
    "--minify",
    "--legal-comments=none",
    "--charset=utf8",
    "--outfile=player/game.css",
  ]);

  writeFileSync(join(outDir, "index.html"), rewriteIndex(readText(join(root, "index.html"))), "utf8");

  for (const [rel, file] of wanted) {
    const dest = join(outDir, "assets", rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file, dest);
  }

  const jsonFiles = listFiles(dataDir).filter((file) => file.toLowerCase().endsWith(".json"));
  if (!jsonFiles.length) fail("src/data has no JSON catalogs.");
  for (const file of jsonFiles) {
    copyFileSync(file, join(outDir, "data", relative(dataDir, file)));
  }
  for (const name of ["events.json", "missions.json"]) {
    if (!existsSync(join(outDir, "data", name))) fail(`Missing player/data/${name}`);
  }

  writePlayerServer();

  const jsPath = join(outDir, "ui", "game.js");
  const cssPath = join(outDir, "game.css");
  const js = readText(jsPath);
  const css = readText(cssPath);
  const version = readText(join(root, "src", "version.js")).match(/GAME_VERSION\s*=\s*["']([^"']+)["']/);
  if (!version) fail("Could not read GAME_VERSION.");
  if (!js.includes(version[1])) fail("Minified script is missing the game version string.");
  if (!js.includes("../data/") || !js.includes("import.meta.url")) {
    fail("Minified script lost the catalog path. player/data would not load.");
  }
  if (js.includes(SOURCE_COMMENT) || css.includes(SOURCE_COMMENT)) fail("A source comment was copied into the player build.");
  if (js.includes("/*") || css.includes("/*")) fail("The player build still contains a block comment.");
  if (js.includes("sourceMappingURL") || css.includes("sourceMappingURL")) fail("The player build contains a source map URL.");
  if (existsSync(join(outDir, "src"))) fail("player/src was created. The readable modules must not be copied.");
  for (const file of listFiles(outDir)) {
    if (file.endsWith(".map")) fail(`Source map written: ${relative(root, file)}`);
    if (file.endsWith(".js") && !file.endsWith(`${join("ui", "game.js")}`) && !file.endsWith("serve.py")) {
      const rel = relative(outDir, file).replaceAll("\\", "/");
      if (rel !== "ui/game.js") fail(`Unexpected script in the player folder: ${rel}`);
    }
  }
  const syntax = spawnSync(process.execPath, ["--check", jsPath], { stdio: "inherit", windowsHide: true });
  if (syntax.status !== 0) fail("Minified script failed the syntax check.");

  const srcAfter = hashTree(join(root, "src"));
  if (srcBefore !== srcAfter) {
    fail("src/ changed while the player copy was built. player/ was written, but src/ was not supposed to change. Another edit may have landed during the build; it was not reverted.");
  }

  const jsBytes = statSync(jsPath).size;
  const cssBytes = statSync(cssPath).size;
  console.log(`player/ ready`);
  console.log(`  script  player/ui/game.js  ${jsBytes} bytes`);
  console.log(`  style   player/game.css    ${cssBytes} bytes`);
  console.log(`  assets  ${wanted.size} files`);
  console.log(`  data    ${jsonFiles.length} catalogs`);
  console.log("Readable source under src/ was not modified.");
}

main();
