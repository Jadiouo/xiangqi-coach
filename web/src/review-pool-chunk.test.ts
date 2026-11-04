import { describe, expect, it, vi } from "vitest";
import type { ReviewWorkerPoint, ReviewWorkerResponse } from "./review-client";
import { ReviewCache, createMemoryReviewCacheStore } from "./review-cache";
import { ReviewWorkerPool, reviewChunkSize } from "./review-pool";

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
const NODES = 5000;
const game = Array.from({ length: 24 }, (_, ply) => `m${ply}`);

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
function pointFor(marker: number, requestId: number): ReviewWorkerPoint {
  return { quick: result(marker, requestId), final: result(marker, requestId), deepened: false, continuationComplete: true };
}

function setup(workerCount: number, cache?: ReviewCache) {
  const workers: FakeWorker[] = [];
  const pool = new ReviewWorkerPool(
    () => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; },
    workerCount,
    () => {},
    cache,
  );
  return { pool, workers };
}

/** The worker reports every ply of its run, then ends normally. */
function finishRun(worker: FakeWorker): void {
  const last = worker.starts.at(-1)!;
  const points: ReviewWorkerPoint[] = [];
  for (const ply of last.indices!) {
    points[ply] = pointFor(ply, last.jobId ?? 0);
    worker.respond({ id: last.id, status: "point", pass: "quick", index: ply, point: points[ply]!, continuationPending: false });
  }
  worker.respond({ id: last.id, status: "complete", points });
}

const runs = (worker: FakeWorker) => worker.starts.map((start) => start.indices);

describe("reviewChunkSize", () => {
  it("is about a third of each worker's share, between 1 and 6", () => {
    expect(reviewChunkSize(5, 3)).toBe(1);
    expect(reviewChunkSize(24, 2)).toBe(4);
    expect(reviewChunkSize(60, 4)).toBe(5);
    expect(reviewChunkSize(60, 1)).toBe(6);
    expect(reviewChunkSize(0, 4)).toBe(1);
  });
});

describe("ReviewWorkerPool hands out runs of neighbouring plies", () => {
  it("gives each worker a run of consecutive plies and the next run to whoever finishes first", () => {
    const { pool, workers } = setup(2);
    pool.start(game, NODES, START);
    expect(workers.map(runs)).toEqual([[[0, 1, 2, 3]], [[4, 5, 6, 7]]]);
    finishRun(workers[1]!);
    expect(runs(workers[1]!)).toEqual([[4, 5, 6, 7], [8, 9, 10, 11]]);
    finishRun(workers[0]!);
    expect(runs(workers[0]!)).toEqual([[0, 1, 2, 3], [12, 13, 14, 15]]);
    expect(pool.state?.points).toHaveLength(8);
  });

  it("covers every ply exactly once and completes", () => {
    const { pool, workers } = setup(3);
    pool.start(game, NODES, START);
    for (let guard = 0; guard < 50 && pool.state?.status === "running"; guard += 1) {
      for (const worker of workers) {
        const last = worker.starts.at(-1);
        if (last && !(worker as unknown as { seen?: Set<number> }).seen?.has(last.id)) {
          const seen = ((worker as unknown as { seen?: Set<number> }).seen ??= new Set());
          seen.add(last.id);
          finishRun(worker);
        }
      }
    }
    expect(pool.state?.status).toBe("complete");
    const handed = workers.flatMap((worker) => worker.starts.flatMap((start) => start.indices ?? []));
    expect(handed.sort((a, b) => a - b)).toEqual(game.map((_, ply) => ply));
  });

  it("ends a run at a cached ply instead of spanning it", async () => {
    const store = createMemoryReviewCacheStore();
    const cache = new ReviewCache({ version: "v1", store });
    await cache.save(START, game, NODES, [{ ply: 6, point: pointFor(6, 1) }]);
    const { pool, workers } = setup(2, cache);
    pool.start(game, NODES, START);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    // 23 missing plies, 2 workers: runs of 3, never across ply 6.
    expect(workers.map(runs)).toEqual([[[0, 1, 2]], [[3, 4, 5]]]);
    finishRun(workers[0]!);
    expect(runs(workers[0]!)[1]).toEqual([7, 8, 9]);
  });

  it("stores every ply of a finished run in the cache", async () => {
    const store = createMemoryReviewCacheStore();
    const cache = new ReviewCache({ version: "v1", store });
    const { pool, workers } = setup(2, cache);
    pool.start(game, NODES, START);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    finishRun(workers[0]!);
    await vi.waitFor(async () => expect([...(await cache.lookup(START, game, NODES)).keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]));
  });

  it("keeps one ply per session for a short game", () => {
    const { pool, workers } = setup(4);
    pool.start(game.slice(0, 8), NODES, START);
    expect(workers.map(runs)).toEqual([[[0]], [[1]], [[2]], [[3]]]);
  });
});

describe("ReviewWorkerPool cancelled in the middle of runs", () => {
  it("shows only the consecutive prefix, writes nothing to the cache and ends cancelled", async () => {
    const store = createMemoryReviewCacheStore();
    const cache = new ReviewCache({ version: "v1", store });
    const { pool, workers } = setup(2, cache);
    pool.start(game, NODES, START);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    expect(workers.map(runs)).toEqual([[[0, 1, 2, 3]], [[4, 5, 6, 7]]]);
    const [first, second] = workers as [FakeWorker, FakeWorker];
    const report = (worker: FakeWorker, plies: number[]) => {
      const start = worker.starts.at(-1)!;
      for (const ply of plies) {
        worker.respond({ id: start.id, status: "point", pass: "quick", index: ply, point: pointFor(ply, 0), continuationPending: false });
      }
    };
    report(first, [0, 1, 2]);
    report(second, [4, 5]);
    pool.cancel();
    const points: ReviewWorkerPoint[] = [];
    for (const ply of [0, 1, 2]) points[ply] = pointFor(ply, 0);
    first.respond({ id: first.currentId, status: "cancelled", points });
    expect(pool.state?.status).toBe("running");
    const otherPoints: ReviewWorkerPoint[] = [];
    for (const ply of [4, 5]) otherPoints[ply] = pointFor(ply, 0);
    second.respond({ id: second.currentId, status: "cancelled", points: otherPoints });
    expect(pool.state?.status).toBe("cancelled");
    // Plies 4 and 5 arrived but ply 3 never did, so only 0..2 may be shown.
    expect(pool.state?.points).toHaveLength(3);
    // A cancelled run is not final, so nothing of it reaches the cache.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await cache.lookup(START, game, NODES)).size).toBe(0);
  });
});
