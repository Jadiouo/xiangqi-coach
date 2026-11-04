import type { SerializedReviewVariationTree } from "./review-variation-tree";
import type { ReviewJobState } from "./review-client";
import { REVIEW_REASON_KINDS } from "./review-client";

export interface SavedReviewSnapshot {
  startFen: string;
  moves: string[];
  points: ReviewJobState["points"];
  boards: string[];
  analyzer: { name: string; quickNodeLimit: number; deepNodeLimit: number; config: string };
  result: "red_win" | "black_win" | "draw" | "unknown";
  reportDate: string;
}
export interface SavedReviewNote { reportDate: string; markdown: string; plainText: string; curveSvg: string }

export type SavedGameOutcome = "ongoing" | "red_win" | "black_win" | "draw";

export interface SavedGame {
  id: string;
  savedAt: number;
  moves: string[];
  startFen: string;
  source: "played" | "imported";
  importFormat: string | null;
  importMetadata: Record<string, string>;
  importWarnings: string[];
  variationTree: SerializedReviewVariationTree | null;
  /** The side the user played. Games saved before this field existed have none and count as red. */
  userSide?: "red" | "black";
  /** The computer level (1-10) the game was last played at; absent in saves from before the field existed and in imported games. */
  difficulty?: number;
  /** How the game stood when it was saved; absent in older saves (a reviewed one still has its snapshot result). */
  outcome?: SavedGameOutcome;
  reviewSnapshot?: SavedReviewSnapshot | null;
  reviewNote?: SavedReviewNote | null;
}

/** The side the user played in a saved game; records from before the field existed were all played as red. */
export function savedGameUserSide(game: Pick<SavedGame, "userSide">): "red" | "black" {
  return game.userSide === "black" ? "black" : "red";
}

export const STANDARD_START_FEN = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";

const databaseName = "xiangqi-coach-local";
const databaseVersion = 1;
const storeName = "games";
const legacyStorageKey = "xiangqi.game-library.v1";
let databasePromise: Promise<IDBDatabase> | null = null;

/**
 * Review data may be attached to a saved game only as a pair that belongs to its root and moves.
 * A note without a matching snapshot would be dropped by normalizeSavedGameRecord on the next read,
 * so it is refused here, and the caller is told so it can say it on screen.
 */
export function reviewFieldsForSave(
  snapshot: SavedReviewSnapshot | null, note: SavedReviewNote | null, startFen: string, moves: string[],
): { reviewSnapshot: SavedReviewSnapshot | null; reviewNote: SavedReviewNote | null; droppedNote: boolean } {
  const matches = snapshot !== null && snapshot.startFen === startFen && snapshot.moves.join(" ") === moves.join(" ");
  return { reviewSnapshot: matches ? snapshot : null, reviewNote: matches ? note : null, droppedNote: !matches && note !== null };
}

export async function listSavedGames(): Promise<SavedGame[]> {
  const database = await openDatabase();
  await migrateLegacyGames(database);
  const transaction = database.transaction(storeName, "readonly");
  const request = transaction.objectStore(storeName).getAll() as IDBRequest<SavedGame[]>;
  const records = await requestAfterTransaction(transaction, request);
  return records
    .map(normalizeSavedGameRecord)
    .filter((game): game is SavedGame => game !== null)
    .sort((left, right) => right.savedAt - left.savedAt);
}

async function migrateLegacyGames(database: IDBDatabase): Promise<void> {
  const storage = globalThis.localStorage;
  const serialized = storage?.getItem(legacyStorageKey);
  if (!serialized) return;

  let legacyRecords: LegacySavedGame[];
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return;
    legacyRecords = parsed.filter(isLegacySavedGame);
  } catch {
    return;
  }
  if (legacyRecords.length === 0) return;

  const transaction = database.transaction(storeName, "readwrite");
  const store = transaction.objectStore(storeName);
  const request = store.getAll() as IDBRequest<SavedGame[]>;
  const completed = transactionComplete(transaction);
  request.onsuccess = () => {
    const existingIds = new Set((request.result ?? []).map((game) => game.id));
    for (const legacy of legacyRecords) {
      if (!existingIds.has(legacy.id)) store.put({
        ...legacy,
        startFen: STANDARD_START_FEN,
        source: "played",
        importFormat: null,
        importMetadata: {},
        importWarnings: [],
        variationTree: null,
      } satisfies SavedGame);
    }
  };
  request.onerror = () => transaction.abort();
  await completed;
  storage.removeItem(legacyStorageKey);
}

interface LegacySavedGame {
  id: string;
  savedAt: number;
  moves: string[];
}

