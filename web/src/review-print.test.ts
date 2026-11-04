import { beforeEach, describe, expect, it } from "vitest";
import type { ReviewClassification, ReviewLineStep, ReviewReason } from "./review-client";
import type { ReviewNoteInput } from "./review-note";
import { buildReviewPrintHtml } from "./review-print";
import { focusPoints, plySides } from "./review-presentation";

const startFen = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";
const startBoard = [
  "rnbakabnr", ".........", ".c.....c.", "p.p.p.p.p", ".........",
  ".........", "P.P.P.P.P", ".C.....C.", ".........", "RNBAKABNR",
].join("");

const moves = ["h2e2", "h9g7", "h0g2", "i9h9", "i0h0", "b9c7", "a3a4", "a6a5"];
const notations = ["炮二平五", "馬8進7", "馬二進三", "車9平8", "車一平二", "馬2進3", "兵七進一", "卒7進1"];

const step = (iccs: string, notation: string, side: "red" | "black"): ReviewLineStep => ({ iccs, notation, side, captured: null });
const droppedMaterial: ReviewReason = {
  kind: "dropped_material",
  moves: 0,
  material: {
    mover: "red",
    settled: true,
    playedCaptures: [{ square: "c4", piece: { side: "red", kind: "horse" } }],
    bestCaptures: [],
  },
} as unknown as ReviewReason;

function point(index: number, loss: number, classification: ReviewClassification, reason?: ReviewReason) {
  const played = moves[index]!;
  const result = {
    bestMove: "b0c2",
    playedMove: played,
    playedRank: 1,
    bestScore: { centipawns: 120, mateIn: null },
    playedScore: { centipawns: 0, mateIn: null },
    bestWinProbability: 0.7,
    playedWinProbability: 0.5,
    lossPercent: loss,
    classification,
    ...(reason ? { reason } : {}),
    ...(loss >= 2 ? {
      comparison: {
        playedLine: [step(played, notations[index]!, index % 2 === 0 ? "red" : "black"), step("h9g7", "馬8進7", "black")],
        bestLine: [step("b0c2", "馬八進七", "red"), step("h9g7", "馬8進7", "black")],
        playedComplete: false,
        bestComplete: false,
      },
    } : {}),
    candidates: [{
      move: "b0c2", score: { centipawns: 120, mateIn: null }, pv: ["b0c2", "h9g7"], depth: 8, nodes: 50_000,
      pvEnd: "depth_limit" as const, continuation: [], continuationNodeLimit: 10_000, continuationTerminal: false,
      replayAudit: { failedIndex: null }, continuationStatus: "complete" as const,
    }],
  };
  return { quick: result, final: result, deepened: true, continuationComplete: true };
}

export function sample(): ReviewNoteInput {
  return {
    reportDate: "2026-10-24",
    metadata: { Red: "小明", Black: "電腦", Result: "0-1" },
    result: "black_win",
    startFen,
    moves,
    notations,
    points: [
      point(0, 0.2, "good"),
      point(1, 1, "good"),
      point(2, 9, "mistake", droppedMaterial),
      point(3, 0.5, "good"),
      point(4, 20, "blunder", { kind: "walked_into_mate", moves: 2 } as ReviewReason),
      point(5, 0.5, "good"),
      point(6, 5, "inaccuracy"),
      point(7, 0.1, "good"),
    ],
    boards: Array.from({ length: moves.length + 1 }, () => startBoard),
    variationTree: null,
    analyzer: { name: "內建引擎", quickNodeLimit: 100_000, deepNodeLimit: 1_000_000, config: "SearchConfig::default()" },
  };
}

const section = (html: string, name: string): string => {
  const match = html.match(new RegExp(`<section[^>]*data-print-section="${name}"[\\s\\S]*?</section>`));
  expect(match, `section ${name}`).not.toBeNull();
  return match![0];
};

