import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitPwaFiles } from "./plugin";

function fakeDist(): string {
  const root = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "pwa-dist-"));
  const put = (p: string, c: string | Uint8Array) => {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  };
  put("index.html", "<!doctype html>");
  put("assets/index-1.js", "x");
  put("assets/game.worker-2.js", "w");
  put("wasm/xq_wasm.js", "j");
  put("wasm/xq_wasm_bg.wasm", new Uint8Array([0, 97, 115, 109]));
  return dir;
}

describe("emitPwaFiles", () => {
  it("writes manifest, icons and a service worker whose list contains every build output", async () => {
    const dir = fakeDist();
    const { version, urls } = await emitPwaFiles(dir, "/xiangqi-coach/");
    for (const f of ["manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/icon.svg", "sw.js"])
      expect(existsSync(join(dir, f)), f).toBe(true);
    const sw = readFileSync(join(dir, "sw.js"), "utf8");
    expect(sw).toContain(version);
    for (const u of ["/xiangqi-coach/wasm/xq_wasm_bg.wasm", "/xiangqi-coach/wasm/xq_wasm.js", "/xiangqi-coach/assets/game.worker-2.js", "/xiangqi-coach/assets/index-1.js", "/xiangqi-coach/manifest.webmanifest", "/xiangqi-coach/icons/icon-512.png"]) {
      expect(urls).toContain(u);
      expect(sw).toContain(u);
    }
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.webmanifest"), "utf8"));
    expect(manifest.scope).toBe("/xiangqi-coach/");
  });

  it("is reproducible: same build output gives the same version", async () => {
    const a = await emitPwaFiles(fakeDist(), "/x/");
    const b = await emitPwaFiles(fakeDist(), "/x/");
    expect(a.version).toBe(b.version);
  });
});
