import type { Side } from "./game-session";

export type { Side };

export type UndoPlan = { kind: "main" } | { kind: "branch"; nodeId: string } | { kind: "none" };

/** What 悔棋 does: during review it steps back on the line shown on the board and never touches the main game. */
export function undoPlan(input: {
  reviewMode: boolean;
  /** a branch position is on the board */
  boardShown: boolean;
  /** parent of the variation-tree node on the board, null at the root */
  parentId: string | null;
  /** node before the board move whose engine reply produced the node on the board, if any */
  turnStartId?: string | null;
  busy: boolean;
  mainHistoryLength: number;
  /** The side the user plays (default red). A black user cannot take back the computer's opening move. */
  userSide?: Side;
}): UndoPlan {
  if (!input.reviewMode) {
    const needed = input.userSide === "black" ? 2 : 1;
    return input.mainHistoryLength >= needed ? { kind: "main" } : { kind: "none" };
  }
  if (!input.boardShown || input.busy || input.parentId === null) return { kind: "none" };
  return { kind: "branch", nodeId: input.turnStartId ?? input.parentId };
}

export interface LiveMeterView {
  fen: string;
  value: number;
  side: Side;
}

/** Which red-perspective figure the live meter shows: the main game's, or in review the displayed branch position's. */
export function liveMeterView(input: {
  reviewMode: boolean;
  main: LiveMeterView | null;
  mainBoardFen: string | undefined;
  branch: { fen: string; redValue: number; side: Side } | null;
  branchBoardFen: string | undefined;
}): LiveMeterView | null {
  if (!input.reviewMode) return input.main && input.main.fen === input.mainBoardFen ? input.main : null;
  const { branch } = input;
  if (!branch || branch.fen !== input.branchBoardFen) return null;
  return { fen: branch.fen, value: branch.redValue, side: branch.side };
}

/** What the live meter does this render: whether it shows, and the figure whose numbers go on the element (null = leave them as they are). */
export function liveMeterDisplay(input: Parameters<typeof liveMeterView>[0] & { enabled: boolean }): { visible: boolean; figure: LiveMeterView | null } {
  const view = liveMeterView(input);
  // outside review the last main figure is written even when the board has moved on (the meter is hidden then); in review only a current one is
  return { visible: input.enabled && view !== null, figure: input.reviewMode ? view : input.main };
}
