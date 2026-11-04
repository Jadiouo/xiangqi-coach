export type GameCommand =
  | { type: "init"; userSide?: "red" | "black"; difficultyLevel?: number }
  | { type: "move"; move: string; difficultyLevel: number; userSide?: "red" | "black" }
  | { type: "evaluate" }
  | { type: "load-review"; startFen: string; moves: string[] }
  | { type: "resume"; startFen: string; moves: string[]; userSide: "red" | "black"; difficultyLevel: number }
  | { type: "branch-move"; move: string }
  | { type: "branch-engine"; plies: number }
  | { type: "undo"; userSide?: "red" | "black" }
  | { type: "reset" };

export interface GameMoveRecord {
  ply: number;
  side: "red" | "black";
  notation: string;
  iccs: string;
}

export interface GameSnapshot {
  board: string;
  fen: string;
  startFen: string;
  side: "red" | "black";
  legalMoves: string[];
  history: GameMoveRecord[];
  lastMove: string;
  outcome: "ongoing" | "draw" | "red_win" | "black_win";
  lastAiLevel: number;
}

export interface LiveEvaluationEvent {
  scoreCentipawns: number;
  nodes: number;
  depth: number;
  /** Wall-clock time of the evaluation call, measured by the worker (the engine core has no clock). */
  elapsedMs: number;
  fen: string;
  sideToMove: "red" | "black";
}

export type WorkerErrorCode = "invalidMove" | "notInitialized" | "initializationFailed" | "workerFailed";

export type WorkerRequest = GameCommand & { id: number };

export type WorkerReply =
  | { id: number; ok: true; state: GameSnapshot }
  | { id: number; ok: false; error: WorkerErrorCode; state?: GameSnapshot };

export type WorkerResponse =
  | { id: number; status: "searching" }
  | { id: number; status: "player-moved"; state: GameSnapshot }
  | ({ id: number; status: "live-evaluation" } & LiveEvaluationEvent)
  | WorkerReply;

interface PendingRequest {
  resolve: (response: WorkerReply) => void;
  reject: (error: Error) => void;
}

export class GameWorkerClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private terminalError: Error | null = null;

  constructor(
    private readonly worker: Worker,
    private readonly onFailure: () => void = () => {},
    private readonly onSearching: (requestId: number) => void = () => {},
    private readonly onLiveEvaluation: (requestId: number, result: LiveEvaluationEvent) => void = () => {},
    private readonly onPlayerMoved: (requestId: number, state: GameSnapshot) => void = () => {},
  ) {
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if ("status" in response) {
        if (response.status === "searching") this.onSearching(response.id);
        else if (response.status === "player-moved") this.onPlayerMoved(response.id, response.state);
        else this.onLiveEvaluation(response.id, response);
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok || response.state) pending.resolve(response);
      else pending.reject(new Error(response.error));
    });

    worker.addEventListener("error", (event: ErrorEvent) => {
      if (this.terminalError) return;
      void event;
      const error = new Error("workerFailed");
      this.terminalError = error;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.onFailure();
    });
  }

  dispose(): void {
    const error = new Error("workerFailed");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.worker.terminate();
  }

  request(command: GameCommand): { id: number; promise: Promise<WorkerReply> } {
    const id = this.nextId;
    this.nextId += 1;
    if (this.terminalError) return { id, promise: Promise.reject(this.terminalError) };
    const promise = new Promise<WorkerReply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.worker.postMessage({ ...command, id } satisfies WorkerRequest);
    return { id, promise };
  }
}

export class LatestGameState {
  private latestRequestId = 0;
  current: GameSnapshot | null = null;

  track(requestId: number): void {
    this.latestRequestId = requestId;
  }

  isCurrent(requestId: number): boolean {
    return requestId === this.latestRequestId;
  }

  accept(response: WorkerReply): boolean {
    if (!this.isCurrent(response.id)) return false;
    if (response.state) this.current = response.state;
    return true;
  }

  /** Show the position right after the user's move while the reply is still being computed. */
  showEarly(requestId: number, state: GameSnapshot): boolean {
    if (!this.isCurrent(requestId)) return false;
    this.current = state;
    return true;
  }
}

/** Keeps only the newest live-evaluation request, and only while its position is still on the board. */
export class LiveEvaluationGate {
  private latestRequestId: number | null = null;

  begin(requestId: number): void {
    this.latestRequestId = requestId;
  }

  clear(): void {
    this.latestRequestId = null;
  }

  accepts(requestId: number, resultFen: string, currentFen: string | undefined): boolean {
    return this.latestRequestId === requestId && currentFen !== undefined && resultFen === currentFen;
  }
}