describe("review print html", () => {
  let html = "";
  beforeEach(() => { html = buildReviewPrintHtml(sample(), { userSide: "red", shows: () => true }); });

  it("is a full A4 document with page rules and no-split key moves", () => {
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toMatch(/@page\s*\{[^}]*A4/);
    expect(html).toMatch(/\.key-move\s*\{[^}]*break-inside:\s*avoid/);
  });

  it("has the header, curve, summary, key moves, every move and improvement sections", () => {
    for (const name of ["header", "curve", "summary", "key-moves", "moves", "improve"]) expect(html).toContain(`data-print-section="${name}"`);
    expect(section(html, "header")).toContain("小明");
    expect(section(html, "header")).toContain("2026-10-24");
    expect(section(html, "header")).toContain("黑勝");
    expect(section(html, "curve")).toContain("<svg");
  });

  it("lists the user's biggest losses as key moves, largest first, three to five of them", () => {
    const keys = [...html.matchAll(/data-key-move="(\d+)"/g)].map((m) => Number(m[1]));
    // red is the user: plies 5 (blunder, loss 20), 3 (mistake, 9) and 7 (inaccuracy, 5); black's plies are not key moves
    expect(keys).toEqual([5, 3, 7]);
    const key = section(html, "key-moves");
    expect(key).toContain("馬二進三");
    expect(key).toContain("馬八進七");
    expect(key).toContain("<svg");
    expect(key).toContain("對方可以在 2 步內將死你");
  });

  it("has a move table with one cell per ply, user moves marked, a better move noted for lossy moves", () => {
    const table = section(html, "moves");
    expect([...table.matchAll(/data-ply-cell="(\d+)"/g)]).toHaveLength(moves.length);
    expect([...table.matchAll(/<tr data-move-row/g)]).toHaveLength(4);
    expect(table).toContain("失誤");
    expect(table).toContain("大漏著");
    expect(table).toContain("好棋");
    expect(table).toContain("較好：馬八進七");
  });

  it("has an improvement section with counts and a next-time hint", () => {
    const improve = section(html, "improve");
    expect(improve).toContain("丟子");
    expect(improve).toContain("走進被殺");
    expect(improve).toContain("下次注意");
  });

  it("shows no developer data: no ICCS, node counts, depth or search settings", () => {
    expect(html).not.toContain("h2e2");
    expect(html).not.toMatch(/\b[a-i][0-9][a-i][0-9]\b/);
    expect(html).not.toMatch(/節點|深度|搜尋設定|SearchConfig|內建引擎|FEN/);
  });

  it("draws the key-move boards with the user's side at the bottom", () => {
    const redBottom = section(html, "key-moves");
    // black rook (index 0) is top-left when red is at the bottom; red rook (index 81) is bottom-left
    expect(redBottom).toContain('<circle cx="24" cy="24"');
    const blackInput = { ...sample(), result: "red_win" as const };
    blackInput.points = blackInput.points.map((p, i) => (i === 1 ? point(1, 12, "mistake") : p));
    const blackHtml = buildReviewPrintHtml(blackInput, { userSide: "black", shows: () => true });
    const blackSection = section(blackHtml, "key-moves");
    // flipped: the black rook (index 0) is now bottom-right
    expect(blackSection).toContain('<circle cx="360" cy="402"');
    expect(blackSection).not.toContain('<circle cx="24" cy="24" r="16" fill="#fff8e8" stroke="#222"');
  });

  it("escapes player names", () => {
    const input = sample();
    input.metadata = { Red: "<script>alert(1)</script>", Black: "x" };
    const out = buildReviewPrintHtml(input, { userSide: "red" });
    expect(out).not.toContain("<script>alert(1)");
    expect(out).toContain("&lt;script&gt;");
  });

  it("says so when the user made no notable mistake", () => {
    const input = sample();
    input.points = input.points.map((_, i) => point(i, 0.1, "good"));
    const out = buildReviewPrintHtml(input, { userSide: "red" });
    expect(out).not.toContain("data-key-move=");
    expect(section(out, "key-moves")).toContain("沒有明顯的失誤");
  });
});

