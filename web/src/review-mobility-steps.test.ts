import { describe, expect, it } from "vitest";
import { zhTW } from "./locale/zh-TW";
import { isReviewPoint } from "./game-library";
import type { ReviewExplanationLevel, ReviewReason } from "./review-client";

// P4 item 2: the mobility sentence says how many moves the best move would have kept (a count
// of moves, not a score), and older saves without that number keep the old wording.

const LEVELS: ReviewExplanationLevel[] = ["beginner", "intermediate", "proficient"];

function mobility(before: number, after: number, afterBest?: number): ReviewReason {
  return {
    kind: "position_type", moves: 0,
    position: {
      component: "mobility", playedValue: 36, bestValue: 40, mobilityBefore: before, mobilityAfter: after,
      ...(afterBest === undefined ? {} : { mobilityAfterBest: afterBest }),
    },
  };
}

describe("mobility sentence with the best move's step count", () => {
  it("states the played and the best step counts at every level (blocked case)", () => {
    for (const level of LEVELS) {
      const text = zhTW.review.reason(mobility(11, 4, 9), level);
      expect(text, level).toContain("4");
      expect(text, level).toContain("9");
      expect(text, level).not.toMatch(/\d+\s*分|cp|centipawn|節點|深度|undefined|NaN/);
      expect(text, level).not.toContain("36");
      expect(text, level).not.toContain("40");
    }
    expect(zhTW.review.reason(mobility(11, 4, 9), "beginner")).toContain("被擋住");
  });

  it("states both counts when the move barely changed the mover's options", () => {
    for (const level of LEVELS) {
      const text = zhTW.review.reason(mobility(41, 40, 47), level);
      expect(text, level).toContain("40");
      expect(text, level).toContain("47");
      expect(text, level).not.toContain("被擋住");
    }
    expect(new Set(LEVELS.map((level) => zhTW.review.reason(mobility(41, 40, 47), level))).size).toBe(3);
  });

  it("does not claim the best move keeps more when its count is not larger", () => {
    for (const level of LEVELS) {
      const text = zhTW.review.reason(mobility(11, 4, 4), level);
      expect(text, level).not.toContain("還有");
      // Falls back to the wording used before the count existed.
      expect(text).toBe(zhTW.review.reason(mobility(11, 4), level));
    }
  });

  it("only quotes the best move's step count when it is at least 3 steps more", () => {
    for (const level of LEVELS) {
      // 36 against 37 (and 36 against 38) is no real gap: the old wording, no count of the best move.
      for (const best of [37, 38]) {
        const text = zhTW.review.reason(mobility(40, 36, best), level);
        expect(text, `${level} ${best}`).not.toContain(String(best));
        expect(text, `${level} ${best}`).not.toContain("還有");
        expect(text).toBe(zhTW.review.reason(mobility(40, 36), level));
      }
      // 3 more steps is the threshold: the step sentence is used.
      const edge = zhTW.review.reason(mobility(40, 36, 39), level);
      expect(edge, level).toContain("39");
      expect(edge, level).toContain("36");
    }
  });

  it("the three levels read differently", () => {
    expect(new Set(LEVELS.map((level) => zhTW.review.reason(mobility(11, 4, 9), level))).size).toBe(3);
  });

  it("the save validator accepts the count, its absence, and rejects a bad value", () => {
    const candidate = { move: "h2e2", score: { centipawns: 20, mateIn: null }, pv: ["h2e2"], depth: 1, nodes: 100,
      pvEnd: "depth_limit", continuation: [], continuationNodeLimit: 100_000, continuationTerminal: false,
      replayAudit: { failedIndex: null }, continuationStatus: "minimum_reached" };
    const result = { bestMove: "h2e2", playedMove: "h2e2", playedRank: 1, bestScore: { centipawns: 20, mateIn: null },
      playedScore: { centipawns: 20, mateIn: null }, bestWinProbability: 0.5, playedWinProbability: 0.5, lossPercent: 0,
      classification: "good", candidates: [candidate] };
    const point = (value: unknown) => ({
      quick: result, deepened: false, continuationComplete: true,
      final: { ...result, reason: { kind: "position_type", moves: 0, position: {
        component: "mobility", playedValue: 36, bestValue: 40, mobilityBefore: 11, mobilityAfter: 4, mobilityAfterBest: value } } },
    });
    expect(isReviewPoint(point(9), "h2e2")).toBe(true);
    expect(isReviewPoint(point(undefined), "h2e2")).toBe(true);
    expect(isReviewPoint(point(-1), "h2e2")).toBe(false);
    expect(isReviewPoint(point("9"), "h2e2")).toBe(false);
  });
});
