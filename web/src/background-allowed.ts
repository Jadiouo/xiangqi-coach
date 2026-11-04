export interface BackgroundAllowedInput {
  autoReviewOn: boolean;
  levelReady: boolean;
  levelManual: boolean;
  hasState: boolean;
  applyingImport: boolean;
  workerFailed: boolean;
  /** A review the user started is running in the foreground. */
  manualReviewRunning: boolean;
  outcome: string;
  historyLength: number;
  source: "played" | "imported";
  reviewMode: boolean;
  /** A command (the player's move) was sent to the game worker and not answered yet. */
  computerPending: boolean;
  computerSearching: boolean;
  branchPending: boolean;
  branchSearching: boolean;
  liveEvaluationOn: boolean;
}

/** Nothing else needs the machine: no game still going, no search of the user's own running. */
export function backgroundReviewAllowed(input: BackgroundAllowedInput): boolean {
  if (!input.autoReviewOn || !input.levelReady || input.levelManual || !input.hasState) return false;
  if (input.applyingImport || input.workerFailed || input.manualReviewRunning) return false;
  if (input.computerPending || input.computerSearching || input.branchPending || input.branchSearching) return false;
  const ongoing = input.outcome === "ongoing";
  if (ongoing && input.liveEvaluationOn) return false;
  const gameGoing = ongoing && input.historyLength > 0 && input.source === "played" && !input.reviewMode;
  return !gameGoing;
}
