import type { ReviewExplanationLevel } from "./review-client";

export interface LevelWasm {
  level_view(state: string): string;
  level_observe(state: string, plies: string, provenance: string): string;
  level_set_manual(state: string, level: string): string;
  level_reestimate(): string;
  level_shows(level: string, classification: string): boolean;
}

export type SkillLevelName = "entry" | "beginner" | "intermediate" | "proficient" | "expert";
export const SKILL_LEVELS: readonly SkillLevelName[] = ["entry", "beginner", "intermediate", "proficient", "expert"];

export interface LevelState { autoScore: number | null; gameCount: number; manual: string | null }
export interface LevelView {
  state: LevelState;
  level: SkillLevelName;
  voice: ReviewExplanationLevel;
  displayed: boolean;
  manual: boolean;
  gameCount: number;
}
export type LevelProvenance = "own" | "assisted" | "imported";
export interface ScoredPlyInput { lossPercent: number; classification: string }

type StorageLike = Pick<Storage, "getItem" | "setItem">;
const STORAGE_KEY = "xq.userLevel.v1";
export const MAX_REMEMBERED_GAMES = 500;

interface Stored { estimate: LevelState; observed: string[] }

function isState(value: unknown): value is LevelState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Partial<LevelState>;
  return (state.autoScore === null || (typeof state.autoScore === "number" && Number.isFinite(state.autoScore)))
    && Number.isSafeInteger(state.gameCount) && (state.gameCount as number) >= 0
    && (state.manual === null || typeof state.manual === "string");
}

/** The level estimate the review page uses. All level maths lives in the wasm (xq-review). */
export function createUserLevel(wasm: LevelWasm, storage: StorageLike | null) {
  function fresh(): Stored {
    return { estimate: (JSON.parse(wasm.level_reestimate()) as LevelView).state, observed: [] };
  }
  function load(): Stored {
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      if (!raw) return fresh();
      const parsed = JSON.parse(raw) as Partial<Stored>;
      if (!isState(parsed.estimate) || !Array.isArray(parsed.observed) || !parsed.observed.every((key) => typeof key === "string")) return fresh();
      const checked = JSON.parse(wasm.level_view(JSON.stringify(parsed.estimate))) as { error?: string };
      return checked.error ? fresh() : { estimate: parsed.estimate, observed: parsed.observed };
    } catch {
      return fresh();
    }
  }
  let stored = load();
  function save(): void {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(stored)); } catch { /* storage is a convenience only */ }
  }
  function apply(json: string): LevelView {
    const next = JSON.parse(json) as LevelView & { error?: string };
    if (next.error) return view();
    stored = { ...stored, estimate: next.state };
    save();
    return next;
  }
  function view(): LevelView {
    return JSON.parse(wasm.level_view(JSON.stringify(stored.estimate))) as LevelView;
  }
  return {
    view,
    voice: (): ReviewExplanationLevel => view().voice,
    shows: (classification: string): boolean => wasm.level_shows(view().level, classification),
    /** Count a reviewed game once per key; only "own" games move the estimate. */
    observe(key: string, plies: ScoredPlyInput[], provenance: LevelProvenance): LevelView {
      if (stored.observed.includes(key)) return view();
      const result = apply(wasm.level_observe(JSON.stringify(stored.estimate), JSON.stringify(plies), provenance));
      stored.observed = [...stored.observed, key].slice(-MAX_REMEMBERED_GAMES);
      save();
      return result;
    },
    setManual: (level: SkillLevelName): LevelView => apply(wasm.level_set_manual(JSON.stringify(stored.estimate), level)),
    reestimate(): LevelView {
      stored = { ...stored, estimate: (JSON.parse(wasm.level_reestimate()) as LevelView).state };
      save();
      return view();
    },
  };
}

/** The reviewed plies of the user's own moves, in the shape the game score takes. */
export function userPliesForScore(
  points: Array<{ final: { lossPercent: number; classification: string } }>,
  history: Array<{ side: "red" | "black" }>,
  userSide: "red" | "black",
): ScoredPlyInput[] {
  return points
    .map((point, index) => ({ point, side: history[index]?.side }))
    .filter(({ side }) => side === userSide)
    .map(({ point }) => ({ lossPercent: point.final.lossPercent, classification: point.final.classification }));
}

export type UserLevel = ReturnType<typeof createUserLevel>;

/** Who moved each ply: the side to move in the start FEN moves first, and the sides alternate. */
export function sidesOfMoves(startFen: string, moves: readonly string[]): Array<"red" | "black"> {
  const first: "red" | "black" = startFen.trim().split(/\s+/)[1] === "b" ? "black" : "red";
  const other: "red" | "black" = first === "red" ? "black" : "red";
  return moves.map((_, index) => (index % 2 === 0 ? first : other));
}

export interface ReviewedGameContext {
  startFen: string;
  moves: readonly string[];
  userSide: "red" | "black";
  provenance: LevelProvenance;
}

/**
 * SPEC 8.5: a finished review of the user's own moves updates the level estimate once per game
 * (the key makes it idempotent). Everything comes from the caller, never from page state, so a
 * review that finishes after the board has moved on still lands on its own game.
 * Returns whether the game had any of the user's plies to score.
 */
export function recordReviewedGame(
  level: UserLevel | null,
  context: ReviewedGameContext,
  points: Array<{ final: { lossPercent: number; classification: string } }>,
): boolean {
  if (!level) return false;
  const history = sidesOfMoves(context.startFen, context.moves).map((side) => ({ side }));
  const plies = userPliesForScore(points, history, context.userSide);
  if (!plies.length) return false;
  level.observe(reviewedGameKey(context), plies, context.provenance);
  return true;
}

export function reviewedGameKey(context: { startFen: string; moves: readonly string[]; userSide: string }): string {
  return `${context.startFen}|${context.moves.join(" ")}|${context.userSide}`;
}
