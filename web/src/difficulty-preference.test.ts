import { describe, expect, it } from "vitest";
import { DEFAULT_DIFFICULTY, loadDifficulty, saveDifficulty } from "./difficulty-preference";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    data,
  };
}

describe("difficulty preference", () => {
  it("defaults to 5", () => {
    expect(DEFAULT_DIFFICULTY).toBe(5);
    expect(loadDifficulty(memoryStorage())).toBe(5);
    expect(loadDifficulty(null)).toBe(5);
  });

  it("remembers a saved level", () => {
    const storage = memoryStorage();
    saveDifficulty(storage, 8);
    expect(loadDifficulty(storage)).toBe(8);
  });

  it("falls back to 5 for anything that is not an integer from 1 to 10", () => {
    for (const bad of ["0", "11", "abc", "", "5.5", "-3", "NaN"]) {
      expect(loadDifficulty(memoryStorage({ "xq.difficulty.v1": bad }))).toBe(5);
    }
  });

  it("never throws when storage throws", () => {
    const broken = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("quota"); },
    };
    expect(loadDifficulty(broken)).toBe(5);
    expect(() => saveDifficulty(broken, 7)).not.toThrow();
  });
});
