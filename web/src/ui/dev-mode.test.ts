import { describe, expect, it } from "vitest";
import { loadDevMode, saveDevMode } from "./dev-mode";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

describe("developer mode flag", () => {
  it("is off by default", () => {
    expect(loadDevMode(memoryStorage())).toBe(false);
    expect(loadDevMode(null)).toBe(false);
  });

  it("reads back what was written", () => {
    const storage = memoryStorage();
    saveDevMode(storage, true);
    expect(loadDevMode(storage)).toBe(true);
    saveDevMode(storage, false);
    expect(loadDevMode(storage)).toBe(false);
  });

  it("falls back to off when storage throws", () => {
    const broken = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(loadDevMode(broken)).toBe(false);
    expect(() => saveDevMode(broken, true)).not.toThrow();
  });

  it("treats unreadable stored values as off", () => {
    expect(loadDevMode(memoryStorage({ "xq.devmode.v1": "banana" }))).toBe(false);
  });
});
