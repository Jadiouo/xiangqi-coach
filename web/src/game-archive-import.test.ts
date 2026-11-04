import { beforeEach, describe, expect, it } from "vitest";
import { buildArchive, mergeArchiveGames, parseArchive } from "./game-archive";
import { importSavedGamesAtomically, listSavedGames, STANDARD_START_FEN, storeSavedGame, type SavedGame } from "./game-library";
import { cycleTrees, parseInChildProcess } from "./test-helpers/variation-cycle";
import { createReviewVariationTree, type SerializedReviewVariationTree } from "./review-variation-tree";

const game = (id: string, red = "甲", extra: Partial<SavedGame> = {}): SavedGame => ({
  id, savedAt: 10, moves: ["h2e2", "h9g7"], startFen: STANDARD_START_FEN, source: "imported", importFormat: "pgn",
  importMetadata: { Red: red, Black: "乙" }, importWarnings: [], variationTree: null, ...extra,
});
const replay = async (_fen: string, moves: string[]) => moves.every((move) => /^[a-i][0-9][a-i][0-9]$/.test(move));
const note = { reportDate: "2026-10-09", markdown: "# 覆盤筆記", plainText: "覆盤筆記", curveSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' };
const emptyBoard = "rnbakabnr" + "........." + ".c.....c." + "p.p.p.p.p" + "........." + "........." + "P.P.P.P.P" + ".C.....C." + "........." + "RNBAKABNR";
const snapshot = { startFen: STANDARD_START_FEN, moves: [], points: [], boards: [emptyBoard],
  analyzer: { name: "內建引擎", quickNodeLimit: 1, deepNodeLimit: 2, config: "c" }, result: "unknown" as const, reportDate: "2026-10-09" };

describe("archive parsing: bad, old and malformed files are refused with a reason", () => {
  const archive = () => buildArchive([game("a")], "2026-10-09");

  it("refuses text that is not JSON", async () => {
    await expect(parseArchive("not json {", replay)).rejects.toThrow(/JSON/);
  });
  it("refuses JSON that is not a backup file (including a bare array of games)", async () => {
    await expect(parseArchive(JSON.stringify([game("a")]), replay)).rejects.toThrow(/備份檔/);
    await expect(parseArchive(JSON.stringify({ hello: 1 }), replay)).rejects.toThrow(/備份檔/);
  });
  it("refuses a file with no version, an older version, or a newer version, naming the version", async () => {
    const { schemaVersion: _drop, ...unversioned } = archive();
    await expect(parseArchive(JSON.stringify(unversioned), replay)).rejects.toThrow(/版本/);
    await expect(parseArchive(JSON.stringify({ ...archive(), schemaVersion: 0 }), replay)).rejects.toThrow(/版本/);
    await expect(parseArchive(JSON.stringify({ ...archive(), schemaVersion: 2 }), replay)).rejects.toThrow(/版本（2）/);
  });
  it("refuses a broken envelope", async () => {
    await expect(parseArchive(JSON.stringify({ ...archive(), exportedAt: "yesterday" }), replay)).rejects.toThrow(/結構/);
    await expect(parseArchive(JSON.stringify({ ...archive(), games: "not a list" }), replay)).rejects.toThrow(/結構/);
  });
  it("refuses duplicate ids inside the file, naming the record", async () => {
    const dup = buildArchive([game("a"), game("a", "不同")], "2026-10-09");
    await expect(parseArchive(JSON.stringify(dup), replay)).rejects.toThrow(/第 2 局.*重複/);
  });
  it("refuses a record with a malformed analysis or note payload instead of silently dropping it", async () => {
    const badSnapshot = JSON.parse(JSON.stringify(archive()));
    badSnapshot.games[0].reviewSnapshot = { nonsense: true };
    await expect(parseArchive(JSON.stringify(badSnapshot), replay)).rejects.toThrow(/第 1 局.*分析/);
    const badNote = JSON.parse(JSON.stringify(archive()));
    badNote.games[0] = { ...game("n", "甲", { moves: [], reviewSnapshot: snapshot }), reviewNote: { markdown: 1 } };
    await expect(parseArchive(JSON.stringify(badNote), replay)).rejects.toThrow(/第 1 局.*筆記/);
  });
  it("refuses a note that has no matching analysis snapshot instead of silently dropping it", async () => {
    const orphan = JSON.parse(JSON.stringify(archive()));
    orphan.games[0].reviewNote = note;
    await expect(parseArchive(JSON.stringify(orphan), replay)).rejects.toThrow(/第 1 局.*筆記/);
  });
  it("refuses a variation tree that does not belong to the record's mainline or root", async () => {
    const tree = createReviewVariationTree(["h2e2"], STANDARD_START_FEN).toJSON();
    const wrong = buildArchive([game("a", "甲", { variationTree: tree })], "2026-10-09");
    await expect(parseArchive(JSON.stringify(wrong), replay)).rejects.toThrow(/第 1 局.*分支樹/);
  });
  it("keeps notes and variation trees through a round trip", async () => {
    const tree = createReviewVariationTree(["h2e2", "h9g7"], STANDARD_START_FEN);
    const branch = tree.append(tree.mainlineNodeId(1), "b9c7");
    tree.annotate(branch, "註解");
    const full = buildArchive([game("a", "甲", { variationTree: tree.toJSON() }), game("n", "甲", { moves: [], reviewSnapshot: snapshot, reviewNote: note })], "2026-10-09");
    expect((await parseArchive(JSON.stringify(full), replay)).games).toEqual(full.games);
    expect(full.games.find((row) => row.id === "n")?.reviewNote).toEqual(note);
  });
  it("accepts an empty library", async () => {
    const empty = buildArchive([], "2026-10-09");
    expect((await parseArchive(JSON.stringify(empty), replay)).games).toEqual([]);
  });
  it("is deterministic: the same games and date give byte-identical JSON", () => {
    expect(JSON.stringify(buildArchive([game("a")], "2026-10-09"))).toBe(JSON.stringify(buildArchive([game("a")], "2026-10-09")));
    expect(() => buildArchive([], "not a date")).toThrow();
  });
});

describe("merging: duplicates and counts", () => {
  it("adds new ids, skips identical records, and never overwrites an existing record", () => {
    const existing = [game("a", "原本")];
    const merged = mergeArchiveGames(existing, [game("a", "原本"), game("b", "新的")]);
    expect(merged.added).toBe(1);
    expect(merged.skipped).toBe(1);
    expect(merged.games.find((row) => row.id === "a")?.importMetadata.Red).toBe("原本");
    expect(existing).toHaveLength(1);
  });
  it("does not mutate its inputs", () => {
    const imported = [game("a", "新")];
    const before = JSON.stringify(imported);
    mergeArchiveGames([game("a", "舊")], imported);
    expect(JSON.stringify(imported)).toBe(before);
  });
});

// A minimal in-memory IndexedDB: writes are staged and only applied when the transaction completes.
function installFakeIndexedDb(): Map<string, unknown> {
  const committed = new Map<string, unknown>();
  const makeTransaction = (failOnAdd: string | null) => {
    const staged = new Map(committed);
    let aborted = false;
    let finished = false;
    const tx: any = { error: null, oncomplete: null, onabort: null, onerror: null };
    const finish = () => {
      if (finished) return;
      finished = true;
      if (aborted) { tx.error = new Error("aborted"); tx.onabort?.(); return; }
      committed.clear();
      for (const [key, value] of staged) committed.set(key, value);
      tx.oncomplete?.();
    };
    tx.abort = () => { aborted = true; setTimeout(finish, 0); };
    tx.objectStore = () => ({
      getAll: () => {
        const request: any = { result: undefined, onsuccess: null, onerror: null };
        setTimeout(() => { request.result = [...staged.values()].map((value) => structuredClone(value)); request.onsuccess?.(); setTimeout(finish, 0); }, 0);
        return request;
      },
      add: (value: { id: string }) => {
        if (value.id === failOnAdd) throw new Error("DataError");
        if (staged.has(value.id)) throw new Error("ConstraintError");
        staged.set(value.id, structuredClone(value));
      },
      put: (value: { id: string }) => { staged.set(value.id, structuredClone(value)); },
    });
    setTimeout(finish, 5);
    return tx;
  };
  const database = {
    objectStoreNames: { contains: () => true }, createObjectStore: () => ({}), onversionchange: null,
    transaction: () => makeTransaction((globalThis as any).__failOnAdd ?? null),
  };
  (globalThis as any).indexedDB = {
    open: () => {
      const request: any = { result: database, onsuccess: null, onupgradeneeded: null, onerror: null, onblocked: null };
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    },
  };
  return committed;
}

describe("atomic import into the library", () => {
  const committed = installFakeIndexedDb();
  beforeEach(async () => {
    (globalThis as any).__failOnAdd = null;
    committed.clear();
    await storeSavedGame(game("existing", "原本"));
  });

  it("adds every new record in one transaction and reports the counts", async () => {
    const result = await importSavedGamesAtomically([game("a"), game("existing", "原本"), game("b")], mergeArchiveGames);
    expect(result).toEqual({ added: 2, skipped: 1 });
    expect((await listSavedGames()).map((row) => row.id).sort()).toEqual(["a", "b", "existing"]);
  });

  it("rolls the whole import back when the merge throws", async () => {
    await expect(importSavedGamesAtomically([game("a")], () => { throw new Error("boom"); })).rejects.toThrow();
    expect((await listSavedGames()).map((row) => row.id)).toEqual(["existing"]);
  });

  it("rolls the whole import back when a later write fails, leaving earlier writes unapplied", async () => {
    (globalThis as any).__failOnAdd = "c";
    await expect(importSavedGamesAtomically([game("a"), game("b"), game("c")], mergeArchiveGames)).rejects.toThrow();
    expect((await listSavedGames()).map((row) => row.id)).toEqual(["existing"]);
  });
});

describe("archive round trip of the turn starts kept with a variation tree", () => {
  const withTurns = (turnStarts: unknown) => {
    const tree = createReviewVariationTree(["h2e2", "h9g7"]);
    const reply = tree.append(tree.append(tree.mainlineNodeId(1), "b9c7"), "b0c2");
    tree.markTurnStart(reply, tree.mainlineNodeId(1));
    return { reply, saved: { ...tree.toJSON(), ...(turnStarts === undefined ? {} : { turnStarts }) } as SerializedReviewVariationTree };
  };
  it("exports and imports good turn starts unchanged", async () => {
    const { reply, saved } = withTurns(undefined);
    const archive = buildArchive([game("a", "甲", { variationTree: saved })], "2026-10-09");
    const back = await parseArchive(JSON.stringify(archive), replay);
    expect(back.games[0].variationTree?.turnStarts).toEqual({ [reply]: "main-1" });
  });
  it("still imports a backup whose turnStarts is damaged, instead of refusing the whole file", async () => {
    for (const bad of [null, "main-1", { x: 5 }]) {
      const { saved } = withTurns(bad);
      const archive = buildArchive([game("a", "甲", { variationTree: saved })], "2026-10-09");
      const back = await parseArchive(JSON.stringify(archive), replay);
      expect(back.games).toHaveLength(1);
    }
  });
});

describe("archive import refuses a variation tree whose parents loop", () => {
  for (const [name, loop] of Object.entries(cycleTrees)) {
    it(`names the record and imports nothing, without hanging: ${name}`, async () => {
      const healthy = createReviewVariationTree(["h2e2", "h9g7"]).toJSON();
      const cyclic: SerializedReviewVariationTree = { ...healthy, nodes: [...healthy.nodes, ...loop.nodes.filter((n) => n.id !== "main-0")], ...(loop.turnStarts ? { turnStarts: loop.turnStarts } : {}) };
      // guard first: a parse that never ends fails here by timeout instead of freezing the in-process call below
      expect(parseInChildProcess(cyclic)).toMatch(/^rejected:TypeError/);
      const archive = buildArchive([game("ok"), game("bad", "甲", { variationTree: cyclic })], "2026-10-09");
      await expect(parseArchive(JSON.stringify(archive), replay)).rejects.toThrow("第 2 局的分支樹結構錯誤，整份備份未匯入。");
    }, 15_000);
  }
});
