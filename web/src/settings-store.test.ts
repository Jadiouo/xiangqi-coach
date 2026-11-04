import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, REVIEW_BUDGETS, createSettingsStore, loadSettings } from "./settings-store";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

const KEY = "xq.settings.v1";

describe("settings store", () => {
  it("uses the defaults when nothing is stored, storage is missing, or storage throws on read", () => {
    expect(loadSettings(memoryStorage())).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(loadSettings(broken)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.reviewBudget).toBe(REVIEW_BUDGETS[0]);
  });

  it("fills a missing field with its default and keeps the fields that are present", () => {
    expect(loadSettings(memoryStorage({ [KEY]: JSON.stringify({ version: 1 }) }))).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(memoryStorage({ [KEY]: JSON.stringify({ version: 1, reviewBudget: 1_000_000 }) })).reviewBudget).toBe(1_000_000);
  });

  it("falls back to the default for a field whose value is not one of the allowed budgets", () => {
    expect(loadSettings(memoryStorage({ [KEY]: JSON.stringify({ version: 1, reviewBudget: 123 }) }))).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(memoryStorage({ [KEY]: JSON.stringify({ version: 1, reviewBudget: "5000000" }) }))).toEqual(DEFAULT_SETTINGS);
  });

  it("drops a stored object of another version and unreadable text", () => {
    expect(loadSettings(memoryStorage({ [KEY]: JSON.stringify({ version: 2, reviewBudget: 5_000_000 }) }))).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(memoryStorage({ [KEY]: JSON.stringify({ reviewBudget: 5_000_000 }) }))).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(memoryStorage({ [KEY]: "{not json" }))).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(memoryStorage({ [KEY]: "null" }))).toEqual(DEFAULT_SETTINGS);
  });

  it("writes a versioned object and a second store reads it back", () => {
    const storage = memoryStorage();
    const store = createSettingsStore(storage);
    store.set({ reviewBudget: 5_000_000 });
    expect(JSON.parse(storage.data.get(KEY)!)).toEqual({ version: 1, reviewBudget: 5_000_000 });
    expect(createSettingsStore(storage).get().reviewBudget).toBe(5_000_000);
  });

  it("still serves the new value in this session when storage refuses the write", () => {
    const broken = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    const store = createSettingsStore(broken);
    expect(() => store.set({ reviewBudget: 1_000_000 })).not.toThrow();
    expect(store.get().reviewBudget).toBe(1_000_000);
    expect(createSettingsStore(broken).get()).toEqual(DEFAULT_SETTINGS);
  });
});
