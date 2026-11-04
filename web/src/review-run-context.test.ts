import { describe, expect, it } from "vitest";
import { createReviewRunContext, isCurrentReviewRun } from "./review-run-context";

describe("review run context", () => {
  it("freezes each run's root, ordered moves, budget, and identity", () => {
    const moves = ["h2e2"];
    const first = createReviewRunContext(1, "root-A", moves, 100_000);
    const second = createReviewRunContext(2, "root-A", moves, 1_000_000);
    moves.push("h9g7");
    expect(first.moves).toEqual(["h2e2"]);
    expect(first.quickNodeLimit).toBe(100_000);
    expect(second.quickNodeLimit).toBe(1_000_000);
    expect(isCurrentReviewRun(first, second, "root-A", ["h2e2"])).toBe(false);
    expect(isCurrentReviewRun(second, second, "root-A", ["h2e2"])).toBe(true);
    expect(isCurrentReviewRun(second, second, "root-B", ["h2e2"])).toBe(false);
    expect(isCurrentReviewRun(second, second, "root-A", ["h2e2", "h9g7"])).toBe(false);
  });
});
