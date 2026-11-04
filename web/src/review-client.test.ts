import { describe, expect, it } from "vitest";
import { ReviewWorkerClient, type ReviewWorkerResponse } from "./review-client";

class FakeWorker {
  posted: unknown[] = [];
  private listeners: Array<(event: MessageEvent<ReviewWorkerResponse>) => void> = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === "message") this.listeners.push(listener as (event: MessageEvent<ReviewWorkerResponse>) => void);
  }

  respond(response: ReviewWorkerResponse): void {
    for (const listener of this.listeners) listener({ data: response } as MessageEvent<ReviewWorkerResponse>);
  }

  terminate(): void {}
}

const emptyPly = {
  bestMove: "h2e2",
  playedMove: "h2e2",
  playedRank: 1,
  bestScore: { centipawns: 0, mateIn: null },
  playedScore: { centipawns: 0, mateIn: null },
  bestWinProbability: 0.5,
  playedWinProbability: 0.5,
  lossPercent: 0,
  classification: "good" as const,
  reason: null,
  candidates: [],
};
const emptyPoint = { quick: emptyPly, final: emptyPly, deepened: false, continuationComplete: true };

describe("ReviewWorkerClient", () => {
  it("ignores stale results after a new request and preserves completed points on cancel", () => {
    const worker = new FakeWorker();
    const updates: string[] = [];
    const client = new ReviewWorkerClient(worker as unknown as Worker, (state) => updates.push(state.status));
    const first = client.start(["h2e2", "h9g7"]);
    worker.respond({ id: first, status: "point", pass: "quick", index: 0, point: emptyPoint, continuationPending: false });

    const second = client.start(["h2e2"]);
    worker.respond({ id: first, status: "complete", points: [emptyPoint] });
    expect(client.state).toMatchObject({ id: second, status: "running", points: [] });

    worker.respond({ id: second, status: "point", pass: "quick", index: 0, point: emptyPoint, continuationPending: false });
    client.cancel();
    expect(worker.posted.at(-1)).toEqual({ id: second, type: "cancel" });
    worker.respond({ id: second, status: "cancelled", points: [emptyPoint] });
    expect(client.state).toMatchObject({ id: second, status: "cancelled", points: [emptyPoint] });
    expect(updates).toEqual(["running", "running", "running", "running", "cancelled"]);
  });

  it("keeps the original short PV separate while incremental continuation events complete it", () => {
    const worker = new FakeWorker();
    const client = new ReviewWorkerClient(worker as unknown as Worker);
    const point = {
      quick: { ...emptyPly, candidates: [{
        move: "b2b5", score: { centipawns: 0, mateIn: null }, pv: ["b2b5", "h7g7", "h2c2"],
        depth: 3, nodes: 69_813, pvEnd: "depth_limit" as const, continuation: [], continuationNodeLimit: 20_000,
        continuationTerminal: false,
        replayAudit: {},
        continuationStatus: "pending" as const,
      }] },
      final: emptyPly,
      deepened: false,
      continuationComplete: false,
    };
    const id = client.start(["h2e2"]);
    worker.respond({ id, status: "point", pass: "quick", index: 0, point, continuationPending: true, durationMs: 30 });
    worker.respond({ id, status: "continuation", pass: "quick", index: 0, candidateIndex: 0,
      segment: { move: "b2c2", depth: 2, nodes: 6_000, pvEnd: "depth_limit" }, candidateComplete: false,
      continuationTerminal: false, continuationStatus: "pending", durationMs: 15 });
    const partial = client.state!.points[0];
    expect(partial.quick.candidates[0].pv).toHaveLength(3);
    expect(partial.quick.candidates[0].continuation).toHaveLength(1);
    expect(partial.quick.candidates[0].continuationTerminal).toBe(false);
    expect(partial.quick.candidates[0].continuationStatus).toBe("pending");
    expect(partial.continuationComplete).toBe(false);

    worker.respond({ id, status: "continuation-complete", pass: "quick", index: 0, durationMs: 2 });
    expect(client.state!.points[0].continuationComplete).toBe(true);
    expect(client.state!.lastStepDurationMs).toBe(2);
  });

  it("deepens only the selected ply and keeps the other completed review points", () => {
    const worker = new FakeWorker();
    const client = new ReviewWorkerClient(worker as unknown as Worker);
    const moves = ["h2e2", "h9g7"];
    const first = client.start(moves);
    const pointZero = { ...emptyPoint, quick: { ...emptyPly, playedMove: "h2e2" } };
    const pointOne = { ...emptyPoint, quick: { ...emptyPly, playedMove: "h9g7" } };
    worker.respond({ id: first, status: "point", pass: "quick", index: 0, point: pointZero, continuationPending: false });
    worker.respond({ id: first, status: "point", pass: "quick", index: 1, point: pointOne, continuationPending: false });

    const deeperPoint = {
      ...pointOne,
      final: { ...emptyPly, playedMove: "h9g7", playedWinProbability: 0.62 },
      deepened: true,
    };
    const deepen = client.start(moves, 1_000_000, undefined, 1);
    expect(worker.posted.at(-1)).toMatchObject({ focusIndex: 1, quickNodeLimit: 1_000_000 });
    expect(client.state?.points).toEqual([pointZero, pointOne]);

    worker.respond({ id: deepen, status: "point", pass: "quick", index: 1, point: deeperPoint, continuationPending: false });
    expect(client.state?.points).toEqual([pointZero, pointOne]);
    worker.respond({ id: deepen, status: "complete", points: [deeperPoint], focusIndex: 1 });
    expect(client.state?.points).toEqual([pointZero, deeperPoint]);
  });

  it("keeps an optional typed reason from a worker point on the selected final result", () => {
    const worker = new FakeWorker();
    const client = new ReviewWorkerClient(worker as unknown as Worker);
    const id = client.start(["h2e2"]);
    const point = {
      ...emptyPoint,
      final: { ...emptyPly, classification: "missed_mate" as const, reason: { kind: "missed_mate" as const, moves: 2 } },
    };
    worker.respond({ id, status: "point", pass: "quick", index: 0, point, continuationPending: false });
    expect(client.state?.points[0].final.reason).toEqual({ kind: "missed_mate", moves: 2 });
  });
});
