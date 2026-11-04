import type { ReviewWorkerPoint, ReviewWorkerRequest, ReviewWorkerResponse } from "./review-client";
import type { ReviewPvEnd } from "./review-client";

interface WasmReviewSession {
  step(): string;
  continue_step(): string;
  cancel(): string;
}

interface WasmModule {
  default: () => Promise<unknown>;
  ReviewWorkerSession: {
    new (startFen: string, moves: string, quickNodeLimit: number): WasmReviewSession;
    with_focus(startFen: string, moves: string, quickNodeLimit: number, focusIndex: number): WasmReviewSession;
    with_indices(startFen: string, moves: string, quickNodeLimit: number, indices: Uint32Array): WasmReviewSession;
  };
}

interface WorkerScope extends EventTarget {
  postMessage(message: ReviewWorkerResponse): void;
  readonly location: Location;
}

interface ReviewJob {
  id: number;
  /** Overall review job id (the pool's); stamped on replay audits so they name the whole review. */
  jobId: number;
  indices: number[] | undefined;
  startFen: string;
  moves: string[];
  quickNodeLimit: number;
  focusIndex: number | undefined;
  session: WasmReviewSession | null;
  points: ReviewWorkerPoint[];
  cancelRequestedAt: number | null;
  continuation: { index: number; pass: "quick" | "deep" } | null;
}

const scope = self as unknown as WorkerScope;
let modulePromise: Promise<WasmModule> | null = null;
let active: ReviewJob | null = null;
let latestId = 0;

async function initialize(): Promise<WasmModule> {
  if (!modulePromise) {
    const wasmUrl = new URL(`${import.meta.env.BASE_URL}wasm/xq_wasm.js`, scope.location.origin).href;
    modulePromise = import(/* @vite-ignore */ wasmUrl).then(async (module) => {
      const wasm = module as WasmModule;
      await wasm.default();
      return wasm;
    });
  }
  return modulePromise;
}

function publishTerminal(job: ReviewJob, status: "cancelled" | "complete"): void {
  if (active === job) active = null;
  scope.postMessage({
    id: job.id,
    status,
    points: job.points,
    ...(job.focusIndex === undefined ? {} : { focusIndex: job.focusIndex }),
    ...(status === "cancelled" && job.cancelRequestedAt !== null
      ? { cancelLatencyMs: performance.now() - job.cancelRequestedAt }
      : {}),
  });
}

function scheduleStep(job: ReviewJob): void {
  setTimeout(() => {
    if (active !== job || !job.session) return;
    try {
      const startedAt = performance.now();
      const event = JSON.parse(job.session.step()) as
        | { done: true }
        | { done: false; pass: "quick" | "deep"; index: number; point: ReviewWorkerPoint; continuationPending: boolean };
      if (event.done) {
        publishTerminal(job, "complete");
        return;
      }
      const prior = job.points[event.index];
      const point = event.pass === "deep" && prior
        ? { ...event.point, quick: prior.quick }
        : event.point;
      for (const result of [point.quick, point.final]) {
        for (const candidate of result.candidates) candidate.replayAudit.requestId = job.jobId;
      }
      if (!event.continuationPending) point.continuationComplete = true;
      job.points[event.index] = point;
      job.continuation = event.continuationPending ? { index: event.index, pass: event.pass } : null;
      scope.postMessage({
        id: job.id,
        status: "point",
        pass: event.pass,
        index: job.focusIndex ?? event.index,
        point,
        continuationPending: event.continuationPending,
        durationMs: performance.now() - startedAt,
      });
      if (event.continuationPending) scheduleContinuation(job);
      else scheduleStep(job);
    } catch (error) {
      console.error("review worker step failed", error);
      if (active !== job) return;
      active = null;
      scope.postMessage({
        id: job.id,
        status: "failed",
        error: "reviewFailed",
        points: job.points,
        ...(job.focusIndex === undefined ? {} : { focusIndex: job.focusIndex }),
      });
    }
  }, 0);
}