function isLegacySavedGame(value: unknown): value is LegacySavedGame {
  if (typeof value !== "object" || value === null) return false;
  const game = value as Partial<LegacySavedGame>;
  return typeof game.id === "string"
    && typeof game.savedAt === "number"
    && Array.isArray(game.moves)
    && game.moves.every((move) => typeof move === "string" && /^[a-i][0-9][a-i][0-9]$/.test(move));
}

export async function storeSavedGame(game: SavedGame): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(game);
  await transactionComplete(transaction);
}

export async function deleteSavedGame(id: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).delete(id);
  await transactionComplete(transaction);
}

export async function importSavedGamesAtomically(
  imported: SavedGame[],
  merge: (existing: SavedGame[], incoming: SavedGame[]) => { games: SavedGame[]; skipped: number; added: number },
): Promise<{ skipped: number; added: number }> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  const store = transaction.objectStore(storeName);
  const request = store.getAll() as IDBRequest<SavedGame[]>;
  const completed = transactionComplete(transaction);
  let summary = { skipped: 0, added: 0 };
  request.onsuccess = () => {
    try {
      const current = (request.result ?? []).map(normalizeSavedGameRecord).filter((game): game is SavedGame => game !== null);
      const merged = merge(current, imported);
      const priorIds = new Set(current.map((game) => game.id));
      for (const game of merged.games) if (!priorIds.has(game.id)) store.add(game);
      summary = { skipped: merged.skipped, added: merged.added };
    } catch {
      transaction.abort();
    }
  };
  request.onerror = () => transaction.abort();
  await completed;
  return summary;
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  const pendingDatabase = new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = globalThis.indexedDB.open(databaseName, databaseVersion);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName, { keyPath: "id" });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  }).catch((error: unknown) => {
    databasePromise = null;
    throw error;
  });
  databasePromise = pendingDatabase;
  return pendingDatabase;
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function requestAfterTransaction<T>(transaction: IDBTransaction, request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

export function normalizeSavedGameRecord(value: unknown): SavedGame | null {
  if (typeof value !== "object" || value === null) return null;
  const game = value as Partial<SavedGame>;
  const hasStartFen = Object.prototype.hasOwnProperty.call(value, "startFen");
  if (!(typeof game.id === "string"
    && typeof game.savedAt === "number"
    && Array.isArray(game.moves)
    && game.moves.every((move) => typeof move === "string" && /^[a-i][0-9][a-i][0-9]$/.test(move))
    && (game.variationTree === null || (typeof game.variationTree === "object" && game.variationTree !== null)))) return null;
  if (hasStartFen && (typeof game.startFen !== "string" || !game.startFen.trim())) return null;
  if (game.source !== undefined && game.source !== "played" && game.source !== "imported") return null;
  if (game.userSide !== undefined && game.userSide !== "red" && game.userSide !== "black") return null;
  if (game.difficulty !== undefined && !(Number.isInteger(game.difficulty) && game.difficulty >= 1 && game.difficulty <= 10)) return null;
  if (game.outcome !== undefined && !["ongoing", "red_win", "black_win", "draw"].includes(game.outcome as string)) return null;
  if (game.importFormat !== undefined && game.importFormat !== null && typeof game.importFormat !== "string") return null;
  if (game.importMetadata !== undefined && !isMetadata(game.importMetadata)) return null;
  if (game.importWarnings !== undefined && (!Array.isArray(game.importWarnings)
    || !game.importWarnings.every((warning) => typeof warning === "string"))) return null;
  const startFen = hasStartFen ? game.startFen! : STANDARD_START_FEN;
  const reviewSnapshot = normalizeReviewSnapshot(game.reviewSnapshot, startFen, game.moves);
  const reviewNote = normalizeReviewNote(game.reviewNote, reviewSnapshot?.reportDate ?? null);
  return {
    id: game.id,
    savedAt: game.savedAt,
    moves: [...game.moves],
    startFen,
    source: game.source ?? "played",
    importFormat: game.importFormat ?? null,
    importMetadata: game.importMetadata ?? {},
    importWarnings: game.importWarnings ?? [],
    variationTree: game.variationTree ?? null,
    ...(game.userSide !== undefined ? { userSide: game.userSide } : {}),
    ...(game.difficulty !== undefined ? { difficulty: game.difficulty } : {}),
    ...(game.outcome !== undefined ? { outcome: game.outcome } : {}),
    reviewSnapshot,
    reviewNote,
  };
}

function normalizeReviewSnapshot(value: unknown, rootFen: string, rootMoves: string[]): SavedReviewSnapshot | null {
  if (value === undefined || value === null || typeof value !== "object") return null;
  const snapshot = value as Partial<SavedReviewSnapshot>;
  if (snapshot.startFen !== rootFen || !sameMoves(snapshot.moves, rootMoves) || !Array.isArray(snapshot.moves)
    || !Array.isArray(snapshot.points) || snapshot.points.length !== rootMoves.length
    || !snapshot.points.every((point, index) => isReviewPoint(point, rootMoves[index]!))
    || !Array.isArray(snapshot.boards) || snapshot.boards.length !== rootMoves.length + 1
    || !snapshot.boards.every((board) => typeof board === "string" && board.length === 90 && /^[prnbakcPRNBAKC.]{90}$/.test(board))
    || !snapshot.analyzer || typeof snapshot.analyzer.name !== "string" || !snapshot.analyzer.name.trim()
    || !positiveInteger(snapshot.analyzer.quickNodeLimit) || !positiveInteger(snapshot.analyzer.deepNodeLimit)
    || typeof snapshot.analyzer.config !== "string" || !snapshot.analyzer.config.trim()
    || !isReportDate(snapshot.reportDate) || !["red_win", "black_win", "draw", "unknown"].includes(snapshot.result ?? "")) return null;
  return snapshot as SavedReviewSnapshot;
}

function normalizeReviewNote(value: unknown, expectedDate: string | null): SavedReviewNote | null {
  if (value === undefined || value === null || typeof value !== "object" || !expectedDate) return null;
  const note = value as Partial<SavedReviewNote>;
  if (note.reportDate !== expectedDate || typeof note.markdown !== "string" || typeof note.plainText !== "string"
    || typeof note.curveSvg !== "string" || !note.curveSvg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')
    || !note.curveSvg.endsWith("</svg>") || /<\/?script\b|\son[a-z]+\s*=|<foreignObject\b|<!DOCTYPE/i.test(note.curveSvg)
    || /<\/?script\s*>/i.test(note.markdown)) return null;
  if (typeof DOMParser !== "undefined") {
    const document = new DOMParser().parseFromString(note.curveSvg, "image/svg+xml");
    if (document.documentElement.localName !== "svg" || document.getElementsByTagName("parsererror").length) return null;
  }
  return note as SavedReviewNote;
}

export function isReviewPoint(value: unknown, expectedMove: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const point = value as Partial<ReviewJobStatePoint>;
  return typeof point.deepened === "boolean" && typeof point.continuationComplete === "boolean"
    && isReviewResult(point.quick, expectedMove) && isReviewResult(point.final, expectedMove);
}

type ReviewJobStatePoint = SavedReviewSnapshot["points"][number];
function isReviewResult(value: unknown, expectedMove: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<ReviewJobStatePoint["final"]>;
  return isIccs(result.bestMove) && result.playedMove === expectedMove
    && (result.playedRank === null || positiveInteger(result.playedRank))
    && isScore(result.bestScore) && isScore(result.playedScore)
    && finiteRange(result.bestWinProbability, 0, 1) && finiteRange(result.playedWinProbability, 0, 1)
    && finiteRange(result.lossPercent, 0, 100)
    && ["unclassified", "good", "unique_move", "inaccuracy", "doubtful_move", "mistake", "blunder", "missed_mate"].includes(result.classification ?? "")
    && (result.reason === undefined || result.reason === null || isReviewReason(result.reason))
    && (result.comparison === undefined || result.comparison === null || isReviewComparison(result.comparison))
    && Array.isArray(result.candidates) && result.candidates.every(isCandidate);
}

const PIECE_KINDS = ["king", "advisor", "elephant", "horse", "rook", "cannon", "pawn"];
function isSquare(value: unknown): value is string { return typeof value === "string" && /^[a-i][0-9]$/.test(value); }
function isSide(value: unknown): boolean { return value === "red" || value === "black"; }
function isPiece(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const piece = value as { side?: unknown; kind?: unknown };
  return isSide(piece.side) && PIECE_KINDS.includes(piece.kind as string);
}
function isFiniteInteger(value: unknown): value is number { return Number.isSafeInteger(value); }

function isLineStep(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const step = value as Record<string, unknown>;
  return isIccs(step.iccs) && typeof step.notation === "string" && step.notation.length > 0
    && isSide(step.side) && (step.captured === null || step.captured === undefined || isPiece(step.captured));
}

/** Runtime check of a stored move comparison (absent or null is accepted by the caller). */
function isReviewComparison(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return Array.isArray(c.playedLine) && c.playedLine.every(isLineStep)
    && Array.isArray(c.bestLine) && c.bestLine.every(isLineStep)
    && typeof c.playedComplete === "boolean" && typeof c.bestComplete === "boolean"
    && (c.playedSettled === undefined || typeof c.playedSettled === "boolean")
    && (c.bestSettled === undefined || typeof c.bestSettled === "boolean");
}

/** Runtime check of a stored engine reason: known kind plus the evidence that kind needs. */
function isReviewReason(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const reason = value as Record<string, any>;
  if (!(REVIEW_REASON_KINDS as readonly string[]).includes(reason.kind)) return false;
  switch (reason.kind) {
    case "walked_into_mate":
    case "missed_mate":
      return positiveInteger(reason.moves);
    case "dropped_material":
    case "missed_material": {
      const material = reason.material;
      return nonNegativeInteger(reason.moves) && typeof material === "object" && material !== null
        && isSide(material.mover) && isFiniteInteger(material.bestNet) && isFiniteInteger(material.playedNet)
        && (material.settled === undefined || typeof material.settled === "boolean")
        && Array.isArray(material.bestCaptures) && Array.isArray(material.playedCaptures);
    }
    case "sent_piece":
    case "abandoned_protection": {
      const e = reason.protection;
      return typeof e === "object" && e !== null && isPiece(e.piece) && isSquare(e.from) && isSquare(e.to)
        && isSquare(e.capturedAt) && isSide(e.capturer) && isPiece(e.attacker) && isFiniteInteger(e.net)
        && (e.protectedPiece === null || e.protectedPiece === undefined || isPiece(e.protectedPiece))
        && (e.protectedSquare === null || e.protectedSquare === undefined || isSquare(e.protectedSquare));
    }
    case "cannon_mount": {
      const e = reason.cannonMount;
      return typeof e === "object" && e !== null && isPiece(e.screen) && isSquare(e.screenSquare)
        && isPiece(e.cannon) && isSquare(e.cannonFrom) && isPiece(e.victim) && isSquare(e.victimSquare)
        && isFiniteInteger(e.net);
    }
    case "check_capture": {
      const e = reason.checkCapture;
      return typeof e === "object" && e !== null && isPiece(e.victim) && isSquare(e.victimSquare)
        && isPiece(e.attacker) && isSquare(e.attackerFrom) && isFiniteInteger(e.net);
    }
    default: {
      const e = reason.position;
      return typeof e === "object" && e !== null
        && ["material", "position", "mobility", "king_safety"].includes(e.component)
        && isFiniteInteger(e.playedValue) && isFiniteInteger(e.bestValue)
        && nonNegativeInteger(e.mobilityBefore) && nonNegativeInteger(e.mobilityAfter)
        && (e.mobilityAfterBest === undefined || nonNegativeInteger(e.mobilityAfterBest));
    }
  }
}

function isCandidate(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as SavedReviewSnapshot["points"][number]["final"]["candidates"][number];
  return isIccs(candidate.move) && isScore(candidate.score) && Array.isArray(candidate.pv) && candidate.pv.every(isIccs)
    && nonNegativeInteger(candidate.depth) && nonNegativeInteger(candidate.nodes)
    && ["terminal", "depth_limit", "transposition_cutoff", "forced_move", "no_completed_iteration"].includes(candidate.pvEnd)
    && Array.isArray(candidate.continuation) && candidate.continuation.every((segment) => isIccs(segment.move)
      && nonNegativeInteger(segment.depth) && nonNegativeInteger(segment.nodes)
      && ["terminal", "depth_limit", "transposition_cutoff", "forced_move", "no_completed_iteration"].includes(segment.pvEnd))
    && positiveInteger(candidate.continuationNodeLimit) && typeof candidate.continuationTerminal === "boolean"
    && typeof candidate.replayAudit === "object" && candidate.replayAudit !== null
    && ["pending", "terminal", "invalid_pv", "invalid_continuation", "no_result", "cancelled", "minimum_reached", "complete", "search_truncated"].includes(candidate.continuationStatus);
}

function isScore(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const score = value as { centipawns?: unknown; mateIn?: unknown };
  return typeof score.centipawns === "number" && Number.isFinite(score.centipawns)
    && (score.mateIn === null || (typeof score.mateIn === "number" && Number.isInteger(score.mateIn)));
}

function isIccs(value: unknown): value is string { return typeof value === "string" && /^[a-i][0-9][a-i][0-9]$/.test(value); }
function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function nonNegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function finiteRange(value: unknown, min: number, max: number): value is number { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max; }
function isReportDate(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value); }
function sameMoves(value: unknown, moves: string[]): value is string[] {
  return Array.isArray(value) && value.length === moves.length && value.every((move, index) => move === moves[index]);
}

export async function updateSavedGame(id: string, update: (game: SavedGame) => SavedGame): Promise<SavedGame | null> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  const store = transaction.objectStore(storeName);
  const request = store.get(id) as IDBRequest<SavedGame | undefined>;
  let updated: SavedGame | null = null;
  request.onsuccess = () => {
    const current = request.result ? normalizeSavedGameRecord(request.result) : null;
    if (!current) return;
    updated = update(current);
    store.put(updated);
  };
  await transactionComplete(transaction);
  return updated;
}

function isMetadata(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === "string");
}
