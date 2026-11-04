import { describe, expect, it } from "vitest";
import { buildManifest } from "./manifest";
import { pwaZhTW } from "../locale/pwa-zh-TW";
import { PWA_THEME_COLOR } from "./config";

describe("web app manifest", () => {
  it("is named 象棋教練 and takes its text from the locale file", () => {
    const m = buildManifest("/xiangqi-coach/");
    expect(m.name).toBe("象棋教練");
    expect(m.name).toBe(pwaZhTW.name);
    expect(m.short_name).toBe(pwaZhTW.shortName);
    expect(m.description).toBe(pwaZhTW.description);
    expect(m.lang).toBe("zh-Hant");
  });

  it("is installable: standalone, start_url, scope and theme colour follow the base path", () => {
    for (const base of ["/xiangqi-coach/", "/"]) {
      const m = buildManifest(base);
      expect(m.display).toBe("standalone");
      expect(m.start_url).toBe(base);
      expect(m.scope).toBe(base);
      expect(m.id).toBe(base);
      expect(m.theme_color).toBe(PWA_THEME_COLOR);
      expect(m.background_color).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("normalises a base given without slashes", () => {
    expect(buildManifest("xiangqi-coach").scope).toBe("/xiangqi-coach/");
  });

  it("lists 192 and 512 PNG icons plus a maskable one, all under the base", () => {
    const m = buildManifest("/xiangqi-coach/");
    const key = (i: { sizes: string; purpose?: string }) => `${i.sizes}/${i.purpose ?? "any"}`;
    expect(m.icons.map(key)).toEqual(expect.arrayContaining(["192x192/any", "512x512/any", "512x512/maskable"]));
    for (const icon of m.icons) {
      expect(icon.type).toBe("image/png");
      expect(icon.src.startsWith("/xiangqi-coach/icons/")).toBe(true);
    }
  });
});
