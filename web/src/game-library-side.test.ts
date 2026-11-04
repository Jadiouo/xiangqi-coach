import { describe, expect, it } from "vitest";
import { buildArchive, mergeArchiveGames, parseArchive } from "./game-archive";
import { normalizeSavedGameRecord, savedGameUserSide, STANDARD_START_FEN, type SavedGame } from "./game-library";

const base = {
  id: "g", savedAt: 5, moves: ["h2e2", "h9g7"], startFen: STANDARD_START_FEN, source: "played" as const,
  importFormat: null, importMetadata: {}, importWarnings: [], variationTree: null,
};
const replay = async () => true;

describe("saved game keeps the side the user played", () => {
  it("round trips black through normalize, export and import", async () => {
    const black: SavedGame = { ...base, userSide: "black" };
    expect(normalizeSavedGameRecord(JSON.parse(JSON.stringify(black)))?.userSide).toBe("black");
    const archive = buildArchive([black], "2026-10-20");
    expect(archive.games[0]!.userSide).toBe("black");
    const parsed = await parseArchive(JSON.stringify(archive), replay);
    expect(parsed.games[0]!.userSide).toBe("black");
    expect(savedGameUserSide(parsed.games[0]!)).toBe("black");
  });

  it("reads a game saved before the field existed as red, without inventing the field", () => {
    const old = normalizeSavedGameRecord({ ...base });
    expect(old).not.toBeNull();
    expect(savedGameUserSide(old!)).toBe("red");
    expect(old!.userSide).toBeUndefined();
    const noRoot = normalizeSavedGameRecord({ id: "l", savedAt: 1, moves: ["h2e2"], variationTree: null });
    expect(savedGameUserSide(noRoot!)).toBe("red");
  });

  it("rejects an unknown side value instead of guessing", () => {
    expect(normalizeSavedGameRecord({ ...base, userSide: "green" })).toBeNull();
  });

  it("does not treat the same moves played from the other side as the same game when merging", () => {
    const red: SavedGame = { ...base, userSide: "red" };
    const black: SavedGame = { ...base, userSide: "black" };
    const merged = mergeArchiveGames([red], [black]);
    expect(merged.added).toBe(1);
    expect(merged.games).toHaveLength(2);
  });
});
