import type { ReviewJobState, ReviewReasonKind } from "./review-client";
import type { SerializedReviewVariationTree } from "./review-variation-tree";
import { zhTW } from "./locale/zh-TW";
import { STANDARD_START_FEN } from "./game-library";
import { winProbabilityForUser } from "./review-presentation";
import type { SavedGame } from "./game-library";
const L = zhTW.reviewNote;

export interface ReviewNoteInput {
  reportDate: string;
  metadata: Record<string, string>;
  result: "red_win" | "black_win" | "draw" | "unknown";
  startFen: string;
  moves: string[];
  notations: string[];
  points: ReviewJobState["points"];
  boards: string[];
  variationTree: SerializedReviewVariationTree | null;
  analyzer: { name: string; quickNodeLimit: number; deepNodeLimit: number; config: string };
}

export interface ReviewNoteDocument { markdown: string; plainText: string; curveSvg: string }
export interface ReviewNoteContext {
  savedGames: SavedGame[];
  activeSavedGameId: string | null;
  currentMetadata: Record<string, string>;
  history: Array<{ iccs: string; notation: string }>;
  currentTree: SerializedReviewVariationTree | null;
}
const esc = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const md = (s: string): string => esc(s.replace(/[\r\n]+/g, " ")).replaceAll('"', "&quot;");
const num = (n: number): string => n.toLocaleString("zh-TW");

