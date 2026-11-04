import { describe, expect, it } from "vitest";
import { createBackgroundReview, type BackgroundPool } from "./background-review";
import { createPlayedGames, type PlayedGameInput } from "./played-games";
import { memoryStorage } from "./test-support-level";
import type { ReviewJobState } from "./review-client";

const game = (n: number): PlayedGameInput => ({
  key: `fen|m${n}|red`, startFen: "fen", moves: [`m${n}`, "x"], userSide: "red", assisted: false, budget: 1_000_000, finishedAt: n,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const points = (count: number) => Array.from({ length: count }, () => ({}) as ReviewJobState["points"][number]);

describe("background review start failures", () => {
  it("a pool that throws on start is cleaned up and counted as a failure", () => {
    const ledger = createPlayedGames(memoryStorage());
    ledger.add(game(1));
    let disposed = 0;
    const review = createBackgroundReview({
      ledger,
      createPool: (): BackgroundPool => ({ start: () => { throw new Error("no worker"); }, dispose: () => { disposed += 1; } }),
      record: () => {},
    });
    expect(() => review.sync(true)).not.toThrow();
    expect(review.activeKey()).toBeNull();
    expect(disposed).toBe(1);
    expect(ledger.all()[0]!.failures).toBe(1);
    review.sync(true);
    expect(ledger.all()[0]!.failures).toBe(1);
  });
  it("a pool that cannot even be created is a failure too", () => {
    const ledger = createPlayedGames(memoryStorage());
    ledger.add(game(1));
    const review = createBackgroundReview({ ledger, createPool: () => { throw new Error("boom"); }, record: () => {} });
    expect(() => review.sync(true)).not.toThrow();
    expect(review.activeKey()).toBeNull();
    expect(ledger.all()[0]!.failures).toBe(1);
  });
});

describe("background review state for the page", () => {
  it("is idle, then running, then done", () => {
    const ledger = createPlayedGames(memoryStorage());
    ledger.add(game(1));
    let update: (state: ReviewJobState) => void = () => {};
    const review = createBackgroundReview({
      ledger, record: () => {},
      createPool: (onUpdate): BackgroundPool => { update = onUpdate; return { start: () => 1, dispose: () => {} }; },
    });
    expect(review.state()).toBe("idle");
    review.sync(true);
    expect(review.state()).toBe("running");
    update({ id: 1, status: "complete", points: points(2), workerCount: 1, activeWorkers: 0 } as ReviewJobState);
    expect(review.state()).toBe("done");
  });
  it("stays idle when the run was only stopped", () => {
    const ledger = createPlayedGames(memoryStorage());
    ledger.add(game(1));
    const review = createBackgroundReview({ ledger, record: () => {}, createPool: () => ({ start: () => 1, dispose: () => {} }) });
    review.sync(true);
    review.sync(false);
    expect(review.state()).toBe("idle");
  });
});

describe("one tab at a time", () => {
  function sharedLock() {
    let held = false;
    return async (): Promise<(() => void) | null> => {
      if (held) return null;
      held = true;
      return () => { held = false; };
    };
  }
  function tab(storage: ReturnType<typeof memoryStorage>, tryLock: () => Promise<(() => void) | null>) {
    const started: string[] = [];
    let update: (state: ReviewJobState) => void = () => {};
    const review = createBackgroundReview({
      ledger: createPlayedGames(storage), tryLock, record: () => {},
      createPool: (onUpdate): BackgroundPool => { update = onUpdate; return { start: (moves) => { started.push(moves[0]!); return 1; }, dispose: () => {} }; },
    });
    return { review, started, finish: (count: number) => update({ id: 1, status: "complete", points: points(count), workerCount: 1, activeWorkers: 0 } as ReviewJobState) };
  }
  it("only the tab that gets the lock reviews; the other waits until it is released", async () => {
    const storage = memoryStorage();
    createPlayedGames(storage).add(game(1));
    const lock = sharedLock();
    const a = tab(storage, lock);
    const b = tab(storage, lock);
    a.review.sync(true);
    b.review.sync(true);
    await flush();
    expect(a.started).toEqual(["m1"]);
    expect(b.started).toEqual([]);
    a.finish(2);
    await flush();
    b.review.sync(true);
    await flush();
    expect(b.started).toEqual([]); // nothing pending any more: the other tab already counted it
  });
  it("gives the lock back when stopped, so the other tab can take over", async () => {
    const storage = memoryStorage();
    createPlayedGames(storage).add(game(1));
    const lock = sharedLock();
    const a = tab(storage, lock);
    const b = tab(storage, lock);
    a.review.sync(true);
    await flush();
    a.review.sync(false);
    b.review.sync(true);
    await flush();
    expect(b.started).toEqual(["m1"]);
  });
  it("runs anyway when the lock request itself fails", async () => {
    const storage = memoryStorage();
    createPlayedGames(storage).add(game(1));
    const a = tab(storage, () => Promise.reject(new Error("no locks here")));
    a.review.sync(true);
    await flush();
    expect(a.started).toEqual(["m1"]);
  });
});
