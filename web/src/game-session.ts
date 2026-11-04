export type Side = "red" | "black";

/** The part of the wasm game the play worker uses to decide who moves; a fake follows the same contract in tests. */
export interface SessionGame {
  side_to_move(): Side;
  history(): string;
  outcome(): string;
  undo_last_move(): boolean;
  ai_move(nodeLimit: number, level: number): boolean;
}

export function historyLength(game: SessionGame): number {
  return game.history().split("\n").filter(Boolean).length;
}

/** The computer moves whenever the game is on and it is not the user's turn. */
export function computerToMove(game: SessionGame, userSide: Side): boolean {
  return game.outcome() === "ongoing" && game.side_to_move() !== userSide;
}

/** Searches and plays the computer's move; false when it is not the computer's turn or no move came out. */
export function playComputerMove(game: SessionGame, userSide: Side, nodeLimit: number, level: number): boolean {
  if (!computerToMove(game, userSide)) return false;
  return game.ai_move(nodeLimit, level);
}

/**
 * One undo = one turn: back to the last position where the user is to move, at least one ply.
 * A user who plays black cannot take back the computer's opening move (nothing earlier to return to),
 * so that undo is refused and the game is left as it is.
 */
export function undoToUserTurn(game: SessionGame, userSide: Side): boolean {
  const length = historyLength(game);
  const floor = userSide === "black" ? 1 : 0;
  const remove = Math.min(game.side_to_move() === userSide ? 2 : 1, length - floor);
  if (remove <= 0) return false;
  for (let step = 0; step < remove; step += 1) {
    if (!game.undo_last_move()) return false;
  }
  return true;
}
