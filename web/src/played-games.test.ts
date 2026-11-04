import { describe, expect, it } from "vitest";
import { createPlayedGames, playedCounts, type PlayedGameInput } from "./played-games";
import { MAX_REMEMBERED_GAMES } from "./user-level";
import { memoryStorage } from "./test-support-level";

const KEY = "xq.played-games.v1";
const game = (n: number, extra: Partial<PlayedGameInput> = {}): PlayedGameInput => ({
  key: `fen|m${n}|red`, startFen: "fen", moves: [`m${n}`, "x"], userSide: "red", assisted: false, budget: 1_000_000, finishedAt: n, ...extra,
});

describe("played games ledger", () => {
  it("adds a finished game once per key and survives a reload", () => {
    const storage = memoryStorage();
    const ledger = createPlayedGames(storage);
    expect(ledger.add(game(1))).toBe(true);
    expect(ledger.add(game(1))).toBe(false);
    expect(ledger.all()).toHaveLength(1);
    expect(createPlayedGames(storage).all()).toHaveLength(1);
    expect(createPlayedGames(storage).pending().map((g) => g.key)).toEqual(["fen|m1|red"]);
  });

  it("gives assisted games no review and leaves them out of N", () => {
    const ledger = createPlayedGames(memoryStorage());
    ledger.add(game(1));
    ledger.add(game(2, { assisted: true }));
    expect(ledger.pending().map((g) => g.key)).toEqual(["fen|m1|red"]);
    expect(playedCounts(ledger.all())).toEqual({ played: 1, assisted: 1 });
  });

  it("marks games counted by its own state, not by any other record", () => {
    const storage = memoryStorage();
    const ledger = createPlayedGames(storage);
    ledger.add(game(1));
    ledger.add(game(2));
    ledger.markCounted("fen|m1|red");
    expect(ledger.pending().map((g) => g.key)).toEqual(["fen|m2|red"]);
    expect(createPlayedGames(storage).pending().map((g) => g.key)).toEqual(["fen|m2|red"]);
    expect(playedCounts(ledger.all()).played).toBe(2);
  });

  it("gives up on a game after three failures", () => {
    const ledger = createPlayedGames(memoryStorage());
    ledger.add(game(1));
    ledger.recordFailure("fen|m1|red");
    ledger.recordFailure("fen|m1|red");
    expect(ledger.pending()).toHaveLength(1);
    ledger.recordFailure("fen|m1|red");
    expect(ledger.pending()).toHaveLength(0);
    expect(ledger.all()[0]!.state).toBe("skipped");
    expect(playedCounts(ledger.all()).played).toBe(1);
  });

  it("drops everything when the stored data is damaged", () => {
    expect(createPlayedGames(memoryStorage({ [KEY]: "{not json" })).all()).toEqual([]);
    expect(createPlayedGames(memoryStorage({ [KEY]: JSON.stringify([{ key: 1 }]) })).all()).toEqual([]);
    const good = JSON.stringify([{ ...game(1), state: "pending", failures: 0 }, { ...game(2), state: "weird", failures: 0 }]);
    expect(createPlayedGames(memoryStorage({ [KEY]: good })).all()).toEqual([]);
  });

  it("keeps at most as many games as the level module remembers, newest last", () => {
    const ledger = createPlayedGames(memoryStorage());
    for (let n = 0; n < MAX_REMEMBERED_GAMES + 3; n += 1) ledger.add(game(n));
    expect(ledger.all()).toHaveLength(MAX_REMEMBERED_GAMES);
    expect(ledger.all()[0]!.key).toBe("fen|m3|red");
  });

  it("works without usable storage", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const ledger = createPlayedGames(broken);
    expect(() => ledger.add(game(1))).not.toThrow();
    expect(ledger.all()).toHaveLength(1);
  });
});
