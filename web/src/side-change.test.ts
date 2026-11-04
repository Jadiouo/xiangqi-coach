import { describe, expect, it } from "vitest";
import { sideChangeAction } from "./side-change";

const base = { reviewMode: false, source: "played" as const, userHasMoved: false, chosen: "black" as const, onBoard: "red" as const };

describe("what choosing a side does to the game on the board", () => {
  it("does nothing when the chosen side is already the side on the board", () => {
    expect(sideChangeAction({ ...base, chosen: "red" })).toBe("none");
  });

  it("restarts at once while the user has not moved, also while the computer is still thinking about its opening", () => {
    expect(sideChangeAction(base)).toBe("restart");
    expect(sideChangeAction({ ...base, chosen: "red", onBoard: "black" })).toBe("restart");
  });

  it("waits for the next game once the user has moved, in review, or on an imported record", () => {
    expect(sideChangeAction({ ...base, userHasMoved: true })).toBe("next-game");
    expect(sideChangeAction({ ...base, reviewMode: true })).toBe("next-game");
    expect(sideChangeAction({ ...base, source: "imported" })).toBe("next-game");
  });
});
