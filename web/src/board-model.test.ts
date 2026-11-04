import { describe, expect, it } from "vitest";
import { boardCells, legalDestinations } from "./board-model";

const startBoard = [
  "rnbakabnr",
  ".........",
  ".c.....c.",
  "p.p.p.p.p",
  ".........",
  ".........",
  "P.P.P.P.P",
  ".C.....C.",
  ".........",
  "RNBAKABNR",
].join("");

describe("board presentation model", () => {
  it("places rank 9 at the top and maps red and black pieces to Chinese labels", () => {
    const cells = boardCells(startBoard);

    expect(cells).toHaveLength(90);
    expect(cells[0]).toMatchObject({ square: "a9", piece: "r", side: "black", label: "車" });
    expect(cells[81]).toMatchObject({ square: "a0", piece: "R", side: "red", label: "車" });
    expect(cells[40]).toMatchObject({ square: "e5", piece: ".", side: null, label: "" });
  });

  it("returns only legal destinations for the selected origin", () => {
    expect(legalDestinations("h2e2,h2g2,h0g2", "h2")).toEqual(["e2", "g2"]);
    expect(legalDestinations("h2e2,h2g2,h0g2", "i2")).toEqual([]);
    expect(legalDestinations("", "h2")).toEqual([]);
  });
});
