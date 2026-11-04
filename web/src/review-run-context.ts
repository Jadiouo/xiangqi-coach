export interface ReviewRunContext {
  readonly runId: number;
  readonly startFen: string;
  readonly moves: readonly string[];
  readonly quickNodeLimit: number;
  readonly config: "SearchConfig::default()";
}

export function createReviewRunContext(
  runId: number,
  startFen: string,
  moves: string[],
  quickNodeLimit: number,
): ReviewRunContext {
  return Object.freeze({
    runId,
    startFen,
    moves: Object.freeze([...moves]),
    quickNodeLimit,
    config: "SearchConfig::default()",
  });
}

export function isCurrentReviewRun(
  callbackRun: ReviewRunContext,
  activeRun: ReviewRunContext | null,
  currentStartFen: string,
  currentMoves: string[],
): boolean {
  return activeRun !== null
    && callbackRun.runId === activeRun.runId
    && callbackRun.startFen === activeRun.startFen
    && callbackRun.moves.length === activeRun.moves.length
    && callbackRun.moves.every((move, index) => move === activeRun.moves[index])
    && currentStartFen === activeRun.startFen
    && currentMoves.length === activeRun.moves.length
    && currentMoves.every((move, index) => move === activeRun.moves[index]);
}
