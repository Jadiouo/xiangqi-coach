import { describe, expect, it, vi } from "vitest";
import type { ReviewJobState, ReviewWorkerPoint, ReviewWorkerResponse } from "./review-client";
import { ReviewCache, createMemoryReviewCacheStore, type ReviewCacheStore } from "./review-cache";
import { ReviewWorkerPool } from "./review-pool";

type StartMessage = { type: "start"; id: number; jobId?: number; moves: string[]; indices?: number[]; focusIndex?: number };

class FakeWorker {
  posted: Array<StartMessage | { type: "cancel"; id: number }> = [];
  private listeners: Array<(event: MessageEvent<ReviewWorkerResponse>) => void> = [];
  postMessage(message: FakeWorker["posted"][number]): void { this.posted.push(message); }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === "message") this.listeners.push(listener as (event: MessageEvent<ReviewWorkerResponse>) => void);
  }
  terminate(): void {}
  respond(response: ReviewWorkerResponse): void {
    for (const listener of this.listeners) listener({ data: response } as MessageEvent<ReviewWorkerResponse>);
  }
  get starts(): StartMessage[] { return this.posted.filter((m): m is StartMessage => m.type === "start"); }
  get currentId(): number { return this.starts.at(-1)!.id; }
}

const START = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";
const game = ["a", "b", "c", "d", "e"];
const NODES = 5000;

function result(marker: number, requestId: number) {
  return {
    bestMove: "h2e2", playedMove: "h2e2", playedRank: 1,
    bestScore: { centipawns: marker, mateIn: null }, playedScore: { centipawns: marker, mateIn: null },
    bestWinProbability: 0.5, playedWinProbability: 0.5, lossPercent: 0, classification: "good" as const, reason: null,
    candidates: [{
      move: "h2e2", score: { centipawns: marker, mateIn: null }, pv: ["h2e2"], depth: 3, nodes: 10,
      pvEnd: "depth_limit" as const, continuation: [], continuationNodeLimit: 1, continuationTerminal: false,
      replayAudit: { requestId }, continuationStatus: "complete" as const,
    }],
  };
}
function pointFor(marker: number, requestId: number, complete = true): ReviewWorkerPoint {
  return { quick: result(marker, requestId), final: result(marker, requestId), deepened: true, continuationComplete: complete };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(workerCount: number, store: ReviewCacheStore = createMemoryReviewCacheStore(), version = "v1") {
  const workers: FakeWorker[] = [];
  const updates: ReviewJobState[] = [];
  const cache = new ReviewCache({ version, store });
  const pool = new ReviewWorkerPool(
    () => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; },
    workerCount,
    (state) => updates.push(state),
    cache,
  );
  return { pool, workers, updates, cache, store };
}

/** The worker finishes one ply: its final point, then the terminal message. */
function finishPly(worker: FakeWorker, ply: number, complete = true): void {
  const point = pointFor(ply, worker.starts.at(-1)!.jobId ?? 0, complete);
  worker.respond({ id: worker.currentId, status: "point", pass: "deep", index: ply, point, continuationPending: !complete });
  const points: ReviewWorkerPoint[] = [];
  points[ply] = point;
  worker.respond({ id: worker.currentId, status: "complete", points });
}

/** Runs a whole review on fake workers until the pool reports complete. */
async function runAll(env: ReturnType<typeof setup>): Promise<ReviewJobState> {
  await flush();
  for (let guard = 0; guard < 100 && env.pool.state?.status === "running"; guard += 1) {
    const requests = env.workers.flatMap((worker) =>
      worker.starts.length && worker.starts.at(-1)!.id !== (worker as unknown as { done?: number }).done ? [worker] : []);
    for (const worker of requests) {
      const last = worker.starts.at(-1)!;
      (worker as unknown as { done?: number }).done = last.id;
      if (last.indices === undefined) {
        const points: ReviewWorkerPoint[] = last.moves.map((_, ply) => pointFor(ply, last.jobId ?? last.id));
        points.forEach((point, ply) => worker.respond({ id: last.id, status: "point", pass: "deep", index: ply, point, continuationPending: false }));
        worker.respond({ id: last.id, status: "complete", points });
      } else {
        for (const ply of last.indices) finishPly(worker, ply);
      }
    }
    await flush();
  }
  return env.pool.state!;
}

