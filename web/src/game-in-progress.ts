import type { UserSide } from "./my-side";

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem">;
type RemoveStorage = Pick<Storage, "removeItem">;

/** What the play page needs to come back to the same game after a refresh. */
export interface GameInProgress {
  startFen: string;
  /** Every move of the main line, in ICCS. */
  moves: string[];
  /** The side the user plays in this game (not the "next game" setting). */
  userSide: UserSide;
  /** The level the computer was last asked to play at, 1-10. */
  difficulty: number;
  source: "played" | "imported";
  importFormat: string | null;
  importMetadata: Record<string, string>;
  importWarnings: string[];
  /** Live evaluation was on at some point, so the game counts as assisted. */
  assisted: boolean;
  /** The library entry this exact game was saved as, so saving again updates it instead of adding a copy. */
  libraryRecordId: string | null;
}

const STORAGE_KEY = "xq.game-in-progress.v1";
const VERSION = 1;

/** The stored game, or null for nothing stored, another version, unreadable text or a record of the wrong shape. */
export function loadGameInProgress(storage: ReadStorage | null): GameInProgress | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== VERSION) return null;
    return validate((parsed as { game?: unknown }).game);
  } catch {
    return null;
  }
}

/** Storage is a convenience: a refused write only costs the next refresh. */
export function saveGameInProgress(storage: WriteStorage | null, game: GameInProgress): void {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, game })); } catch { /* keep playing */ }
}

export function clearGameInProgress(storage: RemoveStorage | null): void {
  try { storage?.removeItem(STORAGE_KEY); } catch { /* keep playing */ }
}

function validate(value: unknown): GameInProgress | null {
  if (typeof value !== "object" || value === null) return null;
  const game = value as Partial<GameInProgress>;
  if (typeof game.startFen !== "string" || !game.startFen.trim()) return null;
  if (!Array.isArray(game.moves) || !game.moves.every((move) => typeof move === "string" && /^[a-i][0-9][a-i][0-9]$/.test(move))) return null;
  if (game.userSide !== "red" && game.userSide !== "black") return null;
  if (!Number.isInteger(game.difficulty) || game.difficulty! < 1 || game.difficulty! > 10) return null;
  if (game.source !== "played" && game.source !== "imported") return null;
  if (game.importFormat !== null && typeof game.importFormat !== "string") return null;
  const metadata = game.importMetadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)
    || !Object.values(metadata).every((entry) => typeof entry === "string")) return null;
  if (!Array.isArray(game.importWarnings) || !game.importWarnings.every((warning) => typeof warning === "string")) return null;
  if (typeof game.assisted !== "boolean") return null;
  if (game.libraryRecordId !== null && typeof game.libraryRecordId !== "string") return null;
  return {
    startFen: game.startFen, moves: [...game.moves], userSide: game.userSide, difficulty: game.difficulty!,
    source: game.source, importFormat: game.importFormat, importMetadata: { ...metadata },
    importWarnings: [...game.importWarnings], assisted: game.assisted, libraryRecordId: game.libraryRecordId,
  };
}
