import { describe, expect, it } from "vitest";
import { clearGameInProgress, loadGameInProgress, saveGameInProgress, type GameInProgress } from "./game-in-progress";
import { STANDARD_START_FEN } from "./game-library";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

const sample: GameInProgress = {
  startFen: STANDARD_START_FEN,
  moves: ["h2e2", "h9g7"],
  userSide: "black",
  difficulty: 3,
  source: "played",
  importFormat: null,
  importMetadata: {},
  importWarnings: [],
  assisted: false,
  libraryRecordId: "abc",
};

describe("game in progress storage", () => {
  it("round trips everything the game needs to continue", () => {
    const storage = memoryStorage();
    saveGameInProgress(storage, sample);
    expect(loadGameInProgress(storage)).toEqual(sample);
  });

  it("keeps imported-game details", () => {
    const storage = memoryStorage();
    const imported: GameInProgress = { ...sample, source: "imported", importFormat: "pgn", importMetadata: { Event: "x" }, importWarnings: ["w"], libraryRecordId: null };
    saveGameInProgress(storage, imported);
    expect(loadGameInProgress(storage)).toEqual(imported);
  });

  it("returns null when nothing is stored", () => {
    expect(loadGameInProgress(memoryStorage())).toBeNull();
    expect(loadGameInProgress(null)).toBeNull();
  });

  it("returns null for text that is not JSON, another version, or the wrong shape", () => {
    const key = "xq.game-in-progress.v1";
    for (const raw of ["not json", "[]", "null", JSON.stringify({ version: 2, game: sample }), JSON.stringify({ version: 1 }),
      JSON.stringify({ version: 1, game: { ...sample, moves: ["zz99"] } }),
      JSON.stringify({ version: 1, game: { ...sample, userSide: "green" } }),
      JSON.stringify({ version: 1, game: { ...sample, difficulty: 11 } }),
      JSON.stringify({ version: 1, game: { ...sample, difficulty: 2.5 } }),
      JSON.stringify({ version: 1, game: { ...sample, startFen: "" } }),
      JSON.stringify({ version: 1, game: { ...sample, source: "other" } })]) {
      expect(loadGameInProgress(memoryStorage({ [key]: raw })), raw).toBeNull();
    }
  });

  it("never throws when the browser refuses storage", () => {
    const refusing = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
    };
    expect(loadGameInProgress(refusing)).toBeNull();
    expect(() => saveGameInProgress(refusing, sample)).not.toThrow();
    expect(() => clearGameInProgress(refusing)).not.toThrow();
    expect(() => saveGameInProgress(null, sample)).not.toThrow();
    expect(() => clearGameInProgress(null)).not.toThrow();
  });

  it("clear removes the stored game", () => {
    const storage = memoryStorage();
    saveGameInProgress(storage, sample);
    clearGameInProgress(storage);
    expect(loadGameInProgress(storage)).toBeNull();
  });
});
