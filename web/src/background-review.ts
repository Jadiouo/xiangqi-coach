import type { PlayedGame, PlayedGames } from "./played-games";
import type { ReviewJobState } from "./review-client";

/** The part of the review pool the background review uses. */
export interface BackgroundPool {
  start(moves: string[], quickNodeLimit: number, startFen: string): number;
  dispose(): void;
}

export interface BackgroundReviewDeps {
  ledger: Pick<PlayedGames, "pending" | "markCounted" | "recordFailure" | "refresh">;
  /** A pool of its own: the foreground review's pool is stopped by every new game, this one must not be. */
  createPool(onUpdate: (state: ReviewJobState) => void): BackgroundPool;
  /** Hand a finished review to the level estimate. Receives the game's own data, never the board's. */
  record(game: PlayedGame, points: ReviewJobState["points"]): void;
  /** Take a lock so only one tab reviews at a time: resolves to its release, or null when another tab holds it. A rejection means no lock support. */
  tryLock?(): Promise<(() => void) | null>;
  /** Something changed after the fact (a game finished or failed); the page should redraw. */
  onChange?(): void;
}

const LOCK_RETRY_MS = 1_500;

/**
 * Reviews the games in the ledger one at a time, only while `sync(true)` says nothing else needs the
 * machine. A stopped game stays pending; plies a multi-worker pool already finished are in the review
 * cache, so the next try picks up from there. It records the level and fills the cache, nothing else.
 */
export function createBackgroundReview(deps: BackgroundReviewDeps) {
  let running: { token: number; game: PlayedGame; pool: BackgroundPool | null; release: (() => void) | null } | null = null;
  let nextToken = 1;
  /** Games that already failed (or were cut short) in this page session: not retried until the next page load. */
  let tried = new Set<string>();
  let allowed = false;
  let acquiring = false;
  let finished = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;

  function stop(): void {
    if (!running) return;
    const { pool, release } = running;
    running = null;
    try { pool?.dispose(); } finally { release?.(); }
  }

  function fail(game: PlayedGame): void {
    tried.add(game.key);
    deps.ledger.recordFailure(game.key);
  }

  function handle(token: number, state: ReviewJobState): void {
    if (!running || running.token !== token || state.status === "running") return;
    const { game } = running;
    stop();
    tried.add(game.key);
    if (state.status === "complete" && state.points.length === game.moves.length) {
      finished += 1;
      deps.record(game, state.points);
      deps.ledger.markCounted(game.key);
    } else if (state.status !== "cancelled") {
      deps.ledger.recordFailure(game.key);
    }
    sync(allowed);
    deps.onChange?.();
  }

  function nextGame(): PlayedGame | undefined {
    deps.ledger.refresh();
    return deps.ledger.pending().find((game) => !game.assisted && !tried.has(game.key));
  }

  function sync(now: boolean): void {
    allowed = now;
    if (!now) { stop(); return; }
    if (running || acquiring) return;
    if (!deps.tryLock) {
      const next = nextGame();
      if (next) start(next, null);
      return;
    }
    if (!deps.ledger.pending().some((game) => !game.assisted && !tried.has(game.key))) return;
    acquiring = true;
    deps.tryLock().then((release) => release, () => () => {}).then((release) => {
      acquiring = false;
      if (release === null) {
        // another tab holds it, or this tab's own release has not landed yet: ask again shortly
        if (retry === null) retry = setTimeout(() => { retry = null; sync(allowed); }, LOCK_RETRY_MS);
        return;
      }
      const next = allowed && !running ? nextGame() : undefined;
      if (!next) { release(); return; }
      start(next, release);
      deps.onChange?.();
    });
  }

  function start(game: PlayedGame, release: (() => void) | null): void {
    const token = nextToken++;
    running = { token, game, pool: null, release };
    try {
      const pool = deps.createPool((state) => handle(token, state));
      running.pool = pool;
      pool.start([...game.moves], game.budget, game.startFen);
    } catch {
      stop();
      fail(game);
    }
  }

  return {
    /** Call whenever the page may have changed what is allowed; cheap and idempotent. */
    sync,
    /** The key of the game being reviewed now, or null. */
    activeKey: (): string | null => running?.game.key ?? null,
    /** For the page and its tests: idle, a game being reviewed, or at least one finished this session and nothing running. */
    state: (): "idle" | "running" | "done" => running ? "running" : finished > 0 ? "done" : "idle",
    /** Forget which games failed this session (tests; a page load does the same). */
    resetSession(): void { tried = new Set(); },
    dispose(): void {
      allowed = false;
      if (retry !== null) clearTimeout(retry);
      retry = null;
      stop();
    },
  };
}
export type BackgroundReview = ReturnType<typeof createBackgroundReview>;
