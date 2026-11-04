import { describe, expect, it } from "vitest";
import { zhTW } from "./locale/zh-TW";
import { isReviewPoint } from "./game-library";
import { generateReviewNote } from "./review-note";
import type { ReviewNoteInput } from "./review-note";
import type { ReviewExplanationLevel, ReviewReason } from "./review-client";

// P4 item 3 (F2, SPEC 8.4 item 6): the cannon-mount reason on the web side. Sentences name the
// pieces, never squares or scores; the note keeps the squares; old validators must not choke.

const LEVELS: ReviewExplanationLevel[] = ["beginner", "intermediate", "proficient"];
const mount: ReviewReason = {
  kind: "cannon_mount", moves: 0,
  cannonMount: {
    screen: { side: "red", kind: "horse" }, screenSquare: "a2",
    cannon: { side: "black", kind: "cannon" }, cannonFrom: "a5",
    victim: { side: "red", kind: "rook" }, victimSquare: "a0", net: -600,
  },
};

describe("cannon mount sentences", () => {
  it("names the screen, the cannon and the victim at every level", () => {
    for (const level of LEVELS) {
      const text = zhTW.review.reason(mount, level);
      expect(text, level).toContain("馬");
      expect(text, level).toContain("炮");
      expect(text, level).toContain("車");
      expect(text, level).toContain("炮架");
    }
  });

  it("shows no coordinates, scores or leftovers, and reads differently per level", () => {
    const texts = LEVELS.map((level) => zhTW.review.reason(mount, level));
    for (const text of texts) {
      expect(text).not.toMatch(/\b[a-i][0-9]\b/);
      expect(text).not.toMatch(/\d+\s*分|cp|centipawn|節點|深度|[{}$]|undefined|NaN|\[object/);
      expect(text).not.toContain("你把你的");
    }
    expect(new Set(texts).size).toBe(3);
  });

  it("has a label for the note's statistics", () => {
    expect(zhTW.reviewNote.kindLabels.cannon_mount).toBe("炮架");
  });
});

describe("cannon mount in saves and notes", () => {
  const candidate = { move: "h2e2", score: { centipawns: 20, mateIn: null }, pv: ["h2e2"], depth: 1, nodes: 100,
    pvEnd: "depth_limit", continuation: [], continuationNodeLimit: 100_000, continuationTerminal: false,
    replayAudit: { failedIndex: null }, continuationStatus: "minimum_reached" };
  const result = { bestMove: "h2e2", playedMove: "h2e2", playedRank: 1, bestScore: { centipawns: 20, mateIn: null },
    playedScore: { centipawns: 20, mateIn: null }, bestWinProbability: 0.5, playedWinProbability: 0.5, lossPercent: 0,
    classification: "good", candidates: [candidate] };
  const point = (reason: unknown) => ({ quick: result, deepened: false, continuationComplete: true, final: { ...result, reason } });

  it("the validator accepts the kind with its evidence and rejects it without", () => {
    expect(isReviewPoint(point(mount), "h2e2")).toBe(true);
    expect(isReviewPoint(point({ kind: "cannon_mount", moves: 0 }), "h2e2")).toBe(false);
    const bad = { ...mount, cannonMount: { ...(mount as any).cannonMount, victimSquare: "z9" } };
    expect(isReviewPoint(point(bad), "h2e2")).toBe(false);
    const noScreen = { ...mount, cannonMount: { ...(mount as any).cannonMount, screen: null } };
    expect(isReviewPoint(point(noScreen), "h2e2")).toBe(false);
  });

  it("the note counts the kind and keeps the squares", () => {
    const startFen = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";
    const board = "rnbakabnr.........c.....c.p.p.p.p.p.........P.P.P.P.P.C.....C.........RNBAKABNR";
    const final = { ...result, bestMove: "b0c2", playedMove: "h2e2", playedRank: 2, lossPercent: 15, classification: "mistake", reason: mount };
    const markdown = generateReviewNote({ reportDate: "2026-10-19", metadata: {}, result: "unknown", startFen, moves: ["h2e2"],
      notations: ["炮二平五"], points: [{ quick: final, final, deepened: true, continuationComplete: true }], boards: [board, board],
      variationTree: null, analyzer: { name: "內建引擎", quickNodeLimit: 100_000, deepNodeLimit: 1_000_000, config: "x" },
    } as unknown as ReviewNoteInput).markdown;
    expect(markdown).toContain("炮架：1 次");
    expect(markdown).toContain("a5");
    expect(markdown).toContain("a0");
    expect(markdown).toContain("a2");
  });
});
