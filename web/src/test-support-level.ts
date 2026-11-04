import type { LevelWasm } from "./user-level";

/** A tiny stand-in that follows the wasm contract (the real one is covered by the xq-wasm tests). */
export function fakeLevelWasm(): LevelWasm {
  const view = (state: { autoScore: number | null; gameCount: number; manual: string | null }) => JSON.stringify({
    state,
    level: state.manual ?? (state.gameCount >= 3 ? "expert" : "beginner"),
    voice: (state.manual ?? (state.gameCount >= 3 ? "expert" : "beginner")) === "expert" ? "proficient" : "beginner",
    displayed: state.manual !== null || state.gameCount >= 3,
    manual: state.manual !== null,
    gameCount: state.gameCount,
  });
  return {
    level_view: (state) => view(JSON.parse(state)),
    level_observe: (state, _plies, provenance) => {
      const parsed = JSON.parse(state);
      if (provenance !== "own" || parsed.manual) return view(parsed);
      return view({ ...parsed, autoScore: 1, gameCount: parsed.gameCount + 1 });
    },
    level_set_manual: (state, level) => view({ ...JSON.parse(state), manual: level }),
    level_reestimate: () => view({ autoScore: null, gameCount: 0, manual: null }),
    level_shows: (level, classification) => level === "expert" || classification === "blunder",
  };
}

export function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => { data[key] = value; },
  };
}
