import { describe, expect, it } from "vitest";
import { createUserLevel, userPliesForScore, type LevelWasm } from "./user-level";

// A tiny stand-in that follows the wasm contract (the real one is covered by the xq-wasm tests).
function fakeWasm(): LevelWasm {
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

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => { data[key] = value; },
  };
}

describe("user level in the review page", () => {
  it("starts uncalibrated with the beginner voice and shows no level", () => {
    const level = createUserLevel(fakeWasm(), memoryStorage());
    expect(level.view().displayed).toBe(false);
    expect(level.voice()).toBe("beginner");
  });

  it("counts each reviewed own game once and calibrates on the third", () => {
    const storage = memoryStorage();
    const level = createUserLevel(fakeWasm(), storage);
    const plies = [{ lossPercent: 1, classification: "good" }];
    level.observe("game-a", plies, "own");
    level.observe("game-a", plies, "own");
    expect(level.view().gameCount).toBe(1);
    level.observe("game-b", plies, "own");
    level.observe("game-c", plies, "own");
    expect(level.view().displayed).toBe(true);
    expect(level.voice()).toBe("proficient");
    // A reload sees the same estimate and still remembers which games were counted.
    const reloaded = createUserLevel(fakeWasm(), storage);
    expect(reloaded.view().gameCount).toBe(3);
    reloaded.observe("game-c", plies, "own");
    expect(reloaded.view().gameCount).toBe(3);
  });

  it("does not count imported games, and a manual level survives new reviews and reloads", () => {
    const storage = memoryStorage();
    const level = createUserLevel(fakeWasm(), storage);
    level.observe("imported-1", [{ lossPercent: 1, classification: "good" }], "imported");
    expect(level.view().gameCount).toBe(0);
    level.setManual("intermediate");
    level.observe("game-x", [{ lossPercent: 1, classification: "good" }], "own");
    expect(level.view().level).toBe("intermediate");
    expect(createUserLevel(fakeWasm(), storage).view().level).toBe("intermediate");
    level.reestimate();
    expect(level.view().manual).toBe(false);
    expect(level.view().gameCount).toBe(0);
  });

  it("survives unusable storage and garbage in storage", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const level = createUserLevel(fakeWasm(), broken);
    expect(() => level.observe("g", [{ lossPercent: 1, classification: "good" }], "own")).not.toThrow();
    expect(level.view().gameCount).toBe(1);
    const garbage = createUserLevel(fakeWasm(), memoryStorage({ "xq.userLevel.v1": "{not json" }));
    expect(garbage.view().gameCount).toBe(0);
    const badShape = createUserLevel(fakeWasm(), memoryStorage({ "xq.userLevel.v1": JSON.stringify({ estimate: { gameCount: "x" }, observed: 5 }) }));
    expect(badShape.view().gameCount).toBe(0);
  });

  it("filters markers through the level policy", () => {
    const level = createUserLevel(fakeWasm(), memoryStorage());
    expect(level.shows("blunder")).toBe(true);
    expect(level.shows("inaccuracy")).toBe(false);
  });

  it("scores only the plies the user played", () => {
    const point = (loss: number, classification: string) => ({ final: { lossPercent: loss, classification } });
    const history = [{ side: "red" as const }, { side: "black" as const }, { side: "red" as const }];
    const points = [point(1, "good"), point(40, "blunder"), point(3, "inaccuracy")];
    expect(userPliesForScore(points, history, "red")).toEqual([
      { lossPercent: 1, classification: "good" },
      { lossPercent: 3, classification: "inaccuracy" },
    ]);
    expect(userPliesForScore(points, history, "black")).toEqual([{ lossPercent: 40, classification: "blunder" }]);
  });
});
