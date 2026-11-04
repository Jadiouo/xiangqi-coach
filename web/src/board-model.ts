import { zhTW } from "./locale/zh-TW";

export type PieceSide = "red" | "black" | null;

export interface BoardCell {
  square: string;
  file: number;
  rank: number;
  row: number;
  piece: string;
  side: PieceSide;
  label: string;
}

const pieceLabels: Record<string, { side: Exclude<PieceSide, null>; label: string }> = {
  K: { side: "red", label: zhTW.pieces.red.king },
  A: { side: "red", label: zhTW.pieces.red.advisor },
  B: { side: "red", label: zhTW.pieces.red.elephant },
  N: { side: "red", label: zhTW.pieces.red.horse },
  R: { side: "red", label: zhTW.pieces.red.rook },
  C: { side: "red", label: zhTW.pieces.red.cannon },
  P: { side: "red", label: zhTW.pieces.red.pawn },
  k: { side: "black", label: zhTW.pieces.black.king },
  a: { side: "black", label: zhTW.pieces.black.advisor },
  b: { side: "black", label: zhTW.pieces.black.elephant },
  n: { side: "black", label: zhTW.pieces.black.horse },
  r: { side: "black", label: zhTW.pieces.black.rook },
  c: { side: "black", label: zhTW.pieces.black.cannon },
  p: { side: "black", label: zhTW.pieces.black.pawn },
};

export function boardCells(board: string): BoardCell[] {
  if (board.length !== 90) throw new Error(zhTW.errors.invalidBoard);
  return Array.from(board, (piece, index) => {
    const row = Math.floor(index / 9);
    const file = index % 9;
    const rank = 9 - row;
    const parsed = piece === "." ? null : pieceLabels[piece];
    if (piece !== "." && !parsed) throw new Error(zhTW.errors.invalidBoard);
    return {
      square: `${String.fromCharCode(97 + file)}${rank}`,
      file,
      rank,
      row,
      piece,
      side: parsed?.side ?? null,
      label: parsed?.label ?? "",
    };
  });
}

export function legalDestinations(legalMoves: string, origin: string): string[] {
  if (origin.length !== 2) return [];
  return legalMoves
    .split(",")
    .filter((move) => move.length === 4 && move.slice(0, 2) === origin)
    .map((move) => move.slice(2));
}
