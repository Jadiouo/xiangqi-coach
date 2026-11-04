import { describe, expect, it } from "vitest";
import { normalizeSavedGameRecord, reviewFieldsForSave, STANDARD_START_FEN, type SavedGame, type SavedReviewSnapshot } from "./game-library";

const emptyBoard = "rnbakabnr" + "........." + ".c.....c." + "p.p.p.p.p" + "........." + "........." + "P.P.P.P.P" + ".C.....C." + "........." + "RNBAKABNR";
const otherFen = "4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1";
const snapshot = (startFen: string): SavedReviewSnapshot => ({ startFen, moves: [], points: [], boards: [emptyBoard],
  analyzer: { name: "內建引擎", quickNodeLimit: 1, deepNodeLimit: 2, config: "c" }, result: "unknown", reportDate: "2026-10-09" });
const note = { reportDate: "2026-10-09", markdown: "# 覆盤筆記", plainText: "覆盤筆記", curveSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' };
const row = (fields: Pick<SavedGame, "reviewSnapshot" | "reviewNote">): SavedGame => ({
  id: "g", savedAt: 1, moves: [], startFen: STANDARD_START_FEN, source: "played", importFormat: null, importMetadata: {},
  importWarnings: [], variationTree: null, ...fields,
});

describe("saving a game never stores a note that the library would silently drop on the next read", () => {
  it("keeps snapshot and note together when root and moves match, and they survive a read", () => {
    const saved = reviewFieldsForSave(snapshot(STANDARD_START_FEN), note, STANDARD_START_FEN, []);
    expect(saved.droppedNote).toBe(false);
    expect(normalizeSavedGameRecord(row(saved))?.reviewNote).toEqual(note);
  });
  it("same moves but a different root: neither is attached, and the caller is told the note was not saved", () => {
    const saved = reviewFieldsForSave(snapshot(otherFen), note, STANDARD_START_FEN, []);
    expect(saved.reviewSnapshot).toBeNull();
    expect(saved.reviewNote).toBeNull();
    expect(saved.droppedNote).toBe(true);
  });
  it("nothing to store when there is no analysis", () => {
    expect(reviewFieldsForSave(null, null, STANDARD_START_FEN, [])).toEqual({ reviewSnapshot: null, reviewNote: null, droppedNote: false });
  });
});
