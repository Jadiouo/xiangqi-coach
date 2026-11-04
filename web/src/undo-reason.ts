import type { UndoPlan } from "./review-live";

export interface UndoReasonInput {
  applyingImport: boolean;
  workerFailed: boolean;
  /** The game has been loaded at least once. */
  hasState: boolean;
  /** A command is running in the game worker. */
  pending: boolean;
  /** ...and it is the computer's search. */
  searching: boolean;
  /** The review page shows a game whose review has not started: undo would take it apart. */
  reviewPageLocked: boolean;
  planKind: UndoPlan["kind"];
  reviewMode: boolean;
  /** In review: the board is loading or a trial move is being answered. */
  branchBusy: boolean;
}

export type UndoReason =
  | "workerFailed" | "importing" | "loading" | "thinking" | "busy" | "reviewLocked" | "noMoves" | "branchStart" | "branchBusy";

/** Why the undo button is off (the key of the sentence to show), or null while it works. */
export function undoDisabledReason(input: UndoReasonInput): UndoReason | null {
  if (input.workerFailed) return "workerFailed";
  if (input.applyingImport) return "importing";
  if (!input.hasState) return "loading";
  if (input.pending) return input.searching ? "thinking" : "busy";
  if (input.reviewPageLocked) return "reviewLocked";
  if (input.planKind === "none") {
    if (!input.reviewMode) return "noMoves";
    return input.branchBusy ? "branchBusy" : "branchStart";
  }
  return null;
}
