import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

describe("web application shell", () => {
  it("provides the mount point and loads the TypeScript entry", () => {
    expect(html).toContain('id="app"');
    expect(html).toContain('type="module" src="/src/main.ts"');
  });
});
