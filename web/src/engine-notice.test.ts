import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { zhTW } from "./locale/zh-TW";

describe("external engine notice (M10: the web build uses only the built-in engine)", () => {
  it("tells the user the web version is built-in only and points to the command line", () => {
    const text = zhTW.review.externalEngineNotice;
    expect(text).toContain("內建引擎");
    expect(text).toContain("外接強引擎");
    expect(text).toContain("命令列");
    expect(text).toContain("scripts/review-with-engine.sh");
  });

  it("is rendered next to the review controls from the locale file, not hard-coded", () => {
    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/id="review-engine-notice"[^>]*>\$\{zhTW\.review\.externalEngineNotice\}/);
    expect(main).not.toContain("外接強引擎請用命令列");
  });
});
