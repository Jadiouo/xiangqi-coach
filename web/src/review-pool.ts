import { ReviewWorkerClient, type ReviewJobState, type ReviewWorkerPoint } from "./review-client";
import type { ReviewResultCache } from "./review-cache";

/**
 * After a cancel request, workers get this long to stop at their next step boundary (which keeps
 * the point they were on). A deep search step can run for many seconds, so any worker that has not
 * stopped by then is terminated and replaced on the next start; cancelling never waits on a search.
 */
export const CANCEL_GRACE_MS = 1_000;

const STANDARD_START = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";

function cancelPendingContinuations(point: ReviewWorkerPoint): ReviewWorkerPoint {
  const fix = (result: ReviewWorkerPoint["quick"]): ReviewWorkerPoint["quick"] => ({
    ...result,
    candidates: result.candidates.map((candidate) =>
      candidate.continuationStatus === "pending" ? { ...candidate, continuationStatus: "cancelled" as const } : candidate,
    ),
  });
  return { ...point, quick: fix(point.quick), final: fix(point.final) };
}

/** A cached point as a fresh computation in job `jobId` would return it: replay audits name the job. */
function withRequestId(point: ReviewWorkerPoint, jobId: number): ReviewWorkerPoint {
  const stamp = (result: ReviewWorkerPoint["quick"]): ReviewWorkerPoint["quick"] => ({
    ...result,
    candidates: result.candidates.map((candidate) => ({
      ...candidate,
      replayAudit: { ...candidate.replayAudit, requestId: jobId },
    })),
  });
  return { ...point, quick: stamp(point.quick), final: stamp(point.final) };
}

interface PoolJob {
  id: number;
  moves: string[];
  quickNodeLimit: number;
  startFen: string;
  /** One worker runs the whole game as an ordinary session (one worker, focused run, empty game). */
  passthrough: boolean;
  /** Results of this job may be read from and written to the cache (not a focused single-ply run). */
  cacheable: boolean;
  slots: number;
  /** Plies not yet handed to a worker, in game order. */
  queue: number[];
  /** The plies each worker is analyzing now (consecutive, ascending), empty when it is idle. */
  slotPlies: number[][];
  /** How many consecutive plies one worker session takes at most. */
  chunk: number;
  /** Every ply result received so far, by original ply index (may have gaps). */
  received: ReviewWorkerPoint[];
  /** Plies answered from the cache for this job. */
  cachedPlies: number;
  /** True while the cache is being read; nothing has been handed to a worker yet. */
  lookingUp: boolean;
  cancelling: boolean;
  finished: boolean;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  cancelRequestedAt: number;
  lastStepDurationMs?: number;
  cancelLatencyMs?: number;
}

/**
 * Consecutive plies per worker session. Neighbouring plies in one session search each shared
 * position once instead of twice, so longer runs save more; but a run is also the unit of balance,
 * so it stays small compared with the share each worker gets (about a third of it, at most 6) and
 * short games keep one ply per session.
 */
export function reviewChunkSize(missingPlies: number, workers: number): number {
  return Math.max(1, Math.min(6, Math.floor(missingPlies / (Math.max(1, workers) * 3))));
}

/**
 * Runs one review on several workers and presents it as one job.
 *
 * Plies are handed out in game order, a short run of consecutive plies at a time (`reviewChunkSize`,
 * one ply for short games), to whichever worker is free (a dynamic queue). A ply costs anywhere from
 * a quick search to quick + 3x deep + continuation, so fixed slices would leave workers idle behind
 * the slice with the hard positions. Each run is its own two-pass session (`indices: [...]`). A ply's
 * result does not depend on which plies share its session (the search after one ply is the search
 * before the next, with the same input either way), so the results equal a one-worker run.
 *
 * `state.points` only ever holds the in-order prefix of finished plies, so callers can treat it
 * as growing from the first move exactly as with a single worker. The job completes only when
 * every ply has arrived.
 */
export class ReviewWorkerPool {
  /** One client (and worker) per slot; a slot is empty after its worker was terminated. */
  private readonly clients: Array<ReviewWorkerClient | undefined> = [];
  private nextId = 1;
  private job: PoolJob | null = null;
  private _state: ReviewJobState | null = null;

  constructor(
    private readonly createWorker: () => Worker,
    private readonly workerCount: number,
    private readonly onUpdate: (state: ReviewJobState) => void = () => {},
    /** Finished plies are read from and written to this; absent means every review computes everything. */
    private readonly cache?: ReviewResultCache,
  ) {}

  get state(): ReviewJobState | null {
    return this._state;
  }

