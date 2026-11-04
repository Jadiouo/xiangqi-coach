import { describe, expect, it } from "vitest";
import { libraryRowParts } from "./library-row";
import { STANDARD_START_FEN, type SavedGame } from "./game-library";

const base: SavedGame = {
  id: "g", savedAt: 5, moves: ["h2e2", "h9g7", "b0c2"], startFen: STANDARD_START_FEN, source: "played",
  importFormat: null, importMetadata: {}, importWarnings: [], variationTree: null,
};

describe("library row facts", () => {
  it("shows result, side, difficulty and move count for a played game", () => {
    expect(libraryRowParts({ ...base, userSide: "black", difficulty: 7, outcome: "black_win" }))
      .toEqual({ result: "你贏", side: "執黑", difficulty: "難度 7" });
    expect(libraryRowParts({ ...base, userSide: "red", difficulty: 1, outcome: "black_win" }).result).toBe("你輸");
    expect(libraryRowParts({ ...base, difficulty: 1, outcome: "draw" }).result).toBe("和棋");
  });

  it("says a game without a finished result is not finished, and an unknown result is a dash", () => {
    expect(libraryRowParts({ ...base, outcome: "ongoing" }).result).toBe("未結束");
    expect(libraryRowParts({ ...base }).result).toBe("—");
  });

  it("takes the result from the review snapshot when the record has no outcome field (older saves)", () => {
    const snapshot = { result: "red_win" } as SavedGame["reviewSnapshot"];
    expect(libraryRowParts({ ...base, reviewSnapshot: snapshot }).result).toBe("你贏");
  });

  it("shows a dash for the difficulty of a game saved before the field existed", () => {
    expect(libraryRowParts({ ...base }).difficulty).toBe("難度 —");
    expect(libraryRowParts({ ...base }).side).toBe("執紅");
  });

  it("an imported game has no side or difficulty and shows the plain result", () => {
    const parts = libraryRowParts({ ...base, source: "imported", outcome: "red_win" });
    expect(parts.side).toBeNull();
    expect(parts.difficulty).toBeNull();
    expect(parts.result).toBe("紅方勝");
  });
});
