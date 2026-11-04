import { describe, expect, it } from "vitest";
import { autoReviewEnabled, backgroundWorkerCount } from "./review-workers";

describe("backgroundWorkerCount", () => {
  it("uses at most two workers by default", () => {
    expect(backgroundWorkerCount(16, "")).toBe(2);
    expect(backgroundWorkerCount(4, "")).toBe(2);
    expect(backgroundWorkerCount(3, "")).toBe(2);
  });
  it("uses the ordinary default when that is smaller", () => {
    expect(backgroundWorkerCount(2, "")).toBe(1);
    expect(backgroundWorkerCount(1, "")).toBe(1);
    expect(backgroundWorkerCount(undefined, "")).toBe(1);
  });
  it("lets ?review-workers override the cap", () => {
    expect(backgroundWorkerCount(16, "?review-workers=4")).toBe(4);
    expect(backgroundWorkerCount(16, "?review-workers=1")).toBe(1);
    expect(backgroundWorkerCount(16, "?review-workers=99")).toBe(2);
  });
});

describe("autoReviewEnabled", () => {
  it("is on unless the URL says off", () => {
    expect(autoReviewEnabled("")).toBe(true);
    expect(autoReviewEnabled("?auto-review=on")).toBe(true);
    expect(autoReviewEnabled("?auto-review=off")).toBe(false);
  });
});
