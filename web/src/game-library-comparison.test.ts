import { describe, expect, it } from "vitest";
import { isReviewPoint } from "./game-library";

// A stored review point may carry the played-versus-best comparison. Old saves have none.

const candidate = { move: "h2e2", score: { centipawns: 20, mateIn: null }, pv: ["h2e2"], depth: 1, nodes: 100,
  pvEnd: "depth_limit", continuation: [], continuationNodeLimit: 100_000, continuationTerminal: false,
  replayAudit: { failedIndex: null }, continuationStatus: "minimum_reached" };
const result = { bestMove: "h2e2", playedMove: "h2e2", playedRank: 1, bestScore: { centipawns: 20, mateIn: null },
  playedScore: { centipawns: 20, mateIn: null }, bestWinProbability: 0.5, playedWinProbability: 0.5, lossPercent: 0,
  classification: "good", candidates: [candidate] };
const step = (iccs: string, notation: string, side: string, captured: unknown = null) => ({ iccs, notation, side, captured });
const comparison = () => ({
  playedLine: [step("e9e8", "將5進1", "black", { side: "red", kind: "rook" })],
  bestLine: [step("h2e2", "炮二平五", "red")],
  playedComplete: true,
  bestComplete: false,
});
const pointWith = (extra: Record<string, unknown>) => ({
  quick: result, final: { ...result, ...extra }, deepened: false, continuationComplete: true,
});

describe("saved review comparison", () => {
  it("accepts an old snapshot without a comparison", () => {
    expect(isReviewPoint(pointWith({}), "h2e2")).toBe(true);
  });

  it("accepts a null comparison", () => {
    expect(isReviewPoint(pointWith({ comparison: null }), "h2e2")).toBe(true);
  });

  it("accepts a well-formed comparison", () => {
    expect(isReviewPoint(pointWith({ comparison: comparison() }), "h2e2")).toBe(true);
    expect(isReviewPoint(pointWith({ comparison: { ...comparison(), playedLine: [] } }), "h2e2")).toBe(true);
  });

  it("rejects a malformed comparison", () => {
    const bad: unknown[] = [
      "nope",
      { ...comparison(), playedLine: "x" },
      { ...comparison(), bestLine: [step("zz", "炮二平五", "red")] },
      { ...comparison(), bestLine: [step("h2e2", "", "red")] },
      { ...comparison(), bestLine: [step("h2e2", "炮二平五", "green")] },
      { ...comparison(), playedLine: [step("e9e8", "將5進1", "black", { side: "red", kind: "dragon" })] },
      { ...comparison(), playedComplete: "yes" },
      { ...comparison(), bestComplete: undefined },
    ];
    for (const value of bad) {
      expect(isReviewPoint(pointWith({ comparison: value }), "h2e2"), JSON.stringify(value)).toBe(false);
    }
  });
});
