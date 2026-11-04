import { describe, expect, it } from "vitest";
import { generateReviewNote, type ReviewNoteInput } from "./review-note";
import { reviewNoteInputFromCli, type CliReviewReport } from "./review-cli-note";

const startFen = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";
const board = "rnbakabnr.........c.....c.p.p.p.p.p.........P.P.P.P.P.C.....C.........RNBAKABNR";
const comparison = {
  playedLine: [{ iccs: "h9g7", notation: "馬8進7", side: "black", captured: null }],
  bestLine: [{ iccs: "b0c2", notation: "馬八進七", side: "red", captured: { side: "black", kind: "pawn" } }],
  playedComplete: false, bestComplete: true, playedSettled: true, bestSettled: true,
} as const;

function noteInput(withComparison: boolean): ReviewNoteInput {
  const candidate = { move: "b0c2", score: { centipawns: 120, mateIn: null }, pv: ["b0c2"], depth: 8, nodes: 50_000, pvEnd: "depth_limit" as const,
    continuation: [], continuationNodeLimit: 10_000, continuationTerminal: false, replayAudit: { failedIndex: null }, continuationStatus: "complete" as const };
  const final = { bestMove: "b0c2", playedMove: "h2e2", playedRank: 2, bestScore: { centipawns: 120, mateIn: null }, playedScore: { centipawns: 0, mateIn: null },
    bestWinProbability: 0.7, playedWinProbability: 0.5, lossPercent: 15, classification: "mistake" as const,
    reason: { kind: "walked_into_mate" as const, moves: 2 }, ...(withComparison ? { comparison } : {}), candidates: [candidate] };
  return { reportDate: "2026-10-16", metadata: {}, result: "unknown", startFen, moves: ["h2e2"], notations: ["炮二平五"],
    points: [{ quick: final, final, deepened: true, continuationComplete: true }], boards: [board, board], variationTree: null,
    analyzer: { name: "內建引擎", quickNodeLimit: 100_000, deepNodeLimit: 1_000_000, config: "x" } } as unknown as ReviewNoteInput;
}

describe("review note comparison bullets", () => {
  it("adds the best move in Chinese notation and both lines, and keeps the ICCS bullet", () => {
    const markdown = generateReviewNote(noteInput(true)).markdown;
    expect(markdown).toContain("最佳著（中文記譜）：馬八進七");
    expect(markdown).toContain("你這樣走，接下來會是：對方馬8進7");
    expect(markdown).toContain("改走〔馬八進七〕（吃對方的卒）");
    expect(markdown).toMatch(/最佳候選・深度 8・50,000 節點：b0c2/);
  });

  it("writes nothing extra for a point without a comparison (old saves)", () => {
    const markdown = generateReviewNote(noteInput(false)).markdown;
    expect(markdown).not.toContain("最佳著（中文記譜）");
    expect(markdown).not.toContain("你這樣走，接下來會是");
  });

  it("carries the comparison of a CLI report into the same note", () => {
    const cliComparison = {
      played_line: [{ iccs: "h9g7", notation: "馬8進7", side: "black", captured: null }],
      best_line: [{ iccs: "b0c2", notation: "馬八進七", side: "red", captured: null }],
      played_complete: true, best_complete: true, played_settled: true, best_settled: true,
    };
    const result = { best_move: "b0c2", played_move: "h2e2", played_rank: 2, best_score: { centipawns: 0, mate_in: 2 }, played_score: { centipawns: 0, mate_in: null },
      best_win_probability: 1, played_win_probability: 0.5, loss_percent: 50, classification: "missed_mate", reason: { kind: "missed_mate", moves: 2 }, comparison: cliComparison };
    const candidates = [{ best_move: "b0c2", score: { centipawns: 0, mate_in: 2 }, principal_variation: ["b0c2"], depth: 6, nodes: 1234, pv_end: "depth_limit" }];
    const report = { schema_version: 1, import_status: "complete", start_fen: startFen, result: "unknown", moves: ["h2e2"], notations: ["炮二平五"], boards: [board, board],
      analyzer: "x", limits: { quick_nodes: 1000, deep_nodes: 10000, timeout_ms: 30000 },
      plies: [{ quick: { result, candidates }, final: { deepened: true, result, candidates } }] } as unknown as CliReviewReport;
    const markdown = generateReviewNote(reviewNoteInputFromCli(report, { reportDate: "2026-10-16" })).markdown;
    expect(markdown).toContain("最佳著（中文記譜）：馬八進七");
    expect(markdown).toContain("你這樣走，接下來會是：對方馬8進7");
  });
});

describe("review note keeps squares for every evidence kind (user: notes are developer-facing)", () => {
  const withReason = (reason: unknown) => {
    const base = noteInput(false);
    const point = base.points[0]!;
    const final = { ...point.final, reason };
    return { ...base, points: [{ ...point, quick: final, final }] } as unknown as ReviewNoteInput;
  };
  const horse = { side: "red", kind: "horse" };
  const rook = { side: "black", kind: "rook" };

  it("check_capture lists the attacker and victim squares", () => {
    const markdown = generateReviewNote(withReason({ kind: "check_capture", moves: 0,
      checkCapture: { victim: horse, victimSquare: "e3", attacker: rook, attackerFrom: "a3", net: -300 } })).markdown;
    expect(markdown).toContain("a3");
    expect(markdown).toContain("e3");
  });

  it("material lists the squares of the captures", () => {
    const markdown = generateReviewNote(withReason({ kind: "dropped_material", moves: 0,
      material: { mover: "red", bestNet: 0, playedNet: -300, plies: 3,
        bestCaptures: [{ piece: rook, square: "g7", capturer: "red", ply: 1 }],
        playedCaptures: [{ piece: horse, square: "c4", capturer: "black", ply: 2 }] } })).markdown;
    expect(markdown).toContain("c4");
    expect(markdown).toContain("g7");
  });
});