export function generateReviewNote(input: ReviewNoteInput): ReviewNoteDocument {
  const { points, moves } = input;
  let sideToMove: "red" | "black" = input.startFen.trim().split(/\s+/)[1] === "b" ? "black" : "red";
  const curveSvg = buildCurveSvg(points.map((point) => {
    const probability = winProbabilityForUser(point.final.playedWinProbability, sideToMove, "red");
    sideToMove = sideToMove === "red" ? "black" : "red";
    return probability;
  }));
  const metadata = input.metadata;
  const knownOpening = input.startFen === STANDARD_START_FEN && moves.slice(0, 6).join(" ") === "h2e2 h9g7 h0g2 i9h9 i0h0 b9c7"
    ? L.knownOpening : input.startFen === STANDARD_START_FEN ? L.standardOpening : L.customOpening;
  const red = metadata.Red ?? L.red;
  const black = metadata.Black ?? L.black;
  const resultLabel = input.result === "red_win" ? L.redWin : input.result === "black_win" ? L.blackWin : input.result === "draw" ? L.draw : L.undecided;
  const lines: string[] = [
    `# ${L.title}`, "", `## ${L.headings[0]}`, "",
    `- ${L.date}：${md(input.reportDate)}`, `- 雙方：${md(red)}（紅）對 ${md(black)}（黑）`, `- ${L.result}：${resultLabel}`,
    `- ${L.opening}：${knownOpening}`, `- ${L.analyzer}：${md(input.analyzer.name)}；${L.quickNodes} ${num(input.analyzer.quickNodeLimit)} ${L.nodes}、${L.deepNodes} ${num(input.analyzer.deepNodeLimit)} ${L.nodes}`,
    `- ${L.searchConfig}：${md(input.analyzer.config)}`, "", `## ${L.headings[1]}`, "", `${L.curveCaption}`, "", curveSvg,
    "", `## ${L.headings[2]}`, "",
  ];
  const losses = points.map((point, index) => ({ point: point.final, index }))
    .filter(({ point }) => point.lossPercent >= 2 || point.reason)
    .sort((a, b) => b.point.lossPercent - a.point.lossPercent).slice(0, 5);
  if (!losses.length) lines.push(L.clean);
  else {
    const biggest = losses[0]!;
    lines.push(L.total(moves.length, biggest.index + 1, biggest.point.lossPercent.toFixed(1)));
  }
  lines.push("", `## ${L.headings[3]}`, "");
  if (!losses.length) lines.push(L.clean);
  for (const { point, index } of losses) {
    const played = input.notations[index] ?? moves[index] ?? "未知著法";
    const candidate = point.candidates.find((item) => item.move === point.bestMove);
    const reason = point.reason ? noteReason(point.reason) : L.unknownReason;
    lines.push(`### ${L.moment(index + 1, md(played))}`, "", `- ${L.played}：${md(played)}（${md(moves[index] ?? "")}）`,
      `- ${L.bestCandidate}${candidate ? `・深度 ${candidate.depth}・${num(candidate.nodes)} ${L.nodes}` : `・${L.noCandidate}`}：${md(point.bestMove)}`,
      `- ${L.mainLine}：${candidate ? md(candidate.pv.join(" ")) : L.noPv}`, `- ${L.loss}：${point.lossPercent.toFixed(1)}%`, `- ${L.cause}：${reason}`);
    if (point.comparison) {
      const sentences = zhTW.review.comparison(point.comparison);
      const bestNotation = point.comparison.bestLine[0]?.notation;
      if (bestNotation) lines.push(`- ${L.bestNotation}：${md(bestNotation)}`);
      lines.push(`- ${md(sentences.played)}`, `- ${md(sentences.best)}`);
    }
    const board = input.boards[index] ?? "";
    if (board.length === 90) lines.push("", buildBoardSvg(board, L.boardTitle(index + 1)));
    lines.push("");
  }
  lines.push(`## ${L.headings[4]}`, "");
  const branches = annotatedBranches(input.variationTree);
  lines.push(...(branches.length ? branches.map((branch) => `- ${md(branch.moves)}：${md(branch.annotation)}`) : [L.noAnnotatedBranches]),
    "", `## ${L.headings[5]}`, "");
  const flagged = points.filter((point) => point.final.lossPercent >= 2 || point.final.reason);
  const countKind = (kind: ReviewReasonKind) => flagged.filter((point) => point.final.reason?.kind === kind).length;
  const unknown = flagged.filter((point) => !point.final.reason).length;
  const walked = countKind("walked_into_mate");
  const missed = countKind("missed_mate");
  // SPEC 9.6 lists dropped pieces, missed mates and sent pieces; the other M8 kinds are shown only when they occur.
  const optionalKinds: ReviewReasonKind[] = ["dropped_material", "sent_piece", "cannon_mount", "missed_material", "abandoned_protection", "check_capture", "position_type"];
  const optional = optionalKinds.map((kind) => ({ kind, label: L.kindLabels[kind], value: countKind(kind) }));
  lines.push(`- ${L.kindCount(L.kindLabels.walked_into_mate, walked)}`, `- ${L.kindCount(L.kindLabels.missed_mate, missed)}`);
  for (const item of optional) if (item.value > 0) lines.push(`- ${L.kindCount(item.label, item.value)}`);
  lines.push(`- ${L.unknownCount(unknown)}`, "", `## ${L.headings[6]}`, "");
  // 局面型 is the catch-all reason ("none of the above"), so it never becomes the focus.
  const counts = [{ label: L.kindLabels.walked_into_mate, value: walked }, { label: L.kindLabels.missed_mate, value: missed }, ...optional.filter((item) => item.kind !== "position_type")]
    .filter((item) => item.value > 0).sort((a, b) => b.value - a.value);
  lines.push(counts.length && (counts.length === 1 || counts[0]!.value > counts[1]!.value)
    ? `${L.nextFocus}：${counts[0]!.label}` : L.pendingFocus);
  lines.push("", `## ${L.headings[7]}`, "", `${L.startFen}：\`${md(input.startFen)}\``, "", "```pgn", pgnReplay(input), "```", "");
  const markdown = lines.join("\n");
  const plainText = markdown.replace(/<svg[\s\S]*?<\/svg>/g, "[勝率曲線圖]").replace(/[`*_#]/g, "");
  return { markdown, plainText, curveSvg };
}

/** Mate reasons keep the note's own sentences; every other reason reuses the review wording. */
function noteReason(reason: NonNullable<ReviewNoteInput["points"][number]["final"]["reason"]>): string {
  if (reason.kind === "walked_into_mate") return L.walkedMate(reason.moves);
  if (reason.kind === "missed_mate") return L.missedMate(reason.moves);
  const text = zhTW.review.reason(reason, "intermediate");
  // The note is developer-facing: the sentence itself names pieces only, so the squares follow it.
  if ("protection" in reason && reason.protection) {
    const e = reason.protection;
    return `${text}（${e.from}→${e.to}，被吃的是 ${e.capturedAt}）`;
  }
  if ("cannonMount" in reason && reason.cannonMount) {
    const e = reason.cannonMount;
    return `${text}（${e.cannonFrom} 吃 ${e.victimSquare}，炮架在 ${e.screenSquare}）`;
  }
  if ("checkCapture" in reason && reason.checkCapture) {
    const e = reason.checkCapture;
    return `${text}（${e.attackerFrom} 吃 ${e.victimSquare}）`;
  }
  if ("material" in reason && reason.material) {
    const squares = [...reason.material.playedCaptures, ...reason.material.bestCaptures].map((capture) => capture.square);
    return squares.length ? `${text}（${[...new Set(squares)].join("、")}）` : text;
  }
  return text;
}

export function createReviewNoteInput(
  artifact: Omit<ReviewNoteInput, "metadata" | "notations" | "variationTree">,
  context: ReviewNoteContext,
): ReviewNoteInput {
  const active = context.activeSavedGameId
    ? context.savedGames.find((game) => game.id === context.activeSavedGameId
      && game.startFen === artifact.startFen && sameMoves(game.moves, artifact.moves)) ?? null
    : null;
  if (context.history.length !== artifact.moves.length
    || context.history.some((record, index) => record.iccs !== artifact.moves[index])) {
    throw new Error("review note history does not match the completed analysis");
  }
  const tree = context.currentTree && treeMatches(context.currentTree, artifact.startFen, artifact.moves)
    ? context.currentTree
    : active?.variationTree && treeMatches(active.variationTree, artifact.startFen, artifact.moves)
      ? active.variationTree : null;
  const metadata = active?.importMetadata ?? context.currentMetadata;
  return {
    ...artifact,
    result: artifact.result === "unknown" ? resultFromHeader(metadata.Result) : artifact.result,
    metadata,
    notations: context.history.map((record) => record.notation),
    variationTree: tree,
  };
}

/** The engine's own verdict wins; the record header's Result text only fills in an undecided game. */
function resultFromHeader(text: string | undefined): ReviewNoteInput["result"] {
  const value = (text ?? "").trim();
  return value === "1-0" ? "red_win" : value === "0-1" ? "black_win" : value === "1/2-1/2" ? "draw" : "unknown";
}

function sameMoves(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((move, index) => move === right[index]);
}

function treeMatches(tree: SerializedReviewVariationTree, startFen: string, moves: string[]): boolean {
  if (tree.startFen !== startFen) return false;
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  return moves.every((move, index) => nodes.get(`main-${index + 1}`)?.move === move)
    && !nodes.has(`main-${moves.length + 1}`);
}

function pgnReplay(input: ReviewNoteInput): string {
  const headers = Object.entries({ ...input.metadata, Result: input.metadata.Result ?? "*", FEN: input.startFen })
    .map(([key, value]) => `[${key.replace(/[^A-Za-z0-9_]/g, "") || "Note"} "${esc(value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/[\r\n]/g, " ")).replaceAll("`", "&#96;")}"]`);
  const turns: string[] = [];
  let moveNo = Number(input.startFen.trim().split(/\s+/)[5] ?? "1");
  const blackToMove = input.startFen.trim().split(/\s+/)[1] === "b";
  for (let i = 0; i < input.moves.length; i += 1) {
    const blackMove = blackToMove ? i % 2 === 0 : i % 2 === 1;
    const notation = input.notations[i] ?? input.moves[i];
    if (blackMove) {
      if (blackToMove && i === 0) turns.push(`${moveNo}... ${notation}`);
      else turns[turns.length - 1] += ` ${notation}`;
      moveNo += 1;
    } else turns.push(`${moveNo}. ${notation}`);
  }
  return headers.concat("", turns.join(" "), input.metadata.Result ?? "*").join("\n");
}

function annotatedBranches(tree: SerializedReviewVariationTree | null): Array<{ moves: string; annotation: string }> {
  if (!tree) return [];
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const result: Array<{ moves: string; annotation: string }> = [];
  for (const node of tree.nodes) {
    if (!node.id.startsWith("branch-") || !node.annotation.trim()) continue;
    const path: string[] = [];
    let cursor = node;
    // bounded by the node count: a parent loop in damaged data must not hang the note
    for (let steps = 0; cursor.parentId && steps <= tree.nodes.length; steps++) { if (cursor.move) path.push(cursor.move); const parent = nodes.get(cursor.parentId); if (!parent) break; cursor = parent; }
    result.push({ moves: path.reverse().join(" "), annotation: node.annotation.trim() });
  }
  return result;
}

export function buildCurveSvg(values: number[], label: string = L.curveLabel, title: string = L.curveTitle): string {
  const width = 720, height = 220, points = values.length ? values : [0.5];
  const coords = points.map((value, index) => `${20 + index * (680 / Math.max(1, points.length - 1))},${200 - Math.max(0, Math.min(1, value)) * 180}`).join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img"><title>${title}</title><path d="M20 20V200H700" fill="none" stroke="#777"/><polyline points="${coords}" fill="none" stroke="#a22" stroke-width="3"/><text x="20" y="15">${label}</text></svg>`;
}

export interface BoardSvgOptions {
  /** Draw the board from black's side (black at the bottom). */
  flipped?: boolean;
  /** Squares such as "h2" to draw arrows between: what was played and what would have been better. */
  played?: { from: string; to: string };
  best?: { from: string; to: string };
  /** Print version: red pieces get red characters, and the arrows are drawn. */
  colorText?: boolean;
}

export function buildBoardSvg(board: string, label: string, options: BoardSvgOptions = {}): string {
  const flipped = options.flipped === true;
  const pieces: string[] = [];
  for (let i = 0; i < 90; i += 1) {
    const piece = board[i]!;
    if (piece === ".") continue;
    const at = flipped ? 89 - i : i;
    const x = 24 + (at % 9) * 42, y = 24 + Math.floor(at / 9) * 42;
    const red = piece === piece.toUpperCase();
    const fill = options.colorText ? ` fill="${red ? "#a22" : "#222"}"` : "";
    pieces.push(`<circle cx="${x}" cy="${y}" r="16" fill="#fff8e8" stroke="${red ? "#a22" : "#222"}"/><text x="${x}" y="${y + 5}" text-anchor="middle"${fill}>${esc(L.pieces[piece as keyof typeof L.pieces])}</text>`);
  }
  const grid = Array.from({ length: 10 }, (_, rank) => `<path d="M24 ${24 + rank * 42}H360" stroke="#543"/>`).join("")
    + Array.from({ length: 9 }, (_, file) => `<path d="M${24 + file * 42} 24V402" stroke="#543"/>`).join("");
  const at = (square: string): { x: number; y: number } | null => {
    if (!/^[a-i][0-9]$/.test(square)) return null;
    const file = square.charCodeAt(0) - 97, rank = Number(square[1]);
    return { x: 24 + (flipped ? 8 - file : file) * 42, y: 24 + (flipped ? rank : 9 - rank) * 42 };
  };
  const arrow = (move: { from: string; to: string } | undefined, color: string): string => {
    const from = move && at(move.from), to = move && at(move.to);
    if (!from || !to) return "";
    const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const ux = (to.x - from.x) / length, uy = (to.y - from.y) / length;
    const tipX = to.x - ux * 12, tipY = to.y - uy * 12;
    const head = `${tipX + ux * 12},${tipY + uy * 12} ${tipX - uy * 8},${tipY + ux * 8} ${tipX + uy * 8},${tipY - ux * 8}`;
    return `<g opacity="0.8"><line x1="${from.x}" y1="${from.y}" x2="${tipX}" y2="${tipY}" stroke="${color}" stroke-width="5" stroke-linecap="round"/><polygon points="${head}" fill="${color}"/></g>`;
  };
  const arrows = arrow(options.played, "#e8590c") + arrow(options.best, "#1971c2");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 426" role="img"><title>${esc(label)}</title><rect width="384" height="426" fill="#f3dfb8"/>${grid}${pieces.join("")}${arrows}</svg>`;
}
