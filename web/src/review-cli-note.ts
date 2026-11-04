import type { ReviewPlyResult, ReviewWorkerPoint, ReviewReason, ReviewPvEnd, ReviewLineStep } from "./review-client";
import type { ReviewNoteInput } from "./review-note";
import { zhTW } from "./locale/zh-TW";

/** One score as `xq-uci review` prints it (snake_case, Rust side). */
interface CliScore { centipawns: number; mate_in: number | null }

interface CliPlyResult {
  best_move: string;
  played_move: string;
  played_rank: number | null;
  best_score: CliScore;
  played_score: CliScore;
  best_win_probability: number;
  played_win_probability: number;
  loss_percent: number;
  classification: ReviewPlyResult["classification"];
  reason: ReviewReason | null;
  comparison?: CliComparison | null;
}

interface CliLineStep { iccs: string; notation: string; side: "red" | "black"; captured: ReviewLineStep["captured"] }
interface CliComparison {
  played_line: CliLineStep[];
  best_line: CliLineStep[];
  played_complete: boolean;
  best_complete: boolean;
  played_settled: boolean;
  best_settled: boolean;
}

interface CliCandidate {
  best_move: string;
  score: CliScore;
  principal_variation: string[];
  depth: number;
  nodes: number;
  pv_end: ReviewPvEnd;
}

interface CliPass { result: CliPlyResult; candidates: CliCandidate[] }

/** The JSON document printed by `xq-uci review` (schema_version 1). */
export interface CliReviewReport {
  schema_version: 1;
  import_status: "complete" | "partial";
  start_fen: string;
  result: ReviewNoteInput["result"];
  moves: string[];
  notations: string[];
  boards: string[];
  analyzer: string;
  limits: { quick_nodes: number; deep_nodes: number; timeout_ms: number };
  plies: Array<{ quick: CliPass; final: CliPass & { deepened: boolean } }>;
}

const score = (value: CliScore) => ({ centipawns: value.centipawns, mateIn: value.mate_in });

function plyResult(pass: CliPass): ReviewPlyResult {
  const r = pass.result;
  return {
    bestMove: r.best_move,
    playedMove: r.played_move,
    playedRank: r.played_rank,
    bestScore: score(r.best_score),
    playedScore: score(r.played_score),
    bestWinProbability: r.best_win_probability,
    playedWinProbability: r.played_win_probability,
    lossPercent: r.loss_percent,
    classification: r.classification,
    reason: r.reason,
    comparison: r.comparison ? {
      playedLine: r.comparison.played_line,
      bestLine: r.comparison.best_line,
      playedComplete: r.comparison.played_complete,
      bestComplete: r.comparison.best_complete,
      playedSettled: r.comparison.played_settled,
      bestSettled: r.comparison.best_settled,
    } : null,
    candidates: pass.candidates.map((line) => ({
      move: line.best_move,
      score: score(line.score),
      pv: line.principal_variation,
      depth: line.depth,
      nodes: line.nodes,
      pvEnd: line.pv_end,
      continuation: [],
      continuationNodeLimit: 0,
      continuationTerminal: false,
      replayAudit: {},
      continuationStatus: "pending",
    })),
  };
}

/**
 * Turns the CLI review report into the input of the one and only note generator
 * (`generateReviewNote`), so the web and the command line write the same note.
 */
export function reviewNoteInputFromCli(report: CliReviewReport, options: { reportDate: string }): ReviewNoteInput {
  if (report.import_status !== "complete") {
    throw new Error("review report is partial: the record did not import completely, so no note is written");
  }
  const points: ReviewWorkerPoint[] = report.plies.map((ply) => ({
    quick: plyResult(ply.quick),
    final: plyResult(ply.final),
    deepened: ply.final.deepened,
    continuationComplete: true,
  }));
  return {
    reportDate: options.reportDate,
    metadata: {},
    result: report.result,
    startFen: report.start_fen,
    moves: report.moves,
    notations: report.notations,
    points,
    boards: report.boards,
    variationTree: null,
    analyzer: {
      name: report.analyzer,
      quickNodeLimit: report.limits.quick_nodes,
      deepNodeLimit: report.limits.deep_nodes,
      config: zhTW.reviewNote.cliConfig(report.limits.timeout_ms),
    },
  };
}
