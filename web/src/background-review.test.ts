import { describe, expect, it } from "vitest";
import { createBackgroundReview, type BackgroundPool } from "./background-review";
import { createPlayedGames, type PlayedGameInput } from "./played-games";
import { memoryStorage } from "./test-support-level";
import type { ReviewJobState } from "./review-client";

const game = (n: number, extra: Partial<PlayedGameInput> = {}): PlayedGameInput => ({
  key: `fen|m${n}|red`, startFen: "fen", moves: [`m${n}`, "x"], userSide: "red", assisted: false, budget: 1_000_000, finishedAt: n, ...extra,
});
const points = (count: number) => Array.from({ length: count }, () => ({}) as ReviewJobState["points"][number]);

function harness(initial: PlayedGameInput[] = []) {
  const storage = memoryStorage();
  const ledger = createPlayedGames(storage);
  initial.forEach((entry) => ledger.add(entry));
  const pools: Array<{ moves: string[]; budget: number; startFen: string; disposed: boolean; emit: (state: Partial<ReviewJobState>) => void }> = [];
  const recorded: Array<{ key: string; points: number }> = [];
  const review = createBackgroundReview({
    ledger,
    createPool: (onUpdate): BackgroundPool => {
      const entry = { moves: [] as string[], budget: 0, startFen: "", disposed: false, emit: (state: Partial<ReviewJobState>) => onUpdate({ id: 1, status: "running", points: [], workerCount: 2, activeWorkers: 2, ...state } as ReviewJobState) };
      pools.push(entry);
      return {
        start: (moves, budget, startFen) => { entry.moves = moves; entry.budget = budget; entry.startFen = startFen; return 1; },
        dispose: () => { entry.disposed = true; },
      };
    },
    record: (entry, pts) => { recorded.push({ key: entry.key, points: pts.length }); },
  });
  return { ledger, review, pools, recorded, storage };
}

describe("background review", () => {
  it("does nothing while not allowed to run, and runs the oldest pending game when allowed", () => {
    const h = harness([game(1), game(2)]);
    h.review.sync(false);
    expect(h.pools).toHaveLength(0);
    h.review.sync(true);
    expect(h.pools).toHaveLength(1);
    expect(h.pools[0]!.moves).toEqual(["m1", "x"]);
    expect(h.pools[0]!.budget).toBe(1_000_000);
    expect(h.review.activeKey()).toBe("fen|m1|red");
  });

  it("records the finished game once, from the game's own data, then goes on to the next", () => {
    const h = harness([game(1), game(2)]);
    h.review.sync(true);
    h.pools[0]!.emit({ status: "complete", points: points(2) });
    h.pools[0]!.emit({ status: "complete", points: points(2) });
    expect(h.recorded).toEqual([{ key: "fen|m1|red", points: 2 }]);
    expect(h.ledger.all()[0]!.state).toBe("counted");
    expect(h.pools[0]!.disposed).toBe(true);
    expect(h.pools).toHaveLength(2);
    expect(h.pools[1]!.moves).toEqual(["m2", "x"]);
  });

  it("stops when no longer allowed and leaves the game pending", () => {
    const h = harness([game(1)]);
    h.review.sync(true);
    h.review.sync(false);
    expect(h.pools[0]!.disposed).toBe(true);
    expect(h.review.activeKey()).toBeNull();
    expect(h.ledger.pending()).toHaveLength(1);
    h.pools[0]!.emit({ status: "complete", points: points(2) });
    expect(h.recorded).toHaveLength(0);
    h.review.sync(true);
    expect(h.pools).toHaveLength(2);
  });

  it("an update from a stopped job is ignored even after a newer job started", () => {
    const h = harness([game(1)]);
    h.review.sync(true);
    h.review.sync(false);
    h.review.sync(true);
    h.pools[0]!.emit({ status: "complete", points: points(2) });
    expect(h.recorded).toHaveLength(0);
    h.pools[1]!.emit({ status: "complete", points: points(2) });
    expect(h.recorded).toHaveLength(1);
  });

  it("a game that finishes after the board moved on is still recorded as its own game", () => {
    const h = harness([game(1)]);
    h.review.sync(true);
    h.ledger.add(game(9, { userSide: "black" }));
    h.pools[0]!.emit({ status: "complete", points: points(2) });
    expect(h.recorded[0]!.key).toBe("fen|m1|red");
  });

  it("gives up on a game after three failed attempts, one attempt per page session at a time", () => {
    const h = harness([game(1)]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      h.review.sync(true);
      h.pools[attempt]!.emit({ status: "failed", error: "reviewFailed" });
      // the same session does not retry straight away
      h.review.sync(true);
      expect(h.pools).toHaveLength(attempt + 1);
      h.review.resetSession();
    }
    expect(h.ledger.all()[0]!.state).toBe("skipped");
    h.review.sync(true);
    expect(h.pools).toHaveLength(3);
  });

  it("a wrong number of points counts as a failure, not as a reviewed game", () => {
    const h = harness([game(1)]);
    h.review.sync(true);
    h.pools[0]!.emit({ status: "complete", points: points(1) });
    expect(h.recorded).toHaveLength(0);
    expect(h.ledger.all()[0]!.failures).toBe(1);
  });

  it("resumes pending games from storage on a fresh page", () => {
    const first = harness([game(1), game(2)]);
    first.review.sync(true);
    first.pools[0]!.emit({ status: "complete", points: points(2) });
    const ledger = createPlayedGames(first.storage);
    expect(ledger.pending().map((g) => g.key)).toEqual(["fen|m2|red"]);
  });

  it("never reviews an assisted game", () => {
    const h = harness([game(1, { assisted: true })]);
    h.review.sync(true);
    expect(h.pools).toHaveLength(0);
  });
});