  start(
    moves: string[],
    quickNodeLimit = 5_000,
    startFen = STANDARD_START,
    focusIndex?: number,
  ): number {
    const id = this.nextId++;
    const previous = this.job;
    if (previous) {
      // A new review must not wait for an old worker to finish a search step: stop busy ones outright.
      if (!previous.finished) {
        previous.slotPlies.forEach((plies, slot) => {
          if (plies.length > 0) this.terminate(slot);
        });
      }
      previous.finished = true;
    }
    const job: PoolJob = {
      id,
      moves,
      quickNodeLimit,
      startFen,
      passthrough: false,
      cacheable: this.cache !== undefined && focusIndex === undefined,
      slots: 1,
      queue: [],
      slotPlies: [],
      chunk: 1,
      received: [],
      cachedPlies: 0,
      lookingUp: false,
      cancelling: false,
      finished: false,
      cancelTimer: null,
      cancelRequestedAt: 0,
    };
    this.job = job;
    if (previous) this.clearTimer(previous);
    if (this.cache && job.cacheable && moves.length > 0) {
      // Ask the cache first; the workers only get the plies it cannot answer.
      job.lookingUp = true;
      this.emit(job, "running");
      const begin = (hits: Map<number, ReviewWorkerPoint>) => {
        if (this.job !== job || job.finished) return;
        job.lookingUp = false;
        this.begin(job, focusIndex, hits);
      };
      this.cache.lookup(startFen, moves, quickNodeLimit).then(begin, () => begin(new Map()));
      return id;
    }
    this.begin(job, focusIndex, new Map());
    return id;
  }

  /** Cached plies count as finished; the workers get the rest (or the whole game if nothing hit). */
  private begin(job: PoolJob, focusIndex: number | undefined, hits: Map<number, ReviewWorkerPoint>): void {
    const { moves } = job;
    for (const [ply, point] of hits) {
      if (ply >= 0 && ply < moves.length) job.received[ply] = withRequestId(point, job.id);
    }
    job.cachedPlies = job.received.filter(Boolean).length;
    const misses = moves.map((_, ply) => ply).filter((ply) => !job.received[ply]);
    if (job.cachedPlies > 0 && misses.length === 0) {
      job.finished = true;
      this.emit(job, "complete");
      return;
    }
    const slots = Math.max(1, Math.min(this.workerCount, misses.length));
    // One worker with nothing cached runs the whole game as an ordinary session; with cached plies
    // it works through just the missing ones like any pool slot.
    const passthrough = focusIndex !== undefined || (slots === 1 && job.cachedPlies === 0);
    job.passthrough = passthrough;
    job.slots = passthrough ? 1 : slots;
    job.queue = passthrough ? [] : misses;
    job.chunk = reviewChunkSize(misses.length, job.slots);
    for (let slot = 0; slot < job.slots; slot += 1) this.ensureClient(slot);
    // Workers left over from a bigger previous job stop; their updates are ignored from here on.
    for (let slot = job.slots; slot < this.clients.length; slot += 1) this.clients[slot]?.cancel();
    if (passthrough) {
      const basePoints = this._state?.points ?? [];
      job.slotPlies = [[]];
      this.client(0).start(moves, job.quickNodeLimit, job.startFen, focusIndex, { jobId: job.id, basePoints });
      return;
    }
    job.slotPlies = Array.from({ length: job.slots }, () => [] as number[]);
    this.emit(job, "running");
    for (let slot = 0; slot < job.slots; slot += 1) this.dispatch(job, slot);
  }

  cancel(): void {
    const job = this.job;
    if (!job || job.finished || this._state?.status !== "running") return;
    if (job.cancelling) return;
    if (job.lookingUp) {
      // Nothing has been handed to a worker yet, so there is nothing to stop.
      job.lookingUp = false;
      job.finished = true;
      this.emit(job, "cancelled");
      return;
    }
    if (job.passthrough) {
      this.client(0).cancel();
      return;
    }
    job.cancelling = true;
    job.cancelRequestedAt = Date.now();
    this.cancelBusy(job);
    job.cancelTimer = setTimeout(() => this.forceCancel(job), CANCEL_GRACE_MS);
  }

  dispose(): void {
    if (this.job) {
      this.job.finished = true;
      this.clearTimer(this.job);
    }
    for (let slot = 0; slot < this.clients.length; slot += 1) this.terminate(slot);
    this.clients.length = 0;
  }

  private client(slot: number): ReviewWorkerClient {
    return this.ensureClient(slot);
  }

  private ensureClient(slot: number): ReviewWorkerClient {
    let client = this.clients[slot];
    if (!client) {
      client = new ReviewWorkerClient(this.createWorker(), (state) => this.onClientUpdate(slot, state));
      this.clients[slot] = client;
    }
    return client;
  }

  private terminate(slot: number): void {
    this.clients[slot]?.dispose();
    this.clients[slot] = undefined;
  }

  private clearTimer(job: PoolJob): void {
    if (job.cancelTimer !== null) clearTimeout(job.cancelTimer);
    job.cancelTimer = null;
  }

