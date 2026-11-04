export type UserSide = "red" | "black";

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem">;

export const DEFAULT_USER_SIDE: UserSide = "red";
const STORAGE_KEY = "xq.side.v1";

/** The side the user chose last time; anything unreadable falls back to red. */
export function loadUserSide(storage: ReadStorage | null): UserSide {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return raw === "black" ? "black" : DEFAULT_USER_SIDE;
  } catch {
    return DEFAULT_USER_SIDE;
  }
}

export function saveUserSide(storage: WriteStorage | null, side: UserSide): void {
  try { storage?.setItem(STORAGE_KEY, side); } catch { /* storage is a convenience only */ }
}

export function isUserSide(value: unknown): value is UserSide {
  return value === "red" || value === "black";
}

/** The board is turned around (black at the bottom) when the user plays black. */
export function isFlipped(side: UserSide): boolean {
  return side === "black";
}

export interface BoardPlacement {
  /** column on screen, 0 = left */
  file: number;
  /** row on screen, 0 = top */
  row: number;
}

/** Where a square such as "e9" is drawn: red at the bottom normally, black at the bottom when flipped. */
export function boardPlacement(square: string, flipped: boolean): BoardPlacement {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]);
  return flipped ? { file: 8 - file, row: rank } : { file, row: 9 - rank };
}

/** Inverse of `boardPlacement`. */
export function squareAtPlacement(file: number, row: number, flipped: boolean): string {
  const squareFile = flipped ? 8 - file : file;
  const rank = flipped ? row : 9 - row;
  return `${String.fromCharCode(97 + squareFile)}${rank}`;
}

export type UserResult = "win" | "lose" | "draw";

/** The game result from the user's seat; null while the game goes on or the result is unknown. */
export function resultForUser(outcome: string, side: UserSide): UserResult | null {
  if (outcome === "draw") return "draw";
  if (outcome === "red_win") return side === "red" ? "win" : "lose";
  if (outcome === "black_win") return side === "black" ? "win" : "lose";
  return null;
}
