import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { zhTW } from "./locale/zh-TW";
import { generateReviewNote } from "./review-note";
import { reviewNoteInputFromCli, type CliReviewReport } from "./review-cli-note";

const startFen = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";
const board = "rnbakabnr.........c.....c.p.p.p.p.p.........P.P.P.P.P.C.....C.........RNBAKABNR";

function result(lossPercent: number, reason: { kind: string; moves: number } | null) {
  return {
    best_move: "a3a4", played_move: "h2e2", played_rank: 2,
    best_score: { centipawns: 0, mate_in: 2 }, played_score: { centipawns: 0, mate_in: null },
    best_win_probability: 1, played_win_probability: 0.5, loss_percent: lossPercent,
    classification: "missed_mate", classification_label: "錯過殺棋", reason,
  };
}

function report(): CliReviewReport {
  const candidates = [{
    best_move: "a3a4", score: { centipawns: 0, mate_in: 2 }, principal_variation: ["a3a4", "a6a5"],
    depth: 6, nodes: 1234, pv_end: "depth_limit", pv_length: 2, six_move_target_met: false, pv_status: "short_unconfirmed",
  }];
  const ply = {
    ply: 1, side: "red", side_label: "紅方", played_move: "h2e2",
    quick: { result: result(50, { kind: "missed_mate", moves: 2 }), candidates, candidate_count: 1 },
    final: { deepened: true, result: result(50, { kind: "missed_mate", moves: 2 }), candidates, candidate_count: 1 },
  };
  return {
    schema_version: 1, import_status: "complete", start_fen: startFen, result: "unknown",
    moves: ["h2e2"], notations: ["炮二平五"], boards: [board, board.replace("C", ".")],
    analyzer: "Pikafish <test>", limits: { quick_nodes: 1000, deep_nodes: 10000, timeout_ms: 30000 },
    plies: [ply],
  } as unknown as CliReviewReport;
}

describe("review CLI JSON to review note", () => {
  it("maps the CLI report onto the note input without inventing data", () => {
    const input = reviewNoteInputFromCli(report(), { reportDate: "2026-10-15" });
    expect(input.startFen).toBe(startFen);
    expect(input.moves).toEqual(["h2e2"]);
    expect(input.notations).toEqual(["炮二平五"]);
    expect(input.analyzer).toMatchObject({ name: "Pikafish <test>", quickNodeLimit: 1000, deepNodeLimit: 10000 });
    expect(input.points[0]!.final).toMatchObject({
      bestMove: "a3a4", lossPercent: 50, reason: { kind: "missed_mate", moves: 2 },
      bestScore: { centipawns: 0, mateIn: 2 },
    });
    expect(input.points[0]!.final.candidates[0]).toMatchObject({ move: "a3a4", pv: ["a3a4", "a6a5"], depth: 6, nodes: 1234, pvEnd: "depth_limit" });
    expect(input.variationTree).toBeNull();
  });

  it("feeds the same generator the web uses and names the external engine", () => {
    const note = generateReviewNote(reviewNoteInputFromCli(report(), { reportDate: "2026-10-15" }));
    expect(note.markdown).toContain("# 覆盤筆記");
    expect(note.markdown).toContain("Pikafish &lt;test&gt;");
    expect(note.markdown).toContain("炮二平五");
    expect(note.markdown).toContain("1,234");
    expect(note.markdown).toContain(zhTW.reviewNote.missedMate(2));
  });

  it("refuses a partial import instead of writing a note for a truncated game", () => {
    const partial = { ...report(), import_status: "partial" } as CliReviewReport;
    expect(() => reviewNoteInputFromCli(partial, { reportDate: "2026-10-15" })).toThrow(/partial/);
  });

  it("node script turns a report file into the same Markdown", () => {
    const dir = mkdtempSync(join(tmpdir(), "xq-note-cli-"));
    try {
      const file = join(dir, "review.json");
      writeFileSync(file, JSON.stringify(report()));
      const out = execFileSync(process.execPath, ["scripts/review-note-cli.mjs", file, "--date", "2026-10-15"], { encoding: "utf8" });
      expect(out).toBe(generateReviewNote(reviewNoteInputFromCli(report(), { reportDate: "2026-10-15" })).markdown);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the recorded Pikafish sample in docs/samples still renders to the recorded note", () => {
    const dir = new URL("../../docs/samples/m10-pikafish/", import.meta.url);
    const sample = JSON.parse(readFileSync(new URL("dpxq-2004-second-game.json", dir), "utf8")) as CliReviewReport;
    const recorded = readFileSync(new URL("dpxq-2004-second-game.md", dir), "utf8");
    expect(sample.analyzer).toMatch(/^Pikafish /);
    expect(generateReviewNote(reviewNoteInputFromCli(sample, { reportDate: "2026-10-15" })).markdown).toBe(recorded);
  });
});
