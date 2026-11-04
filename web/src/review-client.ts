export interface ReviewPlyResult {
  bestMove: string;
  playedMove: string;
  playedRank: number | null;
  bestScore: { centipawns: number; mateIn: number | null };
  playedScore: { centipawns: number; mateIn: number | null };
    bestWinProbability: number;
    playedWinProbability: number;
    lossPercent: number;
    classification: ReviewClassification;
    reason?: ReviewReason | null;
    /** Played-versus-best lines for marked moves; absent in old saves, null when not marked. */
    comparison?: ReviewComparison | null;
  candidates: Array<{
    move: string;
    score: { centipawns: number; mateIn: number | null };
    pv: string[];
    depth: number;
    nodes: number;
    pvEnd: ReviewPvEnd;
    continuation: Array<{ move: string; depth: number; nodes: number; pvEnd: ReviewPvEnd }>;
    continuationNodeLimit: number;
    continuationTerminal: boolean;
    replayAudit: Record<string, unknown>;
    continuationStatus: ReviewContinuationStatus;
  }>;
}

export interface ReviewLineStep {
  iccs: string;
  notation: string;
  side: "red" | "black";
  captured: { side: "red" | "black"; kind: "king" | "advisor" | "elephant" | "horse" | "rook" | "cannon" | "pawn" } | null;
}

export interface ReviewComparison {
  playedLine: ReviewLineStep[];
  bestLine: ReviewLineStep[];
  playedComplete: boolean;
  bestComplete: boolean;
  /** False when a capture is still on offer at the end of the line (absent in older data). */
  playedSettled?: boolean;
  bestSettled?: boolean;
}

export type ReviewPvEnd =
  | "terminal"
  | "depth_limit"
  | "transposition_cutoff"
  | "forced_move"
  | "no_completed_iteration";

export type ReviewContinuationStatus =
  | "pending"
  | "terminal"
  | "invalid_pv"
  | "invalid_continuation"
  | "no_result"
  | "cancelled"
  | "minimum_reached"
  | "complete"
  | "search_truncated";

export type ReviewClassification =
  | "unclassified"
  | "good"
  | "unique_move"
  | "inaccuracy"
  | "doubtful_move"
  | "mistake"
  | "blunder"
  | "missed_mate";

export type ReviewMaterialCapture = {
  piece: { side: "red" | "black"; kind: "king" | "advisor" | "elephant" | "horse" | "rook" | "cannon" | "pawn" };
  square: string;
  capturer: "red" | "black";
  ply: number;
};

export type ReviewMaterialEvidence = {
  mover: "red" | "black";
  bestNet: number;
  playedNet: number;
  plies: number;
  /** False when the exchange was still open at a line end; absent in older saves (= settled). */
  settled?: boolean;
  bestCaptures: ReviewMaterialCapture[];
  playedCaptures: ReviewMaterialCapture[];
};

export const REVIEW_REASON_KINDS = [
  "walked_into_mate",
  "missed_mate",
  "dropped_material",
  "missed_material",
  "sent_piece",
  "cannon_mount",
  "abandoned_protection",
  "check_capture",
  "position_type",
] as const;
export type ReviewReasonKind = (typeof REVIEW_REASON_KINDS)[number];

export type ReviewPiece = ReviewMaterialCapture["piece"];

export type ReviewProtectionEvidence = {
  piece: ReviewPiece;
  from: string;
  to: string;
  capturedAt: string;
  capturer: "red" | "black";
  attacker: ReviewPiece;
  net: number;
  protectedPiece: ReviewPiece | null;
  protectedSquare: string | null;
};

/** The moved piece became the screen an enemy cannon needs to capture `victim`. */
export type ReviewCannonMountEvidence = {
  screen: ReviewPiece;
  screenSquare: string;
  cannon: ReviewPiece;
  cannonFrom: string;
  victim: ReviewPiece;
  victimSquare: string;
  net: number;
};

export type ReviewCheckCaptureEvidence = {
  victim: ReviewPiece;
  victimSquare: string;
  attacker: ReviewPiece;
  attackerFrom: string;
  net: number;
};

export type ReviewPositionEvidence = {
  component: "material" | "position" | "mobility" | "king_safety";
  playedValue: number;
  bestValue: number;
  mobilityBefore: number;
  mobilityAfter: number;
  /** Mover's legal move count after the best move; absent in older saves. */
  mobilityAfterBest?: number;
};

export type ReviewReason =
  | {
      kind: "walked_into_mate" | "missed_mate";
      moves: number;
      material?: null;
    }
  | {
      kind: "dropped_material" | "missed_material";
      moves: number;
      material: ReviewMaterialEvidence;
    }
  | {
      kind: "sent_piece" | "abandoned_protection";
      moves: number;
      protection: ReviewProtectionEvidence;
    }
  | { kind: "cannon_mount"; moves: number; cannonMount: ReviewCannonMountEvidence }
  | { kind: "check_capture"; moves: number; checkCapture: ReviewCheckCaptureEvidence }
  | { kind: "position_type"; moves: number; position: ReviewPositionEvidence };

export type ReviewExplanationLevel = "beginner" | "intermediate" | "proficient";

export interface ReviewWorkerPoint {
  quick: ReviewPlyResult;
  final: ReviewPlyResult;
  deepened: boolean;
  continuationComplete: boolean;
}

export type ReviewWorkerRequest =
  | {
    type: "start";
    id: number;
    /** Overall review job id; the worker stamps it on replay audits. Defaults to `id`. */
    jobId?: number;
    startFen: string;
    moves: string[];
    quickNodeLimit: number;
    focusIndex?: number;
    /** Original ply indices this worker analyzes (two-pass); the rest of the game is only replayed. */
    indices?: number[];
  }
  | { type: "cancel"; id: number };