  /** Cancel grace ran out: terminate the workers still inside a search and report cancelled. */
  private forceCancel(job: PoolJob): void {
    job.cancelTimer = null;
    if (job.finished || this.job !== job) return;
    job.slotPlies.forEach((plies, slot) => {
      if (plies.length === 0) return;
      this.terminate(slot);
      // Same end state as a normal cancel: a continuation cut off mid-way is "cancelled", not "pending".
      for (const ply of plies) {
        const point = job.received[ply];
        if (point) job.received[ply] = cancelPendingContinuations(point);
      }
    });
    job.slotPlies = job.slotPlies.map(() => []);
    job.finished = true;
    job.cancelLatencyMs = Date.now() - job.cancelRequestedAt;
    this.emit(job, "cancelled");
  }

  private dispatch(job: PoolJob, slot: number): void {
    const first = job.queue.shift();
    if (first === undefined) return;
    // Neighbouring plies in one session share the search between them; a gap (a cached ply) ends the run.
    const plies = [first];
    while (plies.length < job.chunk && job.queue[0] === plies[plies.length - 1]! + 1) {
      plies.push(job.queue.shift()!);
    }
    job.slotPlies[slot] = plies;
    this.client(slot).start(job.moves, job.quickNodeLimit, job.startFen, undefined, {
      indices: plies,
      jobId: job.id,
    });
  }

  private cancelBusy(job: PoolJob): void {
    job.slotPlies.forEach((plies, slot) => {
      if (plies.length > 0) this.clients[slot]?.cancel();
    });
  }

  private busy(job: PoolJob): number {
    return job.slotPlies.filter((plies) => plies.length > 0).length;
  }

  private onClientUpdate(slot: number, state: ReviewJobState): void {
    const job = this.job;
    if (!job || job.finished || slot >= job.slots) return;
    if (job.passthrough) {
      const terminal = state.status !== "running";
      if (terminal) job.finished = true;
      if (state.status === "complete" && job.cacheable && state.points.length === job.moves.length) {
        this.saveToCache(job, state.points.map((point, ply) => ({ ply, point })));
      }
      this.publish({ ...state, id: job.id, workerCount: 1, activeWorkers: terminal ? 0 : 1 });
      return;
    }
    const plies = job.slotPlies[slot];
    if (plies === undefined || plies.length === 0) return;
    if (state.lastStepDurationMs !== undefined) job.lastStepDurationMs = state.lastStepDurationMs;
    if (state.cancelLatencyMs !== undefined) {
      job.cancelLatencyMs = Math.max(job.cancelLatencyMs ?? 0, state.cancelLatencyMs);
    }
    for (const ply of plies) {
      const point = state.points[ply];
      if (point) job.received[ply] = point;
    }
    if (state.status === "running") {
      this.emit(job, "running");
      return;
    }
    if (state.status === "failed") {
      job.finished = true;
      this.clearTimer(job);
      // Stop everything at once; a failed review keeps only what had already arrived.
      for (let other = 0; other < job.slots; other += 1) this.terminate(other);
      job.slotPlies = job.slotPlies.map(() => []);
      this.emit(job, "failed", state.error ?? "reviewFailed");
      return;
    }
    job.slotPlies[slot] = [];
    if (job.cancelling || state.status === "cancelled") {
      if (this.busy(job) === 0) {
        job.finished = true;
        this.clearTimer(job);
        this.emit(job, "cancelled");
      } else {
        this.emit(job, "running");
      }
      return;
    }
    // This worker's session ended normally, so the plies it analyzed are final.
    const finished = plies.flatMap((ply) => (job.received[ply] ? [{ ply, point: job.received[ply]! }] : []));
    if (finished.length > 0) this.saveToCache(job, finished);
    this.dispatch(job, slot);
    if (this.busy(job) === 0) {
      job.finished = true;
      this.emit(job, job.received.filter(Boolean).length === job.moves.length ? "complete" : "failed", "reviewFailed");
      return;
    }
    this.emit(job, "running");
  }

  private saveToCache(job: PoolJob, entries: Array<{ ply: number; point: ReviewWorkerPoint }>): void {
    if (!this.cache || !job.cacheable) return;
    // Fire and forget: a slow or failing cache must never hold up the review (save never rejects).
    void this.cache.save(job.startFen, job.moves, job.quickNodeLimit, entries);
  }

  private emit(job: PoolJob, status: ReviewJobState["status"], error?: string): void {
    const points: ReviewWorkerPoint[] = [];
    for (let ply = 0; job.received[ply]; ply += 1) points.push(job.received[ply]!);
    this.publish({
      id: job.id,
      status,
      points,
      workerCount: job.slots,
      activeWorkers: this.busy(job),
      ...(job.cachedPlies > 0 ? { cachedPlies: job.cachedPlies } : {}),
      ...(job.lastStepDurationMs === undefined ? {} : { lastStepDurationMs: job.lastStepDurationMs }),
      ...(status === "cancelled" && job.cancelLatencyMs !== undefined ? { cancelLatencyMs: job.cancelLatencyMs } : {}),
      ...(status === "failed" ? { error: error ?? "reviewFailed" } : {}),
    });
  }

  private publish(state: ReviewJobState): void {
    this._state = state;
    this.onUpdate(state);
  }
}