function scheduleContinuation(job: ReviewJob): void {
  setTimeout(() => {
    if (active !== job || !job.session || !job.continuation) return;
    const context = job.continuation;
    try {
      const startedAt = performance.now();
      const event = JSON.parse(job.session.continue_step()) as
        | { done: true }
        | { done: false; candidateIndex: number; segment: {
          move: string; depth: number; nodes: number; pvEnd: ReviewPvEnd;
        }; candidateComplete: boolean; continuationTerminal: boolean; continuationStatus: ReviewWorkerPoint["quick"]["candidates"][number]["continuationStatus"] };
      if (event.done) {
        const point = job.points[context.index];
        if (point) point.continuationComplete = true;
        job.continuation = null;
        scope.postMessage({
          id: job.id,
          status: "continuation-complete",
          pass: context.pass,
          index: job.focusIndex ?? context.index,
          durationMs: performance.now() - startedAt,
        });
        scheduleStep(job);
        return;
      }
      const point = job.points[context.index];
      const result = context.pass === "quick" ? point?.quick : point?.final;
      const candidate = result?.candidates[event.candidateIndex];
      if (!point || !candidate) throw new Error("missing continuation candidate");
      candidate.continuation.push(event.segment);
      candidate.continuationTerminal = event.continuationTerminal;
      candidate.continuationStatus = event.continuationStatus;
      if (context.pass === "quick" && !point.deepened) {
        const finalCandidate = point.final.candidates[event.candidateIndex];
        if (finalCandidate) {
          finalCandidate.continuation = [...candidate.continuation];
          finalCandidate.continuationTerminal = event.continuationTerminal;
          finalCandidate.continuationStatus = event.continuationStatus;
        }
      }
      scope.postMessage({
        id: job.id,
        status: "continuation",
        pass: context.pass,
        index: job.focusIndex ?? context.index,
        candidateIndex: event.candidateIndex,
        segment: event.segment,
        candidateComplete: event.candidateComplete,
        continuationTerminal: event.continuationTerminal,
        continuationStatus: event.continuationStatus,
        durationMs: performance.now() - startedAt,
      });
      scheduleContinuation(job);
    } catch (error) {
      console.error("review worker continuation failed", error);
      if (active !== job) return;
      active = null;
      scope.postMessage({
        id: job.id,
        status: "failed",
        error: "reviewFailed",
        points: job.points,
        ...(job.focusIndex === undefined ? {} : { focusIndex: job.focusIndex }),
      });
    }
  }, 0);
}

async function start(request: Extract<ReviewWorkerRequest, { type: "start" }>): Promise<void> {
  if (request.id < latestId) return;
  latestId = request.id;
  if (active) publishTerminal(active, "cancelled");
  const job: ReviewJob = {
    id: request.id,
    jobId: request.jobId ?? request.id,
    indices: request.indices,
    startFen: request.startFen,
    moves: request.moves,
    quickNodeLimit: request.quickNodeLimit,
    focusIndex: request.focusIndex,
    session: null,
    points: [],
    cancelRequestedAt: null,
    continuation: null,
  };
  active = job;
  try {
    const wasm = await initialize();
    if (active !== job) return;
    const movesText = job.moves.join(" ");
    if (job.focusIndex !== undefined) {
      job.session = wasm.ReviewWorkerSession.with_focus(job.startFen, movesText, job.quickNodeLimit, job.focusIndex);
    } else if (job.indices !== undefined) {
      job.session = wasm.ReviewWorkerSession.with_indices(
        job.startFen, movesText, job.quickNodeLimit, Uint32Array.from(job.indices),
      );
    } else {
      job.session = new wasm.ReviewWorkerSession(job.startFen, movesText, job.quickNodeLimit);
    }
    scheduleStep(job);
  } catch {
    if (active !== job) return;
    active = null;
    scope.postMessage({
      id: job.id,
      status: "failed",
      error: "reviewInitializationFailed",
      points: [],
      ...(job.focusIndex === undefined ? {} : { focusIndex: job.focusIndex }),
    });
  }
}

scope.addEventListener("message", ((event: MessageEvent<ReviewWorkerRequest>) => {
  const request = event.data;
  if (request.type === "start") {
    void start(request);
    return;
  }
  if (request.id !== latestId || active?.id !== request.id) return;
  active.cancelRequestedAt = performance.now();
  if (active.continuation) {
    const { index, pass } = active.continuation;
    const point = active.points[index];
    const result = pass === "quick" ? point?.quick : point?.final;
    for (const candidate of result?.candidates ?? []) {
      if (candidate.continuationStatus === "pending") candidate.continuationStatus = "cancelled";
    }
  }
  active.session?.cancel();
  publishTerminal(active, "cancelled");
}) as EventListener);
