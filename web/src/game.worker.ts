import { computerToMove, playComputerMove, undoToUserTurn } from "./game-session";
import type { GameSnapshot, WorkerErrorCode, WorkerRequest, WorkerResponse } from "./game-client";

interface WasmGame {
  board(): string;
  fen(): string;
  start_fen(): string;
  side_to_move(): "red" | "black";
  legal_moves(): string;
  history(): string;
  last_move(): string;
  last_ai_level(): number;
  outcome(): GameSnapshot["outcome"];
  play(iccs: string): boolean;
  load_record(startFen: string, moves: string): boolean;
  undo_last_move(): boolean;
  ai_move(nodeLimit: number, level: number): boolean;
  branch_reply(nodeLimit: number): boolean;
  live_evaluation(nodeLimit: number): string;
  restart(): void;
}

interface WasmModule {
  default: () => Promise<unknown>;
  WebGame: new () => WasmGame;
}

interface WorkerScope extends EventTarget {
  postMessage(message: WorkerResponse): void;
  readonly location: Location;
}

const scope = self as unknown as WorkerScope;
let game: WasmGame | null = null;
let createGame: (() => WasmGame) | null = null;
let operationQueue = Promise.resolve();
const LIVE_EVALUATION_NODES = 4_000;
const COMPUTER_NODE_LIMIT = 100_000;

class WorkerOperationError extends Error {
  constructor(readonly code: WorkerErrorCode) {
    super(code);
  }
}

async function initializeGame(): Promise<void> {
  if (game) return;
  const wasmUrl = new URL(`${import.meta.env.BASE_URL}wasm/xq_wasm.js`, scope.location.origin).href;
  const module = (await import(/* @vite-ignore */ wasmUrl)) as WasmModule;
  await module.default();
  createGame = () => new module.WebGame();
  game = createGame();
}

function snapshot(): GameSnapshot {
  if (!game) throw new Error("棋局尚未初始化。");
  const history = game.history().split("\n").filter(Boolean).map((record) => {
    const [ply, side, notation, iccs] = record.split("|");
    return {
      ply: Number(ply),
      side: side as "red" | "black",
      notation,
      iccs,
    };
  });
  return {
    board: game.board(),
    fen: game.fen(),
    startFen: game.start_fen(),
    side: game.side_to_move(),
    legalMoves: game.legal_moves().split(",").filter(Boolean),
    history,
    lastMove: game.last_move(),
    outcome: game.outcome(),
    lastAiLevel: game.last_ai_level(),
  };
}

function publishLiveEvaluation(requestId: number): void {
  if (!game) return;
  const startedAt = performance.now();
  const raw = game.live_evaluation(LIVE_EVALUATION_NODES);
  const elapsedMs = Math.round(performance.now() - startedAt);
  const result = JSON.parse(raw) as {
    scoreCentipawns: number; nodes: number; depth: number; fen: string; sideToMove: "red" | "black";
  };
  scope.postMessage({ id: requestId, status: "live-evaluation", ...result, elapsedMs });
}

async function apply(command: WorkerRequest): Promise<void> {
  if (command.type === "init") {
    await initializeGame();
    // a user who plays black lets the computer open: an ordinary game move at the chosen difficulty
    if (game && command.userSide === "black" && computerToMove(game, "black")) {
      scope.postMessage({ id: command.id, status: "searching" });
      if (!playComputerMove(game, "black", COMPUTER_NODE_LIMIT, command.difficultyLevel ?? 5)) {
        throw new WorkerOperationError("workerFailed");
      }
    }
  } else if (command.type === "resume") {
    // a refresh brought the game back: load it as it stood, and if the computer was to move (it was thinking when the
    // page went away), ask it again
    await initializeGame();
    if (!createGame) throw new WorkerOperationError("notInitialized");
    const candidate = createGame();
    if (!candidate.load_record(command.startFen, command.moves.join(" "))) {
      throw new WorkerOperationError("invalidMove");
    }
    game = candidate;
    if (computerToMove(game, command.userSide)) {
      scope.postMessage({ id: command.id, status: "searching" });
      if (!playComputerMove(game, command.userSide, COMPUTER_NODE_LIMIT, command.difficultyLevel) && game.outcome() === "ongoing") {
        throw new WorkerOperationError("workerFailed");
      }
    }
  } else if (command.type === "load-review") {
    await initializeGame();
    if (!createGame) throw new WorkerOperationError("notInitialized");
    const candidate = createGame();
    if (!candidate.load_record(command.startFen, command.moves.join(" "))) {
      throw new WorkerOperationError("invalidMove");
    }
    game = candidate;
  } else {
    if (!game) throw new WorkerOperationError("notInitialized");
    if (command.type === "move") {
      if (!game.play(command.move)) throw new WorkerOperationError("invalidMove");
      // Show the user's own move at once; the reply (and any evaluation) comes afterwards.
      scope.postMessage({ id: command.id, status: "player-moved", state: snapshot() });
      if (computerToMove(game, command.userSide ?? "red")) {
        scope.postMessage({ id: command.id, status: "searching" });
        const testLongSearch = import.meta.env.DEV
          && new URLSearchParams(scope.location.search).get("test-long-search") === "1";
        const nodeLimit = testLongSearch ? 100_000_000 : COMPUTER_NODE_LIMIT;
        if (!playComputerMove(game, command.userSide ?? "red", nodeLimit, command.difficultyLevel) && game.outcome() === "ongoing") {
          throw new WorkerOperationError("workerFailed");
        }
      }
    }
    if (command.type === "evaluate") publishLiveEvaluation(command.id);
    if (command.type === "branch-move") {
      if (!game.play(command.move)) throw new WorkerOperationError("invalidMove");
      if (game.outcome() === "ongoing") {
        scope.postMessage({ id: command.id, status: "searching" });
        if (!game.branch_reply(10_000) && game.outcome() === "ongoing") {
          throw new WorkerOperationError("workerFailed");
        }
      }
    }
    if (command.type === "branch-engine") {
      for (let played = 0; played < command.plies && game.outcome() === "ongoing"; played += 1) {
        scope.postMessage({ id: command.id, status: "searching" });
        if (!game.branch_reply(10_000)) throw new WorkerOperationError("workerFailed");
      }
    }
    if (command.type === "undo") undoToUserTurn(game, command.userSide ?? "red");
    if (command.type === "reset") game.restart();
  }
  scope.postMessage({ id: command.id, ok: true, state: snapshot() });
}

scope.addEventListener("message", ((event: MessageEvent<WorkerRequest>) => {
  const command: WorkerRequest = event.data;
  if (import.meta.env.DEV && scope.location.search.includes("test-crash-on-move=1") && command.type === "move") {
    throw new Error("uncaught worker failure injected by browser test");
  }
  operationQueue = operationQueue
    .then(() => apply(command))
    .catch((error: unknown) => {
      const code: WorkerErrorCode = error instanceof WorkerOperationError
        ? error.code
        : command.type === "init" ? "initializationFailed" : "workerFailed";
      const currentState = game ? snapshot() : undefined;
      scope.postMessage({ id: command.id, ok: false, error: code, state: currentState });
    });
}) as EventListener);
