import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guard: the analysis cache version hashes only the wasm files and review.worker.ts itself
// (web/vite.config.ts). If the worker pulled in other code at run time, a change there could
// change results without changing the hash.
describe("review.worker.ts dependencies", () => {
  const source = readFileSync(new URL("./review.worker.ts", import.meta.url), "utf8");
  const hint =
    "worker 加了執行期依賴時，必須把那些檔案加進 review 快取雜湊範圍（vite.config.ts）";

  it("only has type-only imports", () => {
    const imports = source.match(/^\s*import\b[^;]*;/gm) ?? [];
    const runtime = imports.filter((line) => !/^\s*import\s+type\b/.test(line));
    expect(runtime, hint).toEqual([]);
  });

  it("has no re-exports from other modules or importScripts", () => {
    expect(/^\s*export\b[^;]*\bfrom\s/m.test(source), hint).toBe(false);
    expect(/\bimportScripts\s*\(/.test(source), hint).toBe(false);
  });

  it("has exactly one dynamic import(), of the hashed wasm glue", () => {
    // The worker loads the engine glue (public/wasm/xq_wasm.js, in the hash) with import(wasmUrl).
    const calls = source.match(/\bimport\s*\(/g) ?? [];
    expect(calls.length, hint).toBe(1);
    expect(source, hint).toMatch(/import\(\/\*\s*@vite-ignore\s*\*\/\s*wasmUrl\)/);
    expect(source, hint).toContain("wasm/xq_wasm.js");
  });
});
