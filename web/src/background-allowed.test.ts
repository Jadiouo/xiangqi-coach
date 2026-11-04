import { describe, expect, it } from "vitest";
import { backgroundReviewAllowed, type BackgroundAllowedInput } from "./background-allowed";

const idle: BackgroundAllowedInput = {
  autoReviewOn: true, levelReady: true, levelManual: false, hasState: true, applyingImport: false, workerFailed: false,
  manualReviewRunning: false, outcome: "red_win", historyLength: 3, source: "played", reviewMode: false,
  computerPending: false, computerSearching: false, branchPending: false, branchSearching: false, liveEvaluationOn: false,
};

describe("backgroundReviewAllowed", () => {
  it("allows a finished game on the board with nothing else running", () => {
    expect(backgroundReviewAllowed(idle)).toBe(true);
  });
  it("allows a fresh game with no move made yet", () => {
    expect(backgroundReviewAllowed({ ...idle, outcome: "ongoing", historyLength: 0 })).toBe(true);
  });
  it.each<[string, Partial<BackgroundAllowedInput>]>([
    ["auto review off", { autoReviewOn: false }],
    ["level module not loaded", { levelReady: false }],
    ["level chosen by hand", { levelManual: true }],
    ["no game state yet", { hasState: false }],
    ["an import is applying", { applyingImport: true }],
    ["the game worker failed", { workerFailed: true }],
    ["a review by hand is running", { manualReviewRunning: true }],
    ["a game is going on", { outcome: "ongoing", historyLength: 2 }],
    ["the player's move was sent and the computer has not answered yet", { outcome: "ongoing", historyLength: 0, computerPending: true }],
    ["the computer is searching", { computerSearching: true }],
    ["a branch position is loading", { branchPending: true }],
    ["a branch search is running", { branchSearching: true }],
    ["the live win rate is on during a game", { outcome: "ongoing", historyLength: 0, liveEvaluationOn: true }],
  ])("is not allowed when %s", (_name, change) => {
    expect(backgroundReviewAllowed({ ...idle, ...change })).toBe(false);
  });
  it("does not count an imported or reviewed ongoing game as a game going on", () => {
    expect(backgroundReviewAllowed({ ...idle, outcome: "ongoing", historyLength: 4, source: "imported" })).toBe(true);
    expect(backgroundReviewAllowed({ ...idle, outcome: "ongoing", historyLength: 4, reviewMode: true })).toBe(true);
  });
});
