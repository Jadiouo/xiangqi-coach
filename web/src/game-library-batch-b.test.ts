import { describe, expect, it } from "vitest";
import { buildArchive, mergeArchiveGames, parseArchive } from "./game-archive";
import { normalizeSavedGameRecord, STANDARD_START_FEN, type SavedGame } from "./game-library";
import { GameLibrarySession } from "./game-library-session";

const base = {
  id: "g", savedAt: 5, moves: ["h2e2", "h9g7"], startFen: STANDARD_START_FEN, source: "played" as const,
  importFormat: null, importMetadata: {}, importWarnings: [], variationTree: null,
};
const replay = async () => true;

describe("saved game keeps difficulty and outcome", () => {
  it("round trips both through normalize, export and import", async () => {
    const game: SavedGame = { ...base, difficulty: 8, outcome: "red_win" };
    expect(normalizeSavedGameRecord(JSON.parse(JSON.stringify(game)))).toMatchObject({ difficulty: 8, outcome: "red_win" });
    const archive = buildArchive([game], "2026-10-24");
    expect(archive.games[0]).toMatchObject({ difficulty: 8, outcome: "red_win" });
    const parsed = await parseArchive(JSON.stringify(archive), replay);
    expect(parsed.games[0]).toMatchObject({ difficulty: 8, outcome: "red_win" });
    expect(archive.schemaVersion).toBe(1);
  });

  it("reads an older save without inventing either field", () => {
    const old = normalizeSavedGameRecord({ ...base });
    expect(old).not.toBeNull();
    expect("difficulty" in old!).toBe(false);
    expect("outcome" in old!).toBe(false);
  });

  it("rejects values that are not a level 1-10 or a known outcome", () => {
    for (const bad of [0, 11, 2.5, "5", null]) expect(normalizeSavedGameRecord({ ...base, difficulty: bad }), String(bad)).toBeNull();
    for (const bad of ["won", 1, null]) expect(normalizeSavedGameRecord({ ...base, outcome: bad }), String(bad)).toBeNull();
  });

  it("an old backup file without the fields still imports", async () => {
    const archive = { format: "xiangqi-coach-backup", schemaVersion: 1, exportedAt: "2026-10-01", games: [{ ...base }] };
    const parsed = await parseArchive(JSON.stringify(archive), replay);
    expect(parsed.games).toHaveLength(1);
  });

  it("an older backup of the same game (no difficulty or outcome) is not imported as a second copy", () => {
    const merged = mergeArchiveGames([{ ...base, difficulty: 3, outcome: "ongoing" }], [{ ...base }]);
    expect(merged.added).toBe(0);
    expect(merged.skipped).toBe(1);
    expect(merged.games).toHaveLength(1);
  });

  it("two saves that differ only in difficulty still count as the same game", () => {
    const merged = mergeArchiveGames([{ ...base, difficulty: 3 }], [{ ...base, difficulty: 9 }]);
    expect(merged.added).toBe(0);
  });
});

describe("library session binding survives a page reload", () => {
  it("hands out the bound id and can be restored for the same moves", () => {
    const session = new GameLibrarySession();
    session.open({ ...base, id: "A" });
    expect(session.boundRecordId()).toBe("A");

    const fresh = new GameLibrarySession();
    expect(fresh.boundRecordId()).toBeNull();
    fresh.restore("A", base.moves, STANDARD_START_FEN);
    expect(fresh.recordForMainline(base.moves)).toBe("A");
    // a move after the reload ends the binding, as it did before
    fresh.mainlineChanged([...base.moves, "b0c2"]);
    expect(fresh.recordForMainline([...base.moves, "b0c2"])).toBeNull();
  });
});
