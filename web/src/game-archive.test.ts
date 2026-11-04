import { describe, expect, it } from "vitest";
import { buildArchive, mergeArchiveGames, parseArchive, type GameArchive } from "./game-archive";
import { STANDARD_START_FEN, type SavedGame } from "./game-library";

const game = (id: string, red: string): SavedGame => ({
  id, savedAt: 10, moves: ["h2e2"], startFen: STANDARD_START_FEN, source: "imported", importFormat: "pgn",
  importMetadata: { Red: red, Black: "乙" }, importWarnings: [], variationTree: null,
});
const replay = async (_fen: string, moves: string[]) => moves.every((move) => /^[a-i][0-9][a-i][0-9]$/.test(move));

describe("versioned game archive", () => {
  it("round trips the archive envelope and caller supplied export date", async () => {
    const archive = buildArchive([game("a", "甲")], "2026-10-09");
    await expect(parseArchive(JSON.stringify(archive), replay)).resolves.toEqual(archive);
  });

  it("rejects unsupported versions and invalid later records as a whole", async () => {
    const archive = buildArchive([game("a", "甲"), game("b", "乙")], "2026-10-09");
    const unsupported = { ...archive, schemaVersion: 999 };
    await expect(parseArchive(JSON.stringify(unsupported), replay)).rejects.toThrow(/版本/);
    const invalid = structuredClone(archive) as GameArchive;
    invalid.games[1]!.moves = ["bad!"];
    await expect(parseArchive(JSON.stringify(invalid), replay)).rejects.toThrow(/第 2 局/);
  });

  it("keeps same id and same content, and deterministically preserves conflicting content", () => {
    const existing = [game("same", "原紀錄")];
    const imported = [game("same", "原紀錄"), game("same", "新紀錄")];
    const first = mergeArchiveGames(existing, imported);
    const second = mergeArchiveGames(first.games, imported);
    expect(first.games).toHaveLength(2);
    expect(second.games).toHaveLength(2);
    expect(first.games.find((row) => row.importMetadata.Red === "新紀錄")?.id)
      .toBe(second.games.find((row) => row.importMetadata.Red === "新紀錄")?.id);
    expect(first.skipped).toBe(1);
  });
});
