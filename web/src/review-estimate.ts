/**
 * Seconds one ply takes on one worker at the 100,000-node budget in the web page, wasm, with the 3x deep pass and
 * adjacent-ply merge now in the code: 23 s (8 plies of the sample game in e2e/review-pdf, 186 s, `?review-workers=1`).
 * At the 1,000,000 budget it is 50 s (first 3 plies, 151 s). Both measured 2026-10-24 on a loaded machine
 * (load average 25-49 on 16 cores), so they lean high. Time grows much slower than the budget (most plies stop on
 * their own before the node limit), so the budget enters as a power: 10x the nodes cost 2.2x the time, exponent 0.34.
 * The 5,000,000 figure is that curve carried further, not measured; the page calls the result a rough estimate.
 */
export const REVIEW_SECONDS_PER_PLY_AT_100K = 23;
export const REVIEW_BUDGET_EXPONENT = 0.34;
/** Extra speed per extra worker: 4 workers measured 2.36x of 1 worker (docs/PROGRESS.md, P2: 1984 s -> 841 s), so 1 + 3 * 0.45. */
export const REVIEW_PARALLEL_GAIN = 0.45;
/** Reviews expected to take this long or longer are announced before they start: the user's choice, 15 minutes (docs/DECISIONS.md, batch B item 4). */
export const LONG_REVIEW_SECONDS = 900;
/** Computed plies needed before the running pace is trusted for the time left. */
export const MIN_PLIES_FOR_PACE = 3;

/** `?review-seconds-per-ply=N` replaces the seconds-per-ply figure (tests only, so they never depend on this machine's speed). */
export function secondsPerPlyOverride(search: string): number | undefined {
  const raw = new URLSearchParams(search).get("review-seconds-per-ply");
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function estimateReviewSeconds(input: {
  plies: number;
  /** Plies the review cache already holds: they cost nothing, so only the rest is estimated. */
  cachedPlies?: number;
  nodeLimit: number;
  workers: number;
  secondsPerPlyAt100k?: number;
}): number {
  const missing = input.plies - Math.max(0, input.cachedPlies ?? 0);
  if (missing <= 0) return 0;
  const perPly = (input.secondsPerPlyAt100k ?? REVIEW_SECONDS_PER_PLY_AT_100K) * Math.pow(input.nodeLimit / 100_000, REVIEW_BUDGET_EXPONENT);
  const workers = Math.max(1, Math.min(Math.floor(input.workers), missing));
  return (missing * perPly) / (1 + (workers - 1) * REVIEW_PARALLEL_GAIN);
}

export function longReviewWarning(estimatedSeconds: number, threshold = LONG_REVIEW_SECONDS): boolean {
  return estimatedSeconds >= threshold;
}

/**
 * Seconds left, from the plies finished so far and the time spent; null while that is too little to go on.
 * Plies answered from the cache cost no time, so they stay out of the pace.
 */
export function remainingSeconds(input: { done: number; cached: number; total: number; elapsedMs: number }): number | null {
  if (input.total > 0 && input.done >= input.total) return 0;
  const computed = input.done - input.cached;
  if (computed < MIN_PLIES_FOR_PACE || !(input.elapsedMs > 0)) return null;
  return (input.elapsedMs / 1000 / computed) * (input.total - input.done);
}