describe("review print numbering: key moves, summary and table use the same round numbers", () => {
  const rowOf = (html: string, ply: number): { round: number; column: number } => {
    for (const row of html.matchAll(/<tr data-move-row><td class="no">(\d+)<\/td>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row[2]!.matchAll(/<td( data-ply-cell="(\d+)")?/g)];
      const column = cells.findIndex((cell) => cell[2] === String(ply));
      if (column >= 0) return { round: Number(row[1]), column };
    }
    throw new Error(`ply ${ply} not in the table`);
  };
  const check = (html: string, userSide: "red" | "black") => {
    const titles = [...html.matchAll(/data-key-move="(\d+)"[\s\S]*?<h3>第 (\d+) 回合・(紅|黑)方/g)];
    expect(titles.length).toBeGreaterThanOrEqual(3);
    for (const [, ply, round, side] of titles) {
      const found = rowOf(html, Number(ply));
      expect(Number(round), `ply ${ply}`).toBe(found.round);
      expect(side).toBe(found.column === 0 ? "紅" : "黑");
      expect(side).toBe(userSide === "red" ? "紅" : "黑");
    }
    const summary = section(html, "summary");
    const first = titles[0]!;
    expect(summary).toContain(`第 ${first[2]} 回合・${first[3]}方`);
    expect(summary).not.toMatch(/第 \d+ 手/);
  };

  it("standard start, user red", () => check(buildReviewPrintHtml(sample(), { userSide: "red", shows: () => true }), "red"));

  it("black-first start: round 1 has an empty red cell and numbers still match", () => {
    const input = { ...sample(), startFen: startFen.replace(" w ", " b ") };
    const html = buildReviewPrintHtml(input, { userSide: "black", shows: () => true });
    expect([...html.matchAll(/<tr data-move-row/g)]).toHaveLength(5);
    expect(html).toMatch(/<tr data-move-row><td class="no">1<\/td><td><\/td><td data-ply-cell="1"/);
    check(html, "black");
  });

  it("header says 紅方 對 黑方 without repeating the side when there are no player names", () => {
    const input = sample();
    input.metadata = {};
    const header = section(buildReviewPrintHtml(input, { userSide: "red" }), "header");
    expect(header).toContain("紅方 對 黑方");
    expect(header).not.toContain("紅方（紅）");
  });
});

describe("review print key moves are the review page's key moves", () => {
  const keysOf = (html: string) => [...html.matchAll(/data-key-move="(\d+)"/g)].map((m) => Number(m[1]));
  it("without a level filter it uses the page's default: mistakes and worse, no inaccuracies", () => {
    expect(keysOf(buildReviewPrintHtml(sample(), { userSide: "red" }))).toEqual([5, 3]);
  });
  it("follows the level filter it is given, and lists the same plies as focusPoints", () => {
    const shows = (c: string) => c === "blunder";
    const html = buildReviewPrintHtml(sample(), { userSide: "red", shows });
    expect(keysOf(html)).toEqual([5]);
    const input = sample();
    const page = focusPoints(input.points.map((p) => p.final), plySides(input.startFen, input.moves.length), "red", () => true).map((i) => i + 1);
    expect(keysOf(buildReviewPrintHtml(input, { userSide: "red", shows: () => true })).sort()).toEqual([...page].sort());
  });
});

describe("review print round numbers from a later start", () => {
  it("black to move at round 12: key moves are rounds 13, 14 and 15 of black, table starts at 12 with an empty red cell", () => {
    const input = { ...sample(), startFen: startFen.replace(" w - - 0 1", " b - - 0 12") };
    const html = buildReviewPrintHtml(input, { userSide: "black", shows: () => true });
    expect(html).toMatch(/<tr data-move-row><td class="no">12<\/td><td><\/td><td data-ply-cell="1"/);
    for (const title of ["第 13 回合・黑方", "第 14 回合・黑方", "第 15 回合・黑方"]) expect(html).toContain(title);
  });
});

describe("review print curve caption", () => {
  it("does not talk about 第幾手 (the rest of the page counts rounds)", () => {
    const curve = section(buildReviewPrintHtml(sample(), { userSide: "red" }), "curve");
    expect(curve).not.toMatch(/第幾手|第.手/);
    expect(curve).toContain("順序");
  });
});

describe("review print when the page lists no key moves but smaller problems exist", () => {
  it("does not claim there were no mistakes, and the improvement section still counts them", () => {
    const input = sample();
    input.points = input.points.map((_, i) => (i === 2 ? point(2, 6, "doubtful_move", droppedMaterial) : point(i, 0.1, "good")));
    const html = buildReviewPrintHtml(input, { userSide: "red" });
    expect(html).not.toContain("data-key-move=");
    expect(html).not.toContain("沒有明顯的失誤");
    expect(section(html, "key-moves")).toContain("沒有需要特別注意的大失誤");
    expect(section(html, "summary")).not.toContain("沒有明顯");
    expect(section(html, "improve")).toContain("丟子：1 次");
  });
});
