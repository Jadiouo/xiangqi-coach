import { describe, expect, it } from "vitest";
import {
  DEFAULT_USER_SIDE, boardPlacement, isFlipped, loadUserSide, resultForUser, saveUserSide, squareAtPlacement,
} from "./my-side";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    keys: () => [...data.keys()],
  };
}

const ALL_SQUARES = Array.from({ length: 90 }, (_, index) => `${String.fromCharCode(97 + (index % 9))}${Math.floor(index / 9)}`);

describe("user side preference", () => {
  it("defaults to red when nothing is stored or the value is unreadable", () => {
    expect(DEFAULT_USER_SIDE).toBe("red");
    expect(loadUserSide(memoryStorage())).toBe("red");
    expect(loadUserSide(null)).toBe("red");
    expect(loadUserSide(memoryStorage({ "xq.side.v1": "purple" }))).toBe("red");
    expect(loadUserSide({ getItem: () => { throw new Error("blocked"); } })).toBe("red");
  });

  it("remembers black across loads, and survives a storage that refuses writes", () => {
    const storage = memoryStorage();
    saveUserSide(storage, "black");
    expect(loadUserSide(storage)).toBe("black");
    saveUserSide(storage, "red");
    expect(loadUserSide(storage)).toBe("red");
    expect(() => saveUserSide({ setItem: () => { throw new Error("blocked"); } }, "black")).not.toThrow();
  });
});

describe("board orientation", () => {
  it("flips the board only when the user plays black", () => {
    expect(isFlipped("red")).toBe(false);
    expect(isFlipped("black")).toBe(true);
  });

  it("puts red at the bottom when not flipped and black at the bottom when flipped", () => {
    // placement = {file, row}: file 0 is the left column on screen, row 0 the top row on screen
    expect(boardPlacement("a0", false)).toEqual({ file: 0, row: 9 });
    expect(boardPlacement("e9", false)).toEqual({ file: 4, row: 0 });
    expect(boardPlacement("e9", true)).toEqual({ file: 4, row: 9 });
    expect(boardPlacement("a0", true)).toEqual({ file: 8, row: 0 });
    expect(boardPlacement("i9", true)).toEqual({ file: 0, row: 9 });
  });

  it("converts squares to screen cells and back for every square, in both orientations", () => {
    for (const flipped of [false, true]) {
      for (const square of ALL_SQUARES) {
        const placement = boardPlacement(square, flipped);
        expect(placement.file).toBeGreaterThanOrEqual(0);
        expect(placement.file).toBeLessThanOrEqual(8);
        expect(placement.row).toBeGreaterThanOrEqual(0);
        expect(placement.row).toBeLessThanOrEqual(9);
        expect(squareAtPlacement(placement.file, placement.row, flipped)).toBe(square);
      }
      const cells = new Set(ALL_SQUARES.map((square) => JSON.stringify(boardPlacement(square, flipped))));
      expect(cells.size).toBe(90);
    }
  });
});

describe("result from the user's point of view", () => {
  it("names win, loss and draw by the side the user plays", () => {
    expect(resultForUser("red_win", "red")).toBe("win");
    expect(resultForUser("red_win", "black")).toBe("lose");
    expect(resultForUser("black_win", "black")).toBe("win");
    expect(resultForUser("black_win", "red")).toBe("lose");
    expect(resultForUser("draw", "black")).toBe("draw");
    expect(resultForUser("ongoing", "black")).toBeNull();
    expect(resultForUser("unknown", "red")).toBeNull();
  });
});
