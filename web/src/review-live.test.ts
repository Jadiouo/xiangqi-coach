import { describe, expect, it } from "vitest";
import { liveMeterDisplay, liveMeterView, undoPlan } from "./review-live";

describe("undoPlan", () => {
  it("outside review undoes the main game when there is history", () => {
    expect(undoPlan({ reviewMode: false, boardShown: false, parentId: null, busy: false, mainHistoryLength: 2 })).toEqual({ kind: "main" });
    expect(undoPlan({ reviewMode: false, boardShown: false, parentId: null, busy: false, mainHistoryLength: 0 })).toEqual({ kind: "none" });
  });
  it("in review goes to the parent node and never touches the main game", () => {
    expect(undoPlan({ reviewMode: true, boardShown: true, parentId: "branch-1", busy: false, mainHistoryLength: 4 }))
      .toEqual({ kind: "branch", nodeId: "branch-1" });
    expect(undoPlan({ reviewMode: true, boardShown: true, parentId: "main-1", busy: false, mainHistoryLength: 4 }))
      .toEqual({ kind: "branch", nodeId: "main-1" });
  });
  it("in review undoes the user's board move together with the engine reply, like undo in a game", () => {
    expect(undoPlan({ reviewMode: true, boardShown: true, parentId: "branch-1", turnStartId: "main-1", busy: false, mainHistoryLength: 4 }))
      .toEqual({ kind: "branch", nodeId: "main-1" });
    expect(undoPlan({ reviewMode: true, boardShown: true, parentId: "branch-1", turnStartId: null, busy: false, mainHistoryLength: 4 }))
      .toEqual({ kind: "branch", nodeId: "branch-1" });
  });
  it("in review it is disabled at the root, while busy, or before a branch position is shown", () => {
    expect(undoPlan({ reviewMode: true, boardShown: true, parentId: null, busy: false, mainHistoryLength: 4 })).toEqual({ kind: "none" });
    expect(undoPlan({ reviewMode: true, boardShown: true, parentId: "main-1", busy: true, mainHistoryLength: 4 })).toEqual({ kind: "none" });
    expect(undoPlan({ reviewMode: true, boardShown: false, parentId: "main-1", busy: false, mainHistoryLength: 4 })).toEqual({ kind: "none" });
  });
});

describe("liveMeterView", () => {
  const main = { fen: "main-fen", value: 0.6, side: "black" as const };
  const branch = { fen: "branch-fen", redValue: 0.3, side: "red" as const };
  it("follows the main game outside review", () => {
    expect(liveMeterView({ reviewMode: false, main, mainBoardFen: "main-fen", branch, branchBoardFen: "branch-fen" })).toEqual(main);
    expect(liveMeterView({ reviewMode: false, main, mainBoardFen: "other", branch, branchBoardFen: "branch-fen" })).toBeNull();
  });
  it("follows the displayed branch position in review", () => {
    expect(liveMeterView({ reviewMode: true, main, mainBoardFen: "main-fen", branch, branchBoardFen: "branch-fen" }))
      .toEqual({ fen: "branch-fen", value: 0.3, side: "red" });
  });
  it("shows nothing in review when the branch result is stale or missing", () => {
    expect(liveMeterView({ reviewMode: true, main, mainBoardFen: "main-fen", branch, branchBoardFen: "newer-fen" })).toBeNull();
    expect(liveMeterView({ reviewMode: true, main, mainBoardFen: "main-fen", branch: null, branchBoardFen: "branch-fen" })).toBeNull();
    expect(liveMeterView({ reviewMode: true, main, mainBoardFen: "main-fen", branch, branchBoardFen: undefined })).toBeNull();
  });
});

describe("liveMeterDisplay", () => {
  const main = { fen: "main-fen", value: 0.6, side: "black" as const };
  const branch = { fen: "branch-fen", redValue: 0.3, side: "red" as const };
  const base = { enabled: true, mainBoardFen: "main-fen", branch, branchBoardFen: "branch-fen" };

  it("shows the main figure outside review when it is for the board position", () => {
    expect(liveMeterDisplay({ ...base, reviewMode: false, main })).toEqual({ visible: true, figure: main });
  });
  it("outside review keeps the last main figure behind a hidden meter when the board has moved on", () => {
    expect(liveMeterDisplay({ ...base, reviewMode: false, main, mainBoardFen: "other" })).toEqual({ visible: false, figure: main });
  });
  it("has no figure at all before any main evaluation arrived", () => {
    expect(liveMeterDisplay({ ...base, reviewMode: false, main: null })).toEqual({ visible: false, figure: null });
  });
  it("in review shows the displayed branch position's figure and nothing for a stale one", () => {
    expect(liveMeterDisplay({ ...base, reviewMode: true, main })).toEqual({ visible: true, figure: { fen: "branch-fen", value: 0.3, side: "red" } });
    expect(liveMeterDisplay({ ...base, reviewMode: true, main, branchBoardFen: "newer" })).toEqual({ visible: false, figure: null });
  });
  it("is hidden while live evaluation is off, but still reports the figure", () => {
    expect(liveMeterDisplay({ ...base, reviewMode: false, main, enabled: false })).toEqual({ visible: false, figure: main });
  });
});
