import { describe, expect, it } from "vitest";
import { countedGames, createPlayedGames, playedCounts, type PlayedGameInput } from "./played-games";
import { memoryStorage } from "./test-support-level";

const game = (n: number, extra: Partial<PlayedGameInput> = {}): PlayedGameInput => ({
  key: `fen|m${n}|red`, startFen: "fen", moves: [`m${n}`, "x"], userSide: "red", assisted: false, budget: 1_000_000, finishedAt: n, ...extra,
});

describe("played games ledger shared by two tabs", () => {
  it("keeps a game another tab added when this tab adds one", () => {
    const storage = memoryStorage();
    const a = createPlayedGames(storage);
    const b = createPlayedGames(storage);
    a.add(game(1));
    b.add(game(2));
    expect(createPlayedGames(storage).all().map((g) => g.key)).toEqual(["fen|m1|red", "fen|m2|red"]);
  });
  it("does not turn a game another tab counted back into pending", () => {
    const storage = memoryStorage();
    const a = createPlayedGames(storage);
    a.add(game(1));
    const b = createPlayedGames(storage);
    a.markCounted("fen|m1|red");
    b.add(game(2));
    const stored = createPlayedGames(storage).all();
    expect(stored.find((g) => g.key === "fen|m1|red")!.state).toBe("counted");
    expect(stored).toHaveLength(2);
  });
  it("does not add a game twice when both tabs saw the same one", () => {
    const storage = memoryStorage();
    const a = createPlayedGames(storage);
    const b = createPlayedGames(storage);
    expect(a.add(game(1))).toBe(true);
    expect(b.add(game(1))).toBe(false);
    expect(createPlayedGames(storage).all()).toHaveLength(1);
  });
  it("refresh brings in what another tab wrote", () => {
    const storage = memoryStorage();
    const a = createPlayedGames(storage);
    createPlayedGames(storage).add(game(1));
    expect(a.all()).toHaveLength(0);
    a.refresh();
    expect(a.all()).toHaveLength(1);
  });
});

describe("countedGames", () => {
  it("counts only unassisted games whose review reached the level estimate, so it never exceeds N", () => {
    const ledger = createPlayedGames(memoryStorage());
    ledger.add(game(1));
    ledger.add(game(2));
    ledger.add(game(3, { assisted: true }));
    ledger.markCounted("fen|m1|red");
    expect(countedGames(ledger.all())).toBe(1);
    expect(countedGames(ledger.all())).toBeLessThanOrEqual(playedCounts(ledger.all()).played);
  });
});
