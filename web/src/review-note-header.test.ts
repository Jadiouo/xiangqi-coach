import { describe, expect, it } from "vitest";
import { createReviewNoteInput, generateReviewNote, type ReviewNoteInput } from "./review-note";
import { STANDARD_START_FEN } from "./game-library";
import { zhTW } from "./locale/zh-TW";

const moves = ["h2e2"];
const artifact = (result: ReviewNoteInput["result"]): Omit<ReviewNoteInput, "metadata" | "notations" | "variationTree"> => ({
  reportDate: "2026-10-09", result, startFen: STANDARD_START_FEN, moves, points: [], boards: [],
  analyzer: { name: "內建引擎", quickNodeLimit: 1, deepNodeLimit: 2, config: "c" },
});
const context = (metadata: Record<string, string>) => ({
  savedGames: [], activeSavedGameId: null, currentMetadata: metadata,
  history: [{ iccs: "h2e2", notation: "炮二平五" }], currentTree: null,
});

describe("note header takes the imported record's result text when the engine could not decide (SPEC section 9 item 1)", () => {
  it.each([["1-0", "red_win"], ["0-1", "black_win"], ["1/2-1/2", "draw"]] as const)("maps %s", (text, expected) => {
    expect(createReviewNoteInput(artifact("unknown"), context({ Result: text })).result).toBe(expected);
  });
  it("leaves an unfinished or unreadable result as unknown", () => {
    for (const text of ["*", "", "紅勝了吧"]) {
      expect(createReviewNoteInput(artifact("unknown"), context({ Result: text })).result).toBe("unknown");
    }
    expect(createReviewNoteInput(artifact("unknown"), context({})).result).toBe("unknown");
  });
  it("never lets a header override a result the engine decided", () => {
    expect(createReviewNoteInput(artifact("black_win"), context({ Result: "1-0" })).result).toBe("black_win");
  });
  it("shows the players and the result in the written note header", () => {
    const input = createReviewNoteInput(artifact("unknown"), context({ Red: "王天一", Black: "胡榮華", Result: "1-0" }));
    const header = generateReviewNote(input).markdown.split("\n## ")[1]!;
    expect(header).toContain("王天一（紅）對 胡榮華（黑）");
    expect(header).toContain(`${zhTW.reviewNote.result}：${zhTW.reviewNote.redWin}`);
  });
});
