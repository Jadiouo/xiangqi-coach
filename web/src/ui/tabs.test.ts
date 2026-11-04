import { describe, expect, it } from "vitest";
import { buildHash, parseRoute, ROUTES } from "./tabs";

describe("parseRoute", () => {
  it("parses the four routes", () => {
    expect(parseRoute("#/play")).toBe("play");
    expect(parseRoute("#/review")).toBe("review");
    expect(parseRoute("#/library")).toBe("library");
    expect(parseRoute("#/settings")).toBe("settings");
  });

  it("also accepts the short form without a slash", () => {
    expect(parseRoute("#review")).toBe("review");
    expect(parseRoute("#library")).toBe("library");
  });

  it("falls back to play for empty or unknown hashes", () => {
    expect(parseRoute("")).toBe("play");
    expect(parseRoute("#")).toBe("play");
    expect(parseRoute("#/")).toBe("play");
    expect(parseRoute("#/nope")).toBe("play");
    expect(parseRoute("#/REVIEW")).toBe("play");
  });

  it("ignores the query string before the hash", () => {
    expect(parseRoute("?review-workers=2#/library")).toBe("library");
    expect(parseRoute("/?x=1#/review")).toBe("review");
  });

  it("ignores a query string after the route", () => {
    expect(parseRoute("#/library?x=1")).toBe("library");
  });

  it("works with a full URL under a sub path or the root", () => {
    expect(parseRoute("https://example.github.io/xiangqi-coach/#/review")).toBe("review");
    expect(parseRoute("https://example.pages.dev/?review-workers=2#/settings")).toBe("settings");
    expect(parseRoute("https://example.pages.dev/")).toBe("play");
  });

  it("keeps a settings sub category on the settings route", () => {
    expect(parseRoute("#/settings/data")).toBe("settings");
  });
});

describe("buildHash", () => {
  it("builds the canonical hash", () => {
    expect(buildHash("play")).toBe("#/play");
    expect(buildHash("settings")).toBe("#/settings");
  });

  it("round trips every route", () => {
    for (const route of ROUTES) expect(parseRoute(buildHash(route))).toBe(route);
  });
});
