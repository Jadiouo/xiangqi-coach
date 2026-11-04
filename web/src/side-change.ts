import type { UserSide } from "./my-side";

export interface SideChangeInput {
  reviewMode: boolean;
  source: "played" | "imported";
  /** the user has made a move, or one is on its way to the engine (the computer's own opening does not count) */
  userHasMoved: boolean;
  chosen: UserSide;
  onBoard: UserSide;
}

/** "restart": start again on the chosen side now; "next-game": the choice waits (and the page says so). */
export function sideChangeAction(input: SideChangeInput): "none" | "restart" | "next-game" {
  if (input.chosen === input.onBoard) return "none";
  if (input.reviewMode || input.source === "imported" || input.userHasMoved) return "next-game";
  return "restart";
}
