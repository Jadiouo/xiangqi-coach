import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createReviewVariationTree } from "./review-variation-tree";
import { generateReviewNote, type ReviewNoteInput } from "./review-note";

const startFen = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";
const startBoard = [
  "rnbakabnr", ".........", ".c.....c.", "p.p.p.p.p", ".........",
  ".........", "P.P.P.P.P", ".C.....C.", ".........", "RNBAKABNR",
].join("");

function point(move: string, lossPercent: number, classification: "mistake" | "doubtful_move" | "good", reason?: { kind: "walked_into_mate" | "missed_mate"; moves: number }, probability = 0.5) {
  const candidate = {
    move: "h2e2",
    score: { centipawns: 120, mateIn: null },
    pv: ["h2e2", "h9g7", "h0g2", "i9h9", "i0h0", "b9c7"],
    depth: 8,
    nodes: 50_000,
    pvEnd: "depth_limit" as const,
    continuation: [{ move: "h0g2", depth: 8, nodes: 10_000, pvEnd: "depth_limit" as const }],
    continuationNodeLimit: 10_000,
    continuationTerminal: false,
    replayAudit: { failedIndex: null },
    continuationStatus: "complete" as const,
  };
  const result = {
    bestMove: "h2e2",
    playedMove: move,
    playedRank: 1,
    bestScore: { centipawns: 120, mateIn: null },
    playedScore: { centipawns: 0, mateIn: null },
    bestWinProbability: 0.7,
    playedWinProbability: probability,
    lossPercent,
    classification,
    ...(reason ? { reason } : {}),
    candidates: [candidate],
  };
  return { quick: result, final: result, deepened: true, continuationComplete: true };
}


function sampleInput(): ReviewNoteInput {
  const moves = ["h2e2", "h9g7", "h0g2", "i9h9", "i0h0", "b9c7"];
  const tree = createReviewVariationTree(moves, startFen);
  const branch = tree.append(tree.mainlineNodeId(1), "b9c7");
  tree.annotate(branch, "這裡先出馬保中卒，比急著出車穩。");
  return {
    reportDate: "2026-10-09",
    metadata: { Red: "示範紅方", Black: "示範黑方", Result: "1-0" },
    result: "red_win",
    startFen,
    moves,
    notations: ["炮二平五", "馬8進7", "馬二進三", "車9平8", "車一平二", "馬2進3"],
    points: [
      point(moves[0]!, 0.5, "good"),
      point(moves[1]!, 12, "mistake", { kind: "missed_mate", moves: 3 }),
      point(moves[2]!, 0.5, "good"),
      point(moves[3]!, 18, "mistake", { kind: "walked_into_mate", moves: 2 }),
      point(moves[4]!, 6, "doubtful_move"),
      point(moves[5]!, 0.5, "good"),
    ],
    boards: Array.from({ length: moves.length + 1 }, () => startBoard),
    variationTree: tree.toJSON(),
    analyzer: { name: "內建引擎", quickNodeLimit: 100_000, deepNodeLimit: 1_000_000, config: "SearchConfig::default()" },
  };
}

const samplePath = new URL("../../docs/samples/review-note.md", import.meta.url);

describe("docs/samples/review-note.md is what the current generator writes", () => {
  it("matches byte for byte (regenerate with WRITE_SAMPLE=1 only after a deliberate note format change)", () => {
    const markdown = generateReviewNote(sampleInput()).markdown;
    if (process.env.WRITE_SAMPLE === "1") writeFileSync(samplePath, markdown);
    expect(readFileSync(samplePath, "utf8")).toBe(markdown);
  });
  it("shows the SPEC section 9 content: header with players and result, eight sections, three to five moments, annotated branch", () => {
    const markdown = readFileSync(samplePath, "utf8");
    for (const heading of ["對局資訊", "勝率曲線", "對局摘要", "關鍵時刻", "推演分支", "毛病統計", "下次注意", "完整棋譜"]) expect(markdown).toContain(`## ${heading}`);
    expect(markdown).toContain("示範紅方（紅）對 示範黑方（黑）");
    expect(markdown).toContain("結果：紅勝");
    const moments = [...markdown.matchAll(/^### 第 \d+ 手/gm)].length;
    expect(moments).toBeGreaterThanOrEqual(3);
    expect(moments).toBeLessThanOrEqual(5);
    expect(markdown).toContain("這裡先出馬保中卒");
  });
});
