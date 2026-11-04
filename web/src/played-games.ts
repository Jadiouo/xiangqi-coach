import { MAX_REMEMBERED_GAMES } from "./user-level";

/** pending: waiting for its background review; counted: reviewed and handed to the level estimate; skipped: no review will run. */
export type PlayedGameState = "pending" | "counted" | "skipped";

export interface PlayedGameInput {
  /** startFen|moves|side, the same key the level estimate uses to count a game once. */
  key: string;
  startFen: string;
  moves: string[];
  userSide: "red" | "black";
  /** The live win rate was on at some point: such a game is neither reviewed in the background nor counted. */
  assisted: boolean;
  /** The review budget (quick node limit) in force when the game ended; every retry uses it. */
  budget: number;
  finishedAt: number;
}
export interface PlayedGame extends PlayedGameInput { state: PlayedGameState; failures: number }

type StorageLike = Pick<Storage, "getItem" | "setItem">;
export const PLAYED_GAMES_STORAGE_KEY = "xq.played-games.v1";
const STORAGE_KEY = PLAYED_GAMES_STORAGE_KEY;
export const MAX_REVIEW_FAILURES = 3;

function isPlayedGame(value: unknown): value is PlayedGame {
  if (typeof value !== "object" || value === null) return false;
  const game = value as Partial<PlayedGame>;
  return typeof game.key === "string" && typeof game.startFen === "string"
    && Array.isArray(game.moves) && game.moves.every((move) => typeof move === "string")
    && (game.userSide === "red" || game.userSide === "black")
    && typeof game.assisted === "boolean"
    && Number.isSafeInteger(game.budget) && (game.budget as number) > 0
    && typeof game.finishedAt === "number" && Number.isFinite(game.finishedAt)
    && (game.state === "pending" || game.state === "counted" || game.state === "skipped")
    && Number.isSafeInteger(game.failures) && (game.failures as number) >= 0;
}

/** N and K of the settings line: games the user finished unaided, and games finished with the live win rate on. */
export function playedCounts(games: readonly PlayedGame[]): { played: number; assisted: number } {
  const assisted = games.filter((game) => game.assisted).length;
  return { played: games.length - assisted, assisted };
}

/** M of the settings line: unassisted games whose review reached the level estimate (never more than N). */
export function countedGames(games: readonly PlayedGame[]): number {
  return games.filter((game) => !game.assisted && game.state === "counted").length;
}

/** The games the user finished on this device. Its own `state` is the only record of what was reviewed. */
export function createPlayedGames(storage: StorageLike | null) {
  /** The stored games, or null when storage cannot be read at all (then memory is all there is). */
  function read(): PlayedGame[] | null {
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      if (storage === null) return null;
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.every(isPlayedGame) ? parsed.slice(-MAX_REMEMBERED_GAMES) : [];
    } catch {
      return null;
    }
  }
  let games: PlayedGame[] = read() ?? [];
  /** Another tab may have written since: take what is stored as the truth and keep only what exists here alone. */
  function refresh(): void {
    const stored = read();
    if (stored === null) return;
    const known = new Set(stored.map((game) => game.key));
    games = [...stored, ...games.filter((game) => !known.has(game.key))].slice(-MAX_REMEMBERED_GAMES);
  }
  function save(): void {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(games)); } catch { /* storage is a convenience only */ }
  }
  /** Read what is stored, change it, write it back: two tabs never overwrite each other's games. */
  function update(key: string, change: (game: PlayedGame) => PlayedGame): void {
    refresh();
    games = games.map((game) => game.key === key ? change(game) : game);
    save();
  }
  return {
    all: (): PlayedGame[] => games,
    refresh,
    /** False when the game is already in the ledger. */
    add(input: PlayedGameInput): boolean {
      refresh();
      if (games.some((game) => game.key === input.key)) return false;
      games = [...games, { ...input, moves: [...input.moves], state: (input.assisted ? "skipped" : "pending") as PlayedGameState, failures: 0 }]
        .slice(-MAX_REMEMBERED_GAMES);
      save();
      return true;
    },
    pending: (): PlayedGame[] => games.filter((game) => game.state === "pending"),
    has: (key: string): boolean => games.some((game) => game.key === key),
    markCounted(key: string): void {
      update(key, (game) => game.state === "pending" ? { ...game, state: "counted" } : game);
    },
    recordFailure(key: string): void {
      update(key, (game) => {
        if (game.state !== "pending") return game;
        const failures = game.failures + 1;
        return { ...game, failures, state: failures >= MAX_REVIEW_FAILURES ? "skipped" : "pending" };
      });
    },
  };
}
export type PlayedGames = ReturnType<typeof createPlayedGames>;
