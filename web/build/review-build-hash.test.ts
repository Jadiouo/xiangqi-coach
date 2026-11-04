import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeReviewBuildHash } from "./review-build-hash";

const dirs: string[] = [];
function fixture(files: Record<string, string>): { root: string; names: string[] } {
  const root = mkdtempSync(join(tmpdir(), "review-hash-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  return { root, names: Object.keys(files) };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("computeReviewBuildHash", () => {
  it("is stable for the same content", () => {
    const { root, names } = fixture({ "a.wasm": "one", "b.js": "two" });
    expect(computeReviewBuildHash(root, names, "build")).toBe(computeReviewBuildHash(root, names, "build"));
    expect(computeReviewBuildHash(root, names, "build")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when a hashed file's content changes", () => {
    const { root, names } = fixture({ "a.wasm": "one", "b.js": "two" });
    const before = computeReviewBuildHash(root, names, "build");
    writeFileSync(join(root, "a.wasm"), "ONE");
    expect(computeReviewBuildHash(root, names, "build")).not.toBe(before);
  });

  it("throws in build mode when a file is missing, telling how to fix it", () => {
    const { root } = fixture({ "a.wasm": "one" });
    expect(() => computeReviewBuildHash(root, ["a.wasm", "gone.js"], "build")).toThrow(/gone\.js/);
    expect(() => computeReviewBuildHash(root, ["a.wasm", "gone.js"], "build")).toThrow(/npm run wasm:build/);
  });

  it("in serve mode a missing file does not throw and is not a fixed string", () => {
    const { root } = fixture({ "a.wasm": "one" });
    const first = computeReviewBuildHash(root, ["a.wasm", "gone.js"], "serve", () => 1000);
    const later = computeReviewBuildHash(root, ["a.wasm", "gone.js"], "serve", () => 2000);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(later).not.toBe(first);
  });

  it("in serve mode a present file still hashes by content", () => {
    const { root, names } = fixture({ "a.wasm": "one" });
    const before = computeReviewBuildHash(root, names, "serve");
    writeFileSync(join(root, "a.wasm"), "two");
    expect(computeReviewBuildHash(root, names, "serve")).not.toBe(before);
  });
});
