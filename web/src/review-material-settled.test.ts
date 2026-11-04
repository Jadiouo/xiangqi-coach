import { describe, expect, it } from "vitest";
import { zhTW } from "./locale/zh-TW";
import { isReviewPoint } from "./game-library";
import type { ReviewExplanationLevel, ReviewPiece, ReviewReason } from "./review-client";

// P4 item 1 (SPEC 8.4 "丟子"): a material claim whose line end still has a capture on the
// board is flagged settled=false; the sentence then says the exchange is not over and does not
// assert a net result. Older saves have no flag and read as settled.

const LEVELS: ReviewExplanationLevel[] = ["beginner", "intermediate", "proficient"];
const redRook: ReviewPiece = { side: "red", kind: "rook" };
const blackPawn: ReviewPiece = { side: "black", kind: "pawn" };

function material(settled?: boolean) {
  return {
    mover: "red" as const, bestNet: 70, playedNet: -600, plies: 2,
    bestCaptures: [{ piece: blackPawn, square: "a5", capturer: "red" as const, ply: 1 }],
    playedCaptures: [{ piece: redRook, square: "a0", capturer: "black" as const, ply: 2 }],
    ...(settled === undefined ? {} : { settled }),
  };
}

const NOT_OVER = "（之後可能還有交換）";

describe("unsettled material claims", () => {
  for (const kind of ["dropped_material", "missed_material"] as const) {
    it(`${kind}: says the exchange is not over at every level`, () => {
      const reason = { kind, moves: 0, material: material(false) } as ReviewReason;
      for (const level of LEVELS) {
        const text = zhTW.review.reason(reason, level);
        expect(text, `${level}: ${text}`).toContain(NOT_OVER);
        expect(text).not.toMatch(/淨少|淨賺|undefined|NaN/);
        expect(text, level).not.toContain("實際得失");
        // The note is a short bracket after the sentence, never in the middle of it.
        expect(text.indexOf(NOT_OVER), level).toBeGreaterThan(text.indexOf(kind === "dropped_material" ? "少" : "吃"));
        expect(text.replace(NOT_OVER, ""), level).not.toMatch(/；.*$/);
        expect(text.length - text.indexOf(NOT_OVER) - NOT_OVER.length, level).toBeLessThanOrEqual(1);
      }
    });

    it(`${kind}: a settled or older claim does not mention it`, () => {
      for (const flag of [true, undefined]) {
        const reason = { kind, moves: 0, material: material(flag) } as ReviewReason;
        for (const level of LEVELS) expect(zhTW.review.reason(reason, level)).not.toContain(NOT_OVER);
      }
    });
  }

  it("the save validator accepts the flag, accepts its absence, and rejects a wrong type", () => {
    const candidate = { move: "h2e2", score: { centipawns: 20, mateIn: null }, pv: ["h2e2"], depth: 1, nodes: 100,
      pvEnd: "depth_limit", continuation: [], continuationNodeLimit: 100_000, continuationTerminal: false,
      replayAudit: { failedIndex: null }, continuationStatus: "minimum_reached" };
    const result = { bestMove: "h2e2", playedMove: "h2e2", playedRank: 1, bestScore: { centipawns: 20, mateIn: null },
      playedScore: { centipawns: 20, mateIn: null }, bestWinProbability: 0.5, playedWinProbability: 0.5, lossPercent: 0,
      classification: "good", candidates: [candidate] };
    const point = (settled: unknown) => ({
      quick: result, deepened: false, continuationComplete: true,
      final: { ...result, reason: { kind: "dropped_material", moves: 0, material: { ...material(), settled } } },
    });
    expect(isReviewPoint(point(false), "h2e2")).toBe(true);
    expect(isReviewPoint(point(true), "h2e2")).toBe(true);
    expect(isReviewPoint(point(undefined), "h2e2")).toBe(true);
    expect(isReviewPoint(point("no"), "h2e2")).toBe(false);
  });
});
