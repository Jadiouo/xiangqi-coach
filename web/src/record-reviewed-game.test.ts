import { describe, expect, it } from "vitest";
import { createUserLevel, recordReviewedGame, reviewedGameKey, sidesOfMoves } from "./user-level";
import { fakeLevelWasm, memoryStorage } from "./test-support-level";

const RED_FIRST = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";
const BLACK_FIRST = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b - - 0 1";
const point = (loss: number) => ({ final: { lossPercent: loss, classification: "good" } });

describe("sidesOfMoves", () => {
  it("alternates from red when red is to move", () => {
    expect(sidesOfMoves(RED_FIRST, ["a", "b", "c"])).toEqual(["red", "black", "red"]);
  });
  it("alternates from black when black is to move", () => {
    expect(sidesOfMoves(BLACK_FIRST, ["a", "b", "c"])).toEqual(["black", "red", "black"]);
  });
  it("is empty for no moves", () => {
    expect(sidesOfMoves(RED_FIRST, [])).toEqual([]);
  });
});

describe("recordReviewedGame", () => {
  it("scores only the user's side, using the data passed in, and counts a game once", () => {
    const level = createUserLevel(fakeLevelWasm(), memoryStorage());
    const context = { startFen: RED_FIRST, moves: ["a", "b"], userSide: "black" as const, provenance: "own" as const };
    expect(recordReviewedGame(level, context, [point(1), point(2)])).toBe(true);
    expect(recordReviewedGame(level, context, [point(1), point(2)])).toBe(true);
    expect(level.view().gameCount).toBe(1);
  });
  it("records nothing when the user made no move in the game", () => {
    const level = createUserLevel(fakeLevelWasm(), memoryStorage());
    const context = { startFen: RED_FIRST, moves: ["a"], userSide: "black" as const, provenance: "own" as const };
    expect(recordReviewedGame(level, context, [point(1)])).toBe(false);
    expect(level.view().gameCount).toBe(0);
  });
  it("does nothing without a level module", () => {
    expect(recordReviewedGame(null, { startFen: RED_FIRST, moves: ["a"], userSide: "red", provenance: "own" }, [point(1)])).toBe(false);
  });
  it("keys a game by start position, moves and side", () => {
    expect(reviewedGameKey({ startFen: "f", moves: ["a", "b"], userSide: "red" })).toBe("f|a b|red");
  });
});