export type ReviewWorkerResponse =
  | { id: number; status: "point"; pass: "quick" | "deep"; index: number; point: ReviewWorkerPoint; continuationPending: boolean; durationMs?: number }
  | { id: number; status: "continuation"; pass: "quick" | "deep"; index: number; candidateIndex: number; segment: ReviewPlyResult["candidates"][number]["continuation"][number]; candidateComplete: boolean; continuationTerminal: boolean; continuationStatus: ReviewPlyResult["candidates"][number]["continuationStatus"]; durationMs: number }
  | { id: number; status: "continuation-complete"; pass: "quick" | "deep"; index: number; durationMs: number }
  | { id: number; status: "complete" | "cancelled"; points: ReviewWorkerPoint[]; focusIndex?: number; cancelLatencyMs?: number }
  | { id: number; status: "failed"; error: string; points: ReviewWorkerPoint[]; focusIndex?: number };

export interface ReviewJobState {
  id: number;
  status: "running" | "complete" | "cancelled" | "failed";
  points: ReviewWorkerPoint[];
  error?: string;
  lastStepDurationMs?: number;
  cancelLatencyMs?: number;
  focusIndex?: number;
  /** Set by the worker pool: workers used for this job, and how many are analyzing right now. */
  workerCount?: number;
  activeWorkers?: number;
  /** Plies answered from the analysis cache instead of being computed (absent when none). */
  cachedPlies?: number;
}

export interface ReviewStartOptions {
  /** Analyze only these original plies (two-pass, same results as a whole-game session). */
  indices?: number[];
  /** Overall job id stamped on replay audits instead of this client's own request id. */
  jobId?: number;
  /** Points a focused run keeps and patches; defaults to this client's previous points. */
  basePoints?: ReviewWorkerPoint[];
}

export class ReviewWorkerClient {
  private nextId = 1;
  private currentId = 0;
  private _state: ReviewJobState | null = null;

  constructor(
    private readonly worker: Worker,
    private readonly onUpdate: (state: ReviewJobState) => void = () => {},
  ) {
    worker.addEventListener("message", ((event: MessageEvent<ReviewWorkerResponse>) => {
      const response = event.data;
      if (response.id !== this.currentId || !this._state) return;
      if (response.status === "point") {
        if (this._state.focusIndex !== undefined) {
          this.update({ ...this._state, lastStepDurationMs: response.durationMs });
          return;
        }
        const points = [...this._state.points];
        points[response.index] = response.point;
        this.update({ ...this._state, points, lastStepDurationMs: response.durationMs });
      } else if (response.status === "continuation") {
        if (this._state.focusIndex !== undefined) {
          this.update({ ...this._state, lastStepDurationMs: response.durationMs });
          return;
        }
        const points = [...this._state.points];
        const point = points[response.index];
        if (!point) return;
        const updateCandidate = (result: ReviewPlyResult): ReviewPlyResult => ({
          ...result,
          candidates: result.candidates.map((candidate, index) => index === response.candidateIndex
            ? { ...candidate, continuation: [...candidate.continuation, response.segment], continuationTerminal: response.continuationTerminal, continuationStatus: response.continuationStatus }
            : candidate),
        });
        points[response.index] = {
          ...point,
          quick: response.pass === "quick" ? updateCandidate(point.quick) : point.quick,
          final: response.pass === "deep" || !point.deepened
            ? updateCandidate(point.final)
            : point.final,
        };
        this.update({ ...this._state, points, lastStepDurationMs: response.durationMs });
      } else if (response.status === "continuation-complete") {
        const points = [...this._state.points];
        const point = points[response.index];
        if (!point) return;
        points[response.index] = { ...point, continuationComplete: true };
        this.update({ ...this._state, points, lastStepDurationMs: response.durationMs });
      } else {
        let points = response.points;
        if (this._state.focusIndex !== undefined) {
          points = [...this._state.points];
          if (response.status === "complete" && response.focusIndex !== undefined && response.points[0]) {
            points[response.focusIndex] = response.points[0];
          }
        }
        this.update({
          id: response.id,
          status: response.status,
          points,
          ...(response.status === "cancelled" && response.cancelLatencyMs !== undefined
            ? { cancelLatencyMs: response.cancelLatencyMs }
            : {}),
          ...(response.status === "failed" ? { error: response.error } : {}),
        });
      }
    }) as EventListener);
    worker.addEventListener("error", (() => {
      if (!this._state || this._state.status !== "running") return;
      this.update({ ...this._state, status: "failed", error: "workerFailed" });
    }) as EventListener);
  }

  get state(): ReviewJobState | null {
    return this._state;
  }

  start(
    moves: string[],
    quickNodeLimit = 5_000,
    startFen = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1",
    focusIndex?: number,
    options: ReviewStartOptions = {},
  ): number {
    const id = this.nextId++;
    this.currentId = id;
    const points = focusIndex === undefined ? [] : options.basePoints ?? this._state?.points ?? [];
    this.update({ id, status: "running", points, ...(focusIndex === undefined ? {} : { focusIndex }) });
    this.worker.postMessage({
      type: "start",
      id,
      startFen,
      moves,
      quickNodeLimit,
      ...(focusIndex === undefined ? {} : { focusIndex }),
      ...(options.indices === undefined ? {} : { indices: options.indices }),
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
    } satisfies ReviewWorkerRequest);
    return id;
  }

  cancel(): void {
    if (!this._state || this._state.status !== "running") return;
    this.worker.postMessage({ type: "cancel", id: this.currentId } satisfies ReviewWorkerRequest);
  }

  dispose(): void {
    this.worker.terminate();
  }

  private update(state: ReviewJobState): void {
    this._state = state;
    this.onUpdate(state);
  }
}
