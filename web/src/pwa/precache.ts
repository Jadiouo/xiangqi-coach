import { createHash } from "node:crypto";

export interface BuildFile {
  path: string; // relative to the build output dir, posix separators
  content: string | Uint8Array;
}

export function normalizeBase(base: string): string {
  const trimmed = base.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "/" : `/${trimmed}/`;
}

// _headers/_redirects are Cloudflare Pages config: the host reads them but does not serve them (404).
const isExcluded = (path: string) => path === "sw.js" || path === "_headers" || path === "_redirects" || path.endsWith(".map");

/** URL list + a version that is a hash of every precached file's path and bytes. */
export function buildPrecache(files: BuildFile[], rawBase: string): { urls: string[]; version: string } {
  const base = normalizeBase(rawBase);
  const kept = files.filter((f) => !isExcluded(f.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  const urls = new Set<string>();
  for (const f of kept) {
    hash.update(`${f.path}\0${typeof f.content === "string" ? Buffer.byteLength(f.content) : f.content.byteLength}\0`);
    hash.update(f.content);
    urls.add(base + f.path);
    if (f.path === "index.html") urls.add(base);
  }
  return { urls: [...urls].sort(), version: hash.digest("hex").slice(0, 12) };
}
