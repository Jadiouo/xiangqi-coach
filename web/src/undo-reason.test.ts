import { describe, expect, it } from "vitest";
import { undoDisabledReason, type UndoReasonInput } from "./undo-reason";

const ready: UndoReasonInput = {
  applyingImport: false, workerFailed: false, hasState: true, pending: false, searching: false,
  reviewPageLocked: false, planKind: "main", reviewMode: false, branchBusy: false,
};

describe("why the undo button is off", () => {
  it("is null when undo works", () => {
    expect(undoDisabledReason(ready)).toBeNull();
    expect(undoDisabledReason({ ...ready, reviewMode: true, planKind: "branch" })).toBeNull();
  });

  it("names the computer thinking, not just any busy state", () => {
    expect(undoDisabledReason({ ...ready, pending: true, searching: true })).toBe("thinking");
    expect(undoDisabledReason({ ...ready, pending: true })).toBe("busy");
  });

  it("says there is nothing to take back", () => {
    expect(undoDisabledReason({ ...ready, planKind: "none" })).toBe("noMoves");
  });

  it("in review, tells the start of the line from a board that is still loading", () => {
    expect(undoDisabledReason({ ...ready, reviewMode: true, planKind: "none" })).toBe("branchStart");
    expect(undoDisabledReason({ ...ready, reviewMode: true, planKind: "none", branchBusy: true })).toBe("branchBusy");
  });

  it("covers the other stop conditions", () => {
    expect(undoDisabledReason({ ...ready, workerFailed: true })).toBe("workerFailed");
    expect(undoDisabledReason({ ...ready, applyingImport: true })).toBe("importing");
    expect(undoDisabledReason({ ...ready, hasState: false })).toBe("loading");
    expect(undoDisabledReason({ ...ready, reviewPageLocked: true })).toBe("reviewLocked");
  });
});
