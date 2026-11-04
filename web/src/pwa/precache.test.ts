import { describe, expect, it } from "vitest";
import { buildPrecache, normalizeBase } from "./precache";

const files = [
  { path: "index.html", content: "<html>" },
  { path: "assets/index-abc.js", content: "a" },
  { path: "assets/game.worker-def.js", content: "w" },
  { path: "assets/index-abc.css", content: "c" },
  { path: "wasm/xq_wasm.js", content: "j" },
  { path: "wasm/xq_wasm_bg.wasm", content: new Uint8Array([0, 97, 115, 109]) },
  { path: "manifest.webmanifest", content: "{}" },
  { path: "icons/icon-192.png", content: new Uint8Array([1]) },
  { path: "sw.js", content: "sw" },
  { path: "assets/index-abc.js.map", content: "map" },
];

describe("normalizeBase", () => {
  it("gives a leading and trailing slash", () => {
    expect(normalizeBase("/")).toBe("/");
    expect(normalizeBase("")).toBe("/");
    expect(normalizeBase("xiangqi-coach")).toBe("/xiangqi-coach/");
    expect(normalizeBase("/xiangqi-coach/")).toBe("/xiangqi-coach/");
  });
});

describe("precache list", () => {
  it("includes the page, scripts, workers, css, wasm, manifest and icons under the base", () => {
    const { urls } = buildPrecache(files, "/xiangqi-coach/");
    for (const u of [
      "/xiangqi-coach/",
      "/xiangqi-coach/index.html",
      "/xiangqi-coach/assets/index-abc.js",
      "/xiangqi-coach/assets/game.worker-def.js",
      "/xiangqi-coach/assets/index-abc.css",
      "/xiangqi-coach/wasm/xq_wasm.js",
      "/xiangqi-coach/wasm/xq_wasm_bg.wasm",
      "/xiangqi-coach/manifest.webmanifest",
      "/xiangqi-coach/icons/icon-192.png",
    ]) expect(urls).toContain(u);
  });

  it("leaves out the service worker itself and source maps", () => {
    const { urls } = buildPrecache(files, "/xiangqi-coach/");
    expect(urls.some((u) => u.endsWith("/sw.js"))).toBe(false);
    expect(urls.some((u) => u.endsWith(".map"))).toBe(false);
  });

  it("leaves out host config files that static hosts do not serve (Cloudflare Pages _headers/_redirects)", () => {
    const { urls, version } = buildPrecache([...files, { path: "_headers", content: "/*\n  X: y" }, { path: "_redirects", content: "/a /b" }], "/");
    expect(urls.some((u) => u.endsWith("_headers") || u.endsWith("_redirects"))).toBe(false);
    expect(version).toBe(buildPrecache(files, "/").version);
  });

  it("works at the root base", () => {
    const { urls } = buildPrecache(files, "/");
    expect(urls).toContain("/");
    expect(urls).toContain("/wasm/xq_wasm_bg.wasm");
  });

  it("version is stable, order independent, and changes with any content or path change", () => {
    const a = buildPrecache(files, "/x/").version;
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(buildPrecache([...files].reverse(), "/x/").version).toBe(a);
    const edited = files.map((f) => (f.path === "wasm/xq_wasm_bg.wasm" ? { ...f, content: new Uint8Array([9]) } : f));
    expect(buildPrecache(edited, "/x/").version).not.toBe(a);
    expect(buildPrecache([...files, { path: "assets/new.js", content: "n" }], "/x/").version).not.toBe(a);
  });

  it("the service worker file alone does not change the version", () => {
    const a = buildPrecache(files, "/x/").version;
    const b = buildPrecache(files.map((f) => (f.path === "sw.js" ? { ...f, content: "other" } : f)), "/x/").version;
    expect(b).toBe(a);
  });
});
