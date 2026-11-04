import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewWorkerPoint, ReviewWorkerResponse } from "./review-client";
import { CANCEL_GRACE_MS, ReviewWorkerPool } from "./review-pool";
import { reviewWorkerCount } from "./review-workers";

type StartMessage = {
  type: "start";
  id: number;
  jobId?: number;
  moves: string[];
  indices?: number[];
  focusIndex?: number;
};

class FakeWorker {
  posted: Array<StartMessage | { type: "cancel"; id: number }> = [];
  terminated = false;
  private messageListeners: Array<(event: MessageEvent<ReviewWorkerResponse>) => void> = [];
  private errorListeners: Array<() => void> = [];

  postMessage(message: FakeWorker["posted"][number]): void {
    this.posted.push(message);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === "message") this.messageListeners.push(listener as (event: MessageEvent<ReviewWorkerResponse>) => void);
    if (type === "error") this.errorListeners.push(listener as () => void);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(response: ReviewWorkerResponse): void {
    for (const listener of this.messageListeners) listener({ data: response } as MessageEvent<ReviewWorkerResponse>);
  }

  crash(): void {
    for (const listener of this.errorListeners) listener();
  }

  get starts(): StartMessage[] {
    return this.posted.filter((message): message is StartMessage => message.type === "start");
  }

  get cancels(): number {
    return this.posted.filter((message) => message.type === "cancel").length;
  }

  /** The request id of the chunk this worker is currently running. */
  get currentId(): number {
    return this.starts.at(-1)!.id;
  }
}

const plyResult = (marker: number) => ({
  bestMove: "h2e2",
  playedMove: "h2e2",
  playedRank: 1,
  bestScore: { centipawns: marker, mateIn: null },
  playedScore: { centipawns: marker, mateIn: null },
  bestWinProbability: 0.5,
  playedWinProbability: 0.5,
  lossPercent: 0,
  classification: "good" as const,
  reason: null,
  candidates: [],
});
const pointFor = (marker: number): ReviewWorkerPoint => ({
  quick: plyResult(marker),
  final: plyResult(marker),
  deepened: false,
  continuationComplete: true,
});

function makePool(workerCount: number, updates: string[] = []) {
  const workers: FakeWorker[] = [];
  const pool = new ReviewWorkerPool(
    () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    workerCount,
    (state) => updates.push(`${state.status}:${state.points.length}`),
  );
  return { pool, workers, updates };
}

/** Worker reports the (whole-ply) result for one original ply and finishes its chunk. */
function finishPly(worker: FakeWorker, ply: number): void {
  const point = pointFor(ply);
  worker.respond({ id: worker.currentId, status: "point", pass: "quick", index: ply, point, continuationPending: false });
  const points: ReviewWorkerPoint[] = [];
  points[ply] = point;
  worker.respond({ id: worker.currentId, status: "complete", points });
}

const game = ["a", "b", "c", "d", "e"];

describe("reviewWorkerCount", () => {
  it("uses cores minus one, clamped to 1..4", () => {
    expect(reviewWorkerCount(16, "")).toBe(4);
    expect(reviewWorkerCount(4, "")).toBe(3);
    expect(reviewWorkerCount(2, "")).toBe(1);
    expect(reviewWorkerCount(1, "")).toBe(1);
    expect(reviewWorkerCount(undefined, "")).toBe(1);
  });

  it("lets ?review-workers=N override with 1..8 and ignores bad values", () => {
    expect(reviewWorkerCount(16, "?review-workers=8")).toBe(8);
    expect(reviewWorkerCount(2, "?review-workers=4")).toBe(4);
    expect(reviewWorkerCount(16, "?review-workers=1")).toBe(1);
    expect(reviewWorkerCount(16, "?review-workers=9")).toBe(4);
    expect(reviewWorkerCount(16, "?review-workers=0")).toBe(4);
    expect(reviewWorkerCount(16, "?review-workers=abc")).toBe(4);
    expect(reviewWorkerCount(16, "?review-workers=2.5")).toBe(4);
  });
});

