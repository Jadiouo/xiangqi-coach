import { describe, expect, it } from "vitest";
import { undoPlan } from "./review-live";

const base = { reviewMode: false, boardShown: false, parentId: null, busy: false };

describe("undo plan on the play page by side", () => {
  it("red can take back from the first move on (unchanged)", () => {
    expect(undoPlan({ ...base, mainHistoryLength: 0 })).toEqual({ kind: "none" });
    expect(undoPlan({ ...base, mainHistoryLength: 1 })).toEqual({ kind: "main" });
    expect(undoPlan({ ...base, mainHistoryLength: 1, userSide: "red" })).toEqual({ kind: "main" });
  });

  it("black cannot take back while only the computer's first move is on the board", () => {
    expect(undoPlan({ ...base, mainHistoryLength: 0, userSide: "black" })).toEqual({ kind: "none" });
    expect(undoPlan({ ...base, mainHistoryLength: 1, userSide: "black" })).toEqual({ kind: "none" });
    expect(undoPlan({ ...base, mainHistoryLength: 2, userSide: "black" })).toEqual({ kind: "main" });
    expect(undoPlan({ ...base, mainHistoryLength: 3, userSide: "black" })).toEqual({ kind: "main" });
  });
});