describe("ReviewWorkerPool with a result cache", () => {
  it("computes everything the first time, then answers the same game from the cache without any worker", async () => {
    const store = createMemoryReviewCacheStore();
    const first = setup(2, store);
    first.pool.start(game, NODES, START);
    const firstState = await runAll(first);
    expect(firstState.status).toBe("complete");
    expect(firstState.cachedPlies ?? 0).toBe(0);
    // Saving is asynchronous (hashing, storage); wait until every ply is readable.
    await vi.waitFor(async () => expect((await new ReviewCache({ version: "v1", store }).lookup(START, game, NODES)).size).toBe(game.length));

    const second = setup(2, store);
    const id = second.pool.start(game, NODES, START);
    await flush();
    expect(second.workers.flatMap((worker) => worker.starts)).toHaveLength(0);
    const state = second.pool.state!;
    expect(state.status).toBe("complete");
    expect(state.cachedPlies).toBe(game.length);
    expect(state.points).toHaveLength(game.length);
    // Same points as a fresh computation in this job would give (the replay audit names this job).
    state.points.forEach((point, ply) => expect(point).toEqual(pointFor(ply, id)));
  });

  it("only computes the plies the cache does not have", async () => {
    const store = createMemoryReviewCacheStore();
    const seed = new ReviewCache({ version: "v1", store });
    await seed.save(START, game, NODES, [0, 1, 3].map((ply) => ({ ply, point: pointFor(ply, 1) })));
    const env = setup(4, store);
    env.pool.start(game, NODES, START);
    await vi.waitFor(() => expect(env.workers.flatMap((worker) => worker.starts)).toHaveLength(2));
    const requested = env.workers.flatMap((worker) => worker.starts.map((start) => start.indices));
    expect(requested.sort()).toEqual([[2], [4]]);
    expect(env.pool.state!.points).toHaveLength(2); // the cached prefix shows at once
    expect(env.pool.state!.cachedPlies).toBe(3);
    const done = await runAll(env);
    expect(done.status).toBe("complete");
    expect(done.points).toHaveLength(game.length);
  });

  it("with one worker, runs the ordinary whole-game session when nothing is cached and stores its result", async () => {
    const store = createMemoryReviewCacheStore();
    const env = setup(1, store);
    env.pool.start(game, NODES, START);
    await vi.waitFor(() => expect(env.workers).toHaveLength(1));
    expect(env.workers[0]!.starts[0]!.indices).toBeUndefined();
    expect((await runAll(env)).status).toBe("complete");
    await vi.waitFor(async () => expect((await new ReviewCache({ version: "v1", store }).lookup(START, game, NODES)).size).toBe(game.length));
  });

  it("with one worker and some plies cached, asks the worker only for the missing ones", async () => {
    const store = createMemoryReviewCacheStore();
    await new ReviewCache({ version: "v1", store }).save(START, game, NODES, [0, 1, 2].map((ply) => ({ ply, point: pointFor(ply, 1) })));
    const env = setup(1, store);
    env.pool.start(game, NODES, START);
    await vi.waitFor(() => expect(env.workers.flatMap((worker) => worker.starts.map((start) => start.indices))).toEqual([[3]]));
  });

  it("does not use entries from another version or another node count", async () => {
    const store = createMemoryReviewCacheStore();
    await new ReviewCache({ version: "v0", store }).save(START, game, NODES, game.map((_, ply) => ({ ply, point: pointFor(ply, 1) })));
    const other = setup(4, store, "v1");
    other.pool.start(game, NODES, START);
    await vi.waitFor(() => expect(other.workers.flatMap((worker) => worker.starts)).toHaveLength(4));
    const bigger = setup(4, store, "v0");
    bigger.pool.start(game, NODES * 10, START);
    await vi.waitFor(() => expect(bigger.workers.flatMap((worker) => worker.starts)).toHaveLength(4));
  });

  it("does not store plies that were cancelled or not fully finished", async () => {
    const store = createMemoryReviewCacheStore();
    const env = setup(2, store);
    env.pool.start(game, NODES, START);
    await vi.waitFor(() => expect(env.workers).toHaveLength(2));
    finishPly(env.workers[0]!, 0); // ply 0 completes properly
    // ply 1's worker reports a point whose continuation is still running, then is cancelled
    env.workers[1]!.respond({
      id: env.workers[1]!.currentId, status: "point", pass: "deep", index: 1,
      point: pointFor(1, 1, false), continuationPending: true,
    });
    env.pool.cancel();
    env.workers[1]!.respond({ id: env.workers[1]!.currentId, status: "cancelled", points: [] });
    await vi.waitFor(async () => expect((await new ReviewCache({ version: "v1", store }).lookup(START, game, NODES)).size).toBe(1));
    await flush();
    const stored = await new ReviewCache({ version: "v1", store }).lookup(START, game, NODES);
    expect([...stored.keys()]).toEqual([0]);
  });

  it("does not store anything from a failed review", async () => {
    const store = createMemoryReviewCacheStore();
    const env = setup(2, store);
    env.pool.start(game, NODES, START);
    await vi.waitFor(() => expect(env.workers).toHaveLength(2));
    env.workers[1]!.respond({ id: env.workers[1]!.currentId, status: "failed", error: "reviewFailed", points: [] });
    await flush();
    await flush();
    expect((await new ReviewCache({ version: "v1", store }).lookup(START, game, NODES)).size).toBe(0);
  });

  it("falls back to a normal review when the cache cannot be read or written", async () => {
    const broken: ReviewCacheStore = { read: () => Promise.reject(new Error("x")), write: () => Promise.reject(new Error("x")) };
    const env = setup(2, broken);
    env.pool.start(game, NODES, START);
    expect((await runAll(env)).status).toBe("complete");
    expect(env.pool.state!.points).toHaveLength(game.length);
  });

  it("does not consult the cache for a focused (deepen one ply) run", async () => {
    const store = createMemoryReviewCacheStore();
    await new ReviewCache({ version: "v1", store }).save(START, game, NODES, game.map((_, ply) => ({ ply, point: pointFor(ply, 1) })));
    const env = setup(4, store);
    env.pool.start(game, NODES, START, 2);
    expect(env.workers.flatMap((worker) => worker.starts.map((start) => start.focusIndex))).toEqual([2]);
  });

  it("cancelling while the cache is still being read ends the job as cancelled and starts no worker", async () => {
    const env = setup(2);
    env.pool.start(game, NODES, START);
    env.pool.cancel();
    await flush();
    expect(env.pool.state!.status).toBe("cancelled");
    expect(env.workers.flatMap((worker) => worker.starts)).toHaveLength(0);
  });

  it("ignores a slow cache read that belongs to an earlier, replaced review", async () => {
    let release: (() => void) | undefined;
    const slow: ReviewCacheStore = {
      read: (keys) => new Promise((resolve) => { release = () => resolve(keys.map(() => undefined)); }),
      write: () => Promise.resolve(),
    };
    const env = setup(2, slow);
    env.pool.start(game, NODES, START);
    await vi.waitFor(() => expect(release).toBeDefined());
    const releaseFirst = release!;
    release = undefined;
    env.pool.start(["x", "y"], NODES, START);
    await vi.waitFor(() => expect(release).toBeDefined());
    releaseFirst();
    await flush();
    expect(env.workers).toHaveLength(0); // the stale answer started nothing
    release!();
    await vi.waitFor(() => expect(env.workers.length).toBeGreaterThan(0));
    const messages = env.workers.flatMap((worker) => worker.starts.map((start) => start.moves.join("")));
    expect(new Set(messages)).toEqual(new Set(["xy"]));
  });
});