describe("ReviewWorkerPool", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("with one worker runs the whole game in one ordinary session", () => {
    const { pool, workers } = makePool(1);
    pool.start(game, 5000);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.starts[0]!.indices).toBeUndefined();
    expect(workers[0]!.starts[0]!.moves).toEqual(game);
  });

  it("never opens more workers than there are plies and hands out one ply at a time", () => {
    const { pool, workers } = makePool(4);
    pool.start(["a", "b"], 5000);
    expect(workers).toHaveLength(2);
    expect(workers.map((worker) => worker.starts[0]!.indices)).toEqual([[0], [1]]);
  });

  it("gives the next ply to whichever worker finishes first", () => {
    const { pool, workers } = makePool(3);
    pool.start(game, 5000);
    expect(workers.map((worker) => worker.starts.map((start) => start.indices))).toEqual([[[0]], [[1]], [[2]]]);
    finishPly(workers[1]!, 1);
    expect(workers[1]!.starts.map((start) => start.indices)).toEqual([[1], [3]]);
    finishPly(workers[0]!, 0);
    expect(workers[0]!.starts.map((start) => start.indices)).toEqual([[0], [4]]);
    finishPly(workers[2]!, 2);
    expect(workers[2]!.starts).toHaveLength(1);
  });

  it("tags every worker's request with the one overall job id", () => {
    const { pool, workers } = makePool(3);
    const id = pool.start(game, 5000);
    expect(pool.state?.id).toBe(id);
    for (const worker of workers) expect(worker.starts[0]!.jobId).toBe(id);
    finishPly(workers[0]!, 0);
    expect(workers[0]!.starts[1]!.jobId).toBe(id);
  });

  it("shows only the in-order prefix of points, then reveals later ones as the gap closes", () => {
    const { pool, workers } = makePool(3);
    pool.start(game, 5000);
    workers[2]!.respond({ id: workers[2]!.currentId, status: "point", pass: "quick", index: 2, point: pointFor(2), continuationPending: false });
    expect(pool.state?.points).toHaveLength(0);
    workers[0]!.respond({ id: workers[0]!.currentId, status: "point", pass: "quick", index: 0, point: pointFor(0), continuationPending: false });
    expect(pool.state?.points).toHaveLength(1);
    workers[1]!.respond({ id: workers[1]!.currentId, status: "point", pass: "quick", index: 1, point: pointFor(1), continuationPending: false });
    expect(pool.state?.points.map((point) => point.quick.bestScore.centipawns)).toEqual([0, 1, 2]);
  });

  it("completes only after every ply has arrived, with points in game order", () => {
    const updates: string[] = [];
    const { pool, workers } = makePool(2, updates);
    pool.start(game, 5000);
    finishPly(workers[1]!, 1);
    finishPly(workers[1]!, 2);
    finishPly(workers[1]!, 3);
    expect(pool.state?.status).toBe("running");
    finishPly(workers[0]!, 0);
    expect(pool.state?.status).toBe("running");
    finishPly(workers[1]!, 4);
    expect(pool.state?.status).toBe("complete");
    expect(pool.state?.points.map((point) => point.quick.bestScore.centipawns)).toEqual([0, 1, 2, 3, 4]);
    expect(updates.filter((entry) => entry.startsWith("complete"))).toEqual(["complete:5"]);
  });

  it("fails the whole job and stops the other workers when one worker fails", () => {
    const { pool, workers } = makePool(3);
    pool.start(game, 5000);
    workers[1]!.respond({ id: workers[1]!.currentId, status: "failed", error: "reviewFailed", points: [] });
    expect(pool.state).toMatchObject({ status: "failed", error: "reviewFailed" });
    expect(workers.every((worker) => worker.terminated)).toBe(true);
    // Late results from the other workers neither revive nor complete the job.
    finishPly(workers[0]!, 0);
    expect(pool.state?.status).toBe("failed");
    expect(workers[0]!.starts).toHaveLength(1);
  });

  it("fails the whole job when a worker crashes", () => {
    const { pool, workers } = makePool(2);
    pool.start(game, 5000);
    workers[0]!.crash();
    expect(pool.state).toMatchObject({ status: "failed", error: "workerFailed" });
    expect(workers[1]!.terminated).toBe(true);
  });

  it("cancel stops every running worker and reports cancelled once all have stopped", () => {
    const { pool, workers } = makePool(3);
    pool.start(game, 5000);
    workers[0]!.respond({ id: workers[0]!.currentId, status: "point", pass: "quick", index: 0, point: pointFor(0), continuationPending: false });
    pool.cancel();
    for (const worker of workers) {
      expect(worker.cancels).toBe(1);
      expect(worker.posted.at(-1)).toEqual({ type: "cancel", id: worker.currentId });
    }
    workers[0]!.respond({ id: workers[0]!.currentId, status: "cancelled", points: [pointFor(0)] });
    workers[1]!.respond({ id: workers[1]!.currentId, status: "cancelled", points: [] });
    expect(pool.state?.status).toBe("running");
    workers[2]!.respond({ id: workers[2]!.currentId, status: "cancelled", points: [] });
    expect(pool.state?.status).toBe("cancelled");
    expect(pool.state?.points).toHaveLength(1);
  });

  it("terminates workers that are still inside a search once the cancel grace period ends", () => {
    const { pool, workers } = makePool(3);
    pool.start(game, 5000);
    workers[0]!.respond({ id: workers[0]!.currentId, status: "point", pass: "quick", index: 0, point: pointFor(0), continuationPending: false });
    pool.cancel();
    workers[1]!.respond({ id: workers[1]!.currentId, status: "cancelled", points: [] });
    vi.advanceTimersByTime(CANCEL_GRACE_MS - 1);
    expect(pool.state?.status).toBe("running");
    vi.advanceTimersByTime(1);
    expect(pool.state).toMatchObject({ status: "cancelled", activeWorkers: 0 });
    expect(pool.state?.points).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers[2]!.terminated).toBe(true);
  });

  it("marks a terminated worker's pending continuation as cancelled, like a normal cancel", () => {
    const { pool, workers } = makePool(2);
    pool.start(game, 5000);
    const worker = workers[0]!;
    const point = pointFor(0);
    const pendingCandidate = { ...plyResult(0).candidates, move: "h2e2", continuationStatus: "pending" };
    const pending = (result: typeof point.quick) => ({ ...result, candidates: [pendingCandidate] as unknown as typeof result.candidates });
    const withPending = { ...point, quick: pending(point.quick), final: pending(point.final), continuationComplete: false };
    worker.respond({ id: worker.currentId, status: "point", pass: "quick", index: 0, point: withPending, continuationPending: true });
    pool.cancel();
    vi.advanceTimersByTime(CANCEL_GRACE_MS);
    expect(worker.terminated).toBe(true);
    const kept = pool.state!.points[0]!;
    expect(kept.quick.candidates[0]!.continuationStatus).toBe("cancelled");
    expect(kept.final.candidates[0]!.continuationStatus).toBe("cancelled");
  });

  it("ignores a second cancel: no new timer and the grace period is not restarted", () => {
    const { pool, workers } = makePool(2);
    pool.start(game, 5000);
    pool.cancel();
    vi.advanceTimersByTime(CANCEL_GRACE_MS - 100);
    pool.cancel();
    expect(workers[0]!.cancels).toBe(1);
    vi.advanceTimersByTime(100);
    expect(pool.state?.status).toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("terminates still-busy workers of the old review when a new review starts", () => {
    const { pool, workers } = makePool(2);
    pool.start(game, 5000);
    pool.start(game, 5000);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers[1]!.terminated).toBe(true);
    expect(workers).toHaveLength(4);
    expect(workers[2]!.starts[0]!.indices).toEqual([0]);
    expect(workers[3]!.starts[0]!.indices).toEqual([1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps only the in-order prefix on cancel when ply 3 is missing but ply 4 arrived", () => {
    const { pool, workers } = makePool(5);
    pool.start(game, 5000);
    for (const ply of [0, 1, 2, 4]) finishPly(workers[ply]!, ply);
    expect(pool.state?.points).toHaveLength(3);
    pool.cancel();
    vi.advanceTimersByTime(CANCEL_GRACE_MS);
    expect(pool.state?.status).toBe("cancelled");
    expect(pool.state?.points).toHaveLength(3);
    expect(workers[3]!.terminated).toBe(true);
  });

  it("opens fresh workers for the next review after a forced cancel", () => {
    const { pool, workers } = makePool(2);
    pool.start(game, 5000);
    pool.cancel();
    vi.advanceTimersByTime(CANCEL_GRACE_MS);
    expect(workers).toHaveLength(2);
    pool.start(game, 5000);
    expect(workers).toHaveLength(4);
    expect(workers[2]!.starts[0]!.indices).toEqual([0]);
    expect(pool.state).toMatchObject({ status: "running", workerCount: 2 });
  });

  it("does not hand out more plies after cancel, even if a worker finishes first", () => {
    const { pool, workers } = makePool(2);
    pool.start(game, 5000);
    pool.cancel();
    finishPly(workers[0]!, 0);
    expect(workers[0]!.starts).toHaveLength(1);
    workers[1]!.respond({ id: workers[1]!.currentId, status: "cancelled", points: [] });
    expect(pool.state?.status).toBe("cancelled");
  });

  it("terminates every worker on dispose", () => {
    const { pool, workers } = makePool(3);
    pool.start(game, 5000);
    pool.dispose();
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  it("runs a focused re-analysis on a single worker and keeps the other points", () => {
    const { pool, workers } = makePool(2);
    pool.start(["a", "b"], 5000);
    finishPly(workers[0]!, 0);
    finishPly(workers[1]!, 1);
    expect(pool.state?.status).toBe("complete");
    pool.start(["a", "b"], 50_000, undefined, 1);
    expect(pool.state).toMatchObject({ status: "running", focusIndex: 1 });
    expect(pool.state?.points).toHaveLength(2);
    const focusWorker = workers.find((worker) => worker.starts.some((start) => start.focusIndex === 1))!;
    const replacement = pointFor(99);
    focusWorker.respond({ id: focusWorker.currentId, status: "complete", points: [replacement], focusIndex: 1 });
    expect(pool.state?.status).toBe("complete");
    expect(pool.state?.points[1]).toBe(replacement);
    expect(pool.state?.points[0]?.quick.bestScore.centipawns).toBe(0);
  });
});
