import type { ReviewPiece, ReviewReason } from "./review-client";

export type ReviewSide = "red" | "black";

/** Convert a probability from the player-to-move view to the selected user's view. */
export function winProbabilityForUser(
  moverProbability: number,
  moverSide: ReviewSide,
  userSide: ReviewSide,
): number {
  return moverSide === userSide ? moverProbability : 1 - moverProbability;
}

/** Convert a side-to-move centipawn score to the selected user's win probability. */
export function liveWinProbabilityForUser(
  scoreCentipawns: number,
  sideToMove: ReviewSide,
  userSide: ReviewSide,
): number {
  const sideProbability = 1 / (1 + Math.exp(-scoreCentipawns / 300));
  return winProbabilityForUser(sideProbability, sideToMove, userSide);
}

export interface ArrowEnds { from: string; to: string }

/** What the review page draws on the board for one key move: two arrows and the endangered squares. */
export interface ArrowPlan {
  played: ArrowEnds | null;
  best: ArrowEnds | null;
  danger: string[];
}

const SQUARE = /^[a-i][0-9]$/;

function arrowOf(move: string): ArrowEnds | null {
  if (move.length !== 4) return null;
  const from = move.slice(0, 2);
  const to = move.slice(2);
  return SQUARE.test(from) && SQUARE.test(to) ? { from, to } : null;
}

const KIND_OF_CHAR: Record<string, ReviewPiece["kind"]> = {
  k: "king", a: "advisor", b: "elephant", n: "horse", r: "rook", c: "cannon", p: "pawn",
};

/** Does the 90-char board (row 0 = rank 9) hold exactly `piece` on `square`? */
function boardHolds(board: string, square: string, piece: ReviewPiece): boolean {
  if (board.length !== 90 || !SQUARE.test(square)) return false;
  const char = board[(9 - Number(square[1])) * 9 + (square.charCodeAt(0) - 97)] ?? ".";
  if (char === ".") return false;
  const side: ReviewSide = char === char.toLowerCase() ? "black" : "red";
  return side === piece.side && KIND_OF_CHAR[char.toLowerCase()] === piece.kind;
}

/**
 * Squares of the mover's pieces the review data names as lost or in danger, expressed on the board BEFORE the
 * played move (that is the board the rings are drawn on). Each source square is a square of the position after
 * the move (or later in the line), so: a square equal to the landing square means the moved piece, which stood on
 * `from` before the move; then the pre-move board must hold that very piece (same side and kind) of the mover on
 * that square, otherwise nothing is drawn. Better no ring than a ring on the wrong piece (see DECISIONS, H).
 */
export function dangerSquares(
  reason: ReviewReason | null | undefined,
  context: { playedMove: string; mover?: ReviewSide; board?: string },
): string[] {
  if (!reason || !context.board || !context.mover) return [];
  const played = arrowOf(context.playedMove);
  const { board, mover } = context;
  const place = (square: string, piece: ReviewPiece): string[] => {
    if (piece.side !== mover) return [];
    const before = played && square === played.to ? played.from : square;
    return boardHolds(board, before, piece) ? [before] : [];
  };
  switch (reason.kind) {
    case "sent_piece":
      return place(reason.protection.capturedAt, reason.protection.piece);
    case "abandoned_protection": {
      const { protectedPiece, protectedSquare, capturedAt, piece } = reason.protection;
      return protectedPiece && protectedSquare ? place(protectedSquare, protectedPiece) : place(capturedAt, piece);
    }
    case "cannon_mount":
      return place(reason.cannonMount.victimSquare, reason.cannonMount.victim);
    case "check_capture":
      return place(reason.checkCapture.victimSquare, reason.checkCapture.victim);
    case "dropped_material":
      for (const capture of reason.material.playedCaptures) {
        const found = place(capture.square, capture.piece);
        if (found.length) return found;
      }
      return [];
    default:
      return [];
  }
}

export function buildArrowPlan(input: {
  playedMove: string;
  bestMove: string;
  reason?: ReviewReason | null;
  /** Side that played the move and the board before it (90 chars); without them no ring is drawn. */
  mover?: ReviewSide;
  board?: string;
}): ArrowPlan {
  const played = arrowOf(input.playedMove);
  const best = input.bestMove === input.playedMove ? null : arrowOf(input.bestMove);
  return { played, best, danger: dangerSquares(input.reason, input) };
}

/** Classifications the review page lists as "worth a look"; good, only-move and unrated plies are not. */
const ATTENTION = new Set(["inaccuracy", "doubtful_move", "mistake", "blunder", "missed_mate"]);

/**
 * Plies (0-based, ascending) of `userSide` that deserve a look. `shows` is the player's level filter
 * (same one that marks the win-rate curve); without it every attention class counts.
 */
export function focusPoints(
  points: ReadonlyArray<{ classification: string }>,
  sides: ReadonlyArray<ReviewSide>,
  userSide: ReviewSide,
  shows?: (classification: string) => boolean,
): number[] {
  const list: number[] = [];
  points.forEach((point, index) => {
    if (sides[index] !== userSide || !ATTENTION.has(point.classification)) return;
    if (shows && !shows(point.classification)) return;
    list.push(index);
  });
  return list;
}

export interface FocusNav {
  /** 1-based place of `current` in the list; null when `current` is not a key move. */
  position: number | null;
  total: number;
  prev: number | null;
  next: number | null;
  prevDisabled: boolean;
  nextDisabled: boolean;
}

export function focusNav(list: ReadonlyArray<number>, current: number | null): FocusNav {
  const at = current === null ? -1 : list.indexOf(current);
  const prev = current === null ? null : [...list].reverse().find((value) => value < current) ?? null;
  const next = current === null ? (list[0] ?? null) : list.find((value) => value > current) ?? null;
  return {
    position: at >= 0 ? at + 1 : null,
    total: list.length,
    prev,
    next,
    prevDisabled: prev === null,
    nextDisabled: next === null,
  };
}

/** Side that moves at each ply of a game that starts from `startFen` (the FEN's second field: w = red). */
export function plySides(startFen: string, count: number): ReviewSide[] {
  const first: ReviewSide = startFen.split(" ")[1] === "b" ? "black" : "red";
  const other: ReviewSide = first === "red" ? "black" : "red";
  return Array.from({ length: count }, (_, index) => (index % 2 === 0 ? first : other));
}
