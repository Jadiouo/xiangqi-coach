import { describe, expect, it } from "vitest";
import {
  LONG_REVIEW_SECONDS, estimateReviewSeconds, longReviewWarning, remainingSeconds, secondsPerPlyOverride,
} from "./review-estimate";
import { zhTW } from "./locale/zh-TW";

describe("estimate before a review starts", () => {
  it("matches the measured points at one worker", () => {
    expect(estimateReviewSeconds({ plies: 8, nodeLimit: 100_000, workers: 1 })).toBeCloseTo(8 * 23);
    // 10x the budget costs about 2.2x per ply (measured 50 s against 23 s)
    expect(estimateReviewSeconds({ plies: 3, nodeLimit: 1_000_000, workers: 1 }) / 3).toBeGreaterThan(48);
    expect(estimateReviewSeconds({ plies: 3, nodeLimit: 1_000_000, workers: 1 }) / 3).toBeLessThan(52);
  });

  it("grows with plies and budget, and shrinks with workers by the measured 2.36x at four", () => {
    const base = estimateReviewSeconds({ plies: 10, nodeLimit: 100_000, workers: 1 });
    expect(estimateReviewSeconds({ plies: 20, nodeLimit: 100_000, workers: 1 })).toBeCloseTo(base * 2);
    expect(estimateReviewSeconds({ plies: 10, nodeLimit: 1_000_000, workers: 1 })).toBeGreaterThan(base);
    expect(base / estimateReviewSeconds({ plies: 10, nodeLimit: 100_000, workers: 4 })).toBeCloseTo(2.35, 1);
  });

  it("does not use more workers than there are plies", () => {
    expect(estimateReviewSeconds({ plies: 2, nodeLimit: 100_000, workers: 4 }))
      .toBeCloseTo(estimateReviewSeconds({ plies: 2, nodeLimit: 100_000, workers: 2 }));
  });

  it("takes the seconds-per-ply figure as a parameter, so a test never waits on the real one", () => {
    expect(estimateReviewSeconds({ plies: 10, nodeLimit: 100_000, workers: 1, secondsPerPlyAt100k: 1 })).toBeCloseTo(10);
  });

  it("is zero for an empty game", () => {
    expect(estimateReviewSeconds({ plies: 0, nodeLimit: 1_000_000, workers: 2 })).toBe(0);
  });
});

describe("long review warning", () => {
  it("warns only when the estimate reaches the threshold", () => {
    expect(longReviewWarning(LONG_REVIEW_SECONDS - 1)).toBe(false);
    expect(longReviewWarning(LONG_REVIEW_SECONDS)).toBe(true);
    expect(longReviewWarning(3600)).toBe(true);
    expect(longReviewWarning(10, 5)).toBe(true);
  });
});

describe("remaining time while a review runs", () => {
  it("says nothing yet while too few plies are done", () => {
    expect(remainingSeconds({ done: 0, cached: 0, total: 40, elapsedMs: 5000 })).toBeNull();
    expect(remainingSeconds({ done: 2, cached: 0, total: 40, elapsedMs: 60_000 })).toBeNull();
  });

  it("extrapolates from the finished plies and the time spent", () => {
    // 4 plies in 40 s: 10 s each, 36 left
    expect(remainingSeconds({ done: 4, cached: 0, total: 40, elapsedMs: 40_000 })).toBeCloseTo(360);
  });

  it("leaves cache hits out of the pace, because they cost no time", () => {
    // 10 plies shown, 6 of them from the cache: only 4 were computed in 40 s
    expect(remainingSeconds({ done: 10, cached: 6, total: 20, elapsedMs: 40_000 })).toBeCloseTo(100);
  });

  it("is zero when everything is done and null without any measured time", () => {
    expect(remainingSeconds({ done: 40, cached: 0, total: 40, elapsedMs: 9000 })).toBe(0);
    expect(remainingSeconds({ done: 5, cached: 0, total: 40, elapsedMs: 0 })).toBeNull();
    expect(remainingSeconds({ done: 5, cached: 5, total: 40, elapsedMs: 5000 })).toBeNull();
  });
});

describe("duration wording", () => {
  it("uses seconds, minutes, then hours and minutes", () => {
    expect(zhTW.review.duration(20)).toBe("約 20 秒");
    expect(zhTW.review.duration(61)).toBe("約 2 分鐘");
    expect(zhTW.review.duration(600)).toBe("約 10 分鐘");
    expect(zhTW.review.duration(3600 * 2.5)).toBe("約 2 小時 30 分鐘");
    expect(zhTW.review.duration(3600)).toBe("約 1 小時");
  });
});

describe("long review threshold and cache", () => {
  it("only reviews expected to take more than 15 minutes are announced (user's choice, 2026-10-24)", () => {
    expect(LONG_REVIEW_SECONDS).toBe(900);
  });

  it("leaves cached plies out of the estimate", () => {
    const all = estimateReviewSeconds({ plies: 10, nodeLimit: 100_000, workers: 1 });
    expect(estimateReviewSeconds({ plies: 10, cachedPlies: 5, nodeLimit: 100_000, workers: 1 })).toBeCloseTo(all / 2);
    expect(estimateReviewSeconds({ plies: 10, cachedPlies: 10, nodeLimit: 100_000, workers: 4 })).toBe(0);
    expect(estimateReviewSeconds({ plies: 10, cachedPlies: 99, nodeLimit: 100_000, workers: 4 })).toBe(0);
  });

  it("reads the injected seconds-per-ply from the address, ignoring anything that is not a positive number", () => {
    expect(secondsPerPlyOverride("?review-seconds-per-ply=1000")).toBe(1000);
    expect(secondsPerPlyOverride("?x=1&review-seconds-per-ply=0.5")).toBe(0.5);
    for (const bad of ["", "?review-seconds-per-ply=", "?review-seconds-per-ply=abc", "?review-seconds-per-ply=0", "?review-seconds-per-ply=-3"]) {
      expect(secondsPerPlyOverride(bad), bad).toBeUndefined();
    }
  });
});
