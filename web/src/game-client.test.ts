import { describe, expect, it } from "vitest";
import { GameWorkerClient, LatestGameState, LiveEvaluationGate, type GameSnapshot, type WorkerResponse } from "./game-client";

class FakeWorker {
  posted: unknown[] = [];
  private messageListeners: Array<(event: MessageEvent<WorkerResponse>) => void> = [];
  private errorListeners: Array<(event: ErrorEvent) => void> = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === "message") this.messageListeners.push(listener as (event: MessageEvent<WorkerResponse>) => void);
    if (type === "error") this.errorListeners.push(listener as (event: ErrorEvent) => void);
  }

  respond(response: WorkerResponse): void {
    for (const listener of this.messageListeners) listener({ data: response } as MessageEvent<WorkerResponse>);
  }

  fail(message: string): void {
    for (const listener of this.errorListeners) listener({ message } as ErrorEvent);
  }
}

const snapshot: GameSnapshot = {
  board: ".".repeat(90),
  fen: "fixture fen",
  startFen: "fixture root fen",
  side: "black",
  legalMoves: [],
  history: [],
  lastMove: "h2e2",
  outcome: "ongoing",
  lastAiLevel: 0,
};

describe("GameWorkerClient", () => {
  it("correlates out-of-order responses with monotonically numbered requests", async () => {
    const worker = new FakeWorker();
    const client = new GameWorkerClient(worker as unknown as Worker);
    const first = client.request({ type: "init" });
    const second = client.request({ type: "move", move: "h2e2", difficultyLevel: 10 });

    expect(worker.posted).toEqual([
      { id: 1, type: "init" },
      { id: 2, type: "move", move: "h2e2", difficultyLevel: 10 },
    ]);
    worker.respond({ id: 2, ok: true, state: snapshot });
    worker.respond({ id: 1, ok: true, state: { ...snapshot, side: "red" } });
    await expect(second.promise).resolves.toMatchObject({ state: snapshot });
    await expect(first.promise).resolves.toMatchObject({ state: { side: "red" } });
  });

  it("passes operation failures and worker startup errors to callers", async () => {
    const worker = new FakeWorker();
    const client = new GameWorkerClient(worker as unknown as Worker);
    const invalidMove = client.request({ type: "move", move: "h2h8", difficultyLevel: 10 });
    const recoverableError: WorkerResponse = {
      id: invalidMove.id,
      ok: false,
      error: "invalidMove",
      state: snapshot,
    };
    worker.respond(recoverableError);
    await expect(invalidMove.promise).resolves.toEqual(recoverableError);

    const pending = client.request({ type: "init" });
    worker.fail("WASM initialization failed");
    await expect(pending.promise).rejects.toThrow("workerFailed");
  });

  it("resynchronizes from the newest error state after discarding an older success", async () => {
    const worker = new FakeWorker();
    const client = new GameWorkerClient(worker as unknown as Worker);
    const latestState = new LatestGameState();
    const move = client.request({ type: "move", move: "h2e2", difficultyLevel: 10 });
    latestState.track(move.id);
    const invalidMove = client.request({ type: "move", move: "h2h8", difficultyLevel: 10 });
    latestState.track(invalidMove.id);

    const successfulMove = { id: move.id, ok: true, state: snapshot } as const;
    worker.respond(successfulMove);
    const olderResponse = await move.promise;
    expect(latestState.accept(olderResponse)).toBe(false);

    const recoverableError: WorkerResponse = {
      id: invalidMove.id,
      ok: false,
      error: "invalidMove",
      state: { ...snapshot, fen: "authoritative worker state" },
    };
    worker.respond(recoverableError);
    const latestResponse = await invalidMove.promise;
    expect(latestState.accept(latestResponse)).toBe(true);
    expect(latestState.current?.fen).toBe("authoritative worker state");
  });

  it("fails fast and stops posting commands after a terminal worker error", async () => {
    const worker = new FakeWorker();
    const client = new GameWorkerClient(worker as unknown as Worker);
    const init = client.request({ type: "init" });
    worker.respond({ id: init.id, ok: true, state: snapshot });
    await init.promise;

    worker.fail("uncaught worker exception");
    const postedBeforeFailure = worker.posted.length;
    const afterFailure = client.request({ type: "move", move: "h2e2", difficultyLevel: 10 });
    const result = await Promise.race([
      afterFailure.promise.then(() => "resolved", (error: Error) => error.message),
      new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 0)),
    ]);

    expect(result).toBe("workerFailed");
    expect(worker.posted).toHaveLength(postedBeforeFailure);
  });
});

describe("player-moved early snapshot", () => {
  it("hands the intermediate position to the caller without resolving the request", async () => {
    const worker = new FakeWorker();
    const early: Array<{ id: number; fen: string }> = [];
    const client = new GameWorkerClient(
      worker as unknown as Worker, () => {}, () => {}, () => {},
      (id, state) => early.push({ id, fen: state.fen }),
    );
    const move = client.request({ type: "move", move: "h2e2", difficultyLevel: 5 });
    let settled = false;
    void move.promise.then(() => { settled = true; });
    worker.respond({ id: move.id, status: "player-moved", state: { ...snapshot, fen: "after user move" } });
    await Promise.resolve();
    expect(early).toEqual([{ id: move.id, fen: "after user move" }]);
    expect(settled).toBe(false);
    worker.respond({ id: move.id, ok: true, state: snapshot });
    await expect(move.promise).resolves.toMatchObject({ ok: true });
  });

  it("LatestGameState shows the early position only for the current request", () => {
    const state = new LatestGameState();
    state.track(3);
    expect(state.showEarly(2, { ...snapshot, fen: "stale" })).toBe(false);
    expect(state.current).toBeNull();
    expect(state.showEarly(3, { ...snapshot, fen: "fresh" })).toBe(true);
    expect(state.current?.fen).toBe("fresh");
  });
});

describe("LiveEvaluationGate", () => {
  it("accepts only the newest evaluation request for the position on the board", () => {
    const gate = new LiveEvaluationGate();
    gate.begin(4);
    expect(gate.accepts(4, "fen A", "fen A")).toBe(true);
    expect(gate.accepts(4, "fen A", "fen B")).toBe(false);
    gate.begin(5);
    expect(gate.accepts(4, "fen A", "fen A")).toBe(false);
    expect(gate.accepts(5, "fen B", "fen B")).toBe(true);
    expect(gate.accepts(5, "fen B", undefined)).toBe(false);
  });

  it("drops everything after clear", () => {
    const gate = new LiveEvaluationGate();
    gate.begin(1);
    gate.clear();
    expect(gate.accepts(1, "fen A", "fen A")).toBe(false);
  });
});
