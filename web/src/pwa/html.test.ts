import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PWA_THEME_COLOR } from "./config";

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../index.html"), "utf8");

describe("index.html", () => {
  it("links the manifest relative to the base and sets the same theme colour", () => {
    expect(html).toContain('<link rel="manifest" href="%BASE_URL%manifest.webmanifest"');
    expect(html).toContain(`<meta name="theme-color" content="${PWA_THEME_COLOR}"`);
    expect(html).toContain('href="%BASE_URL%icons/icon-192.png"');
  });
});
