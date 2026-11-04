// Minimal static server that serves a built dist/ ONLY under a sub-path (like GitHub Pages).
// Usage: node e2e/serve-subpath.mjs <dir> <basePath> <port>
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const [dir, base, port] = process.argv.slice(2);
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (!path.startsWith(base)) { res.writeHead(404).end("not under base path"); return; }
  let rel = normalize(path.slice(base.length));
  if (rel.startsWith("..")) { res.writeHead(403).end(); return; }
  let file = join(dir, rel);
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(Number(port), "127.0.0.1");
