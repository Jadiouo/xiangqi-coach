/** Most review workers the default may open; phones and laptops stay responsive with this cap. */
const DEFAULT_WORKER_CAP = 4;
/** Largest value `?review-workers=N` accepts (tests and measurements only). */
const URL_WORKER_CAP = 8;

/**
 * How many review workers to use: one fewer than the logical cores, clamped to 1..4, so the page
 * and the game worker keep a core. `?review-workers=N` (1..8) overrides it; any other value is ignored.
 */
export function reviewWorkerCount(hardwareConcurrency: number | undefined, search: string): number {
  const requested = new URLSearchParams(search).get("review-workers");
  if (requested !== null && /^[1-8]$/.test(requested)) {
    return Math.min(Number(requested), URL_WORKER_CAP);
  }
  const cores = hardwareConcurrency !== undefined && Number.isFinite(hardwareConcurrency)
    ? Math.floor(hardwareConcurrency)
    : 2;
  return Math.min(DEFAULT_WORKER_CAP, Math.max(1, cores - 1));
}

/** Workers the background review of a finished game may open: two at most, so it never takes all the cores. `?review-workers=N` still overrides. */
export function backgroundWorkerCount(hardwareConcurrency: number | undefined, search: string): number {
  const requested = new URLSearchParams(search).get("review-workers");
  if (requested !== null && /^[1-8]$/.test(requested)) return Number(requested);
  return Math.min(2, reviewWorkerCount(hardwareConcurrency, search));
}

/** `?auto-review=off` switches the background review off (tests only; there is no setting for it). */
export function autoReviewEnabled(search: string): boolean {
  return new URLSearchParams(search).get("auto-review") !== "off";
}
