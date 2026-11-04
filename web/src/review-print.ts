import type { ReviewExplanationLevel, ReviewReasonKind } from "./review-client";
import { zhTW } from "./locale/zh-TW";
import { buildBoardSvg, buildCurveSvg, type ReviewNoteInput } from "./review-note";
import { focusPoints, plySides, winProbabilityForUser, type ReviewSide } from "./review-presentation";

export interface ReviewPrintOptions {
  userSide: ReviewSide;
  level?: ReviewExplanationLevel;
  /** The review page's level filter (which classifications count as key moves); defaults to the page's own default. */
  shows?: (classification: string) => boolean;
}

/** What the review page lists as key moves when no level is known (same default as the page). */
const DEFAULT_SHOWS = (classification: string): boolean => classification === "mistake" || classification === "blunder" || classification === "missed_mate";

const P = zhTW.reviewPrint;
const N = zhTW.reviewNote;
const F = zhTW.review.focus;
const esc = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Page rules: A4, and a key move (or a table row) is never cut across two pages. */
const STYLE = `
@page { size: A4; margin: 14mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #222; font: 10.5pt/1.6 "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif; }
h1 { font-size: 20pt; margin: 0 0 4mm; }
h2 { font-size: 14pt; margin: 8mm 0 3mm; padding-bottom: 1mm; border-bottom: 0.4mm solid #a22; break-after: avoid; page-break-after: avoid; }
h3 { font-size: 11.5pt; margin: 0 0 1.5mm; }
p { margin: 0 0 2mm; }
ul { margin: 0 0 2mm; padding-left: 5mm; }
.meta { list-style: none; padding: 0; }
.curve svg { display: block; width: 140mm; height: 43mm; }
.curve svg text { font: 22px "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif; }
.hint { color: #555; font-size: 9.5pt; break-after: avoid; page-break-after: avoid; break-inside: avoid; page-break-inside: avoid; }
.key-move { display: flex; gap: 5mm; align-items: flex-start; margin: 0 0 5mm; padding: 3mm; border: 0.3mm solid #cbb78d; border-radius: 2mm; break-inside: avoid; page-break-inside: avoid; }
.key-move .board { flex: 0 0 62mm; }
.key-move .board svg { width: 62mm; height: auto; display: block; }
.key-move .body { flex: 1 1 auto; min-width: 0; }
.key-move svg text { font: 17px "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif; }
.tag { display: inline-block; padding: 0 1.5mm; border-radius: 1mm; font-size: 9pt; background: #eee; border: 0.2mm solid #bbb; }
.tag.bad { background: #fde8e8; border-color: #d33; color: #a11; }
.tag.warn { background: #fff3d6; border-color: #d89b00; color: #7a5200; }
.tag.good { background: #e6f4ea; border-color: #3a9a55; color: #1d6b35; }
.advice { background: #f6f1e4; padding: 1.5mm 2.5mm; border-radius: 1mm; }
table.moves { width: 100%; border-collapse: collapse; table-layout: fixed; }
table.moves thead { display: table-header-group; }
table.moves th, table.moves td { border: 0.2mm solid #bbb; padding: 1mm 2mm; text-align: left; vertical-align: top; }
table.moves th { background: #f1ead8; }
table.moves tr { break-inside: avoid; page-break-inside: avoid; }
table.moves th.no, table.moves td.no { width: 14mm; text-align: center; color: #555; }
.better { display: block; color: #1971c2; font-size: 9pt; }
.you { background: #fffaf0; }
.footer { margin-top: 8mm; color: #777; font-size: 8.5pt; text-align: center; }
`;

interface Mark { ply: number; index: number; loss: number }

export function buildReviewPrintHtml(input: ReviewNoteInput, options: ReviewPrintOptions): string {
  const { userSide } = options;
  const level = options.level ?? "beginner";
  const { points, moves } = input;
  const sides = plySides(input.startFen, moves.length);
  const mine = (index: number): boolean => sides[index] === userSide;
  const notationOf = (index: number): string => input.notations[index] ?? P.unknownMove;
  const betterOf = (index: number): string | null => {
    const comparison = points[index]?.final.comparison;
    return comparison ? F.followUps(comparison).bestMove : null;
  };
  const flagged = (index: number): boolean => {
    const final = points[index]?.final;
    return Boolean(final) && mine(index) && (final!.lossPercent >= 2 || Boolean(final!.reason));
  };

  // The very same plies the review page lists as key moves (focusPoints + level filter), biggest loss first.
  const keys: Mark[] = focusPoints(points.map((point) => point.final), sides, userSide, options.shows ?? DEFAULT_SHOWS)
    .map((index) => ({ ply: index + 1, index, loss: points[index]!.final.lossPercent }))
    .sort((a, b) => b.loss - a.loss);

  const red = input.metadata.Red?.trim() || null;
  const black = input.metadata.Black?.trim() || null;
  // Round numbers as the table shows them; a black-first start leaves the red cell of round 1 empty.
  const firstBlack = sides[0] === "black";
  const startNo = Number(input.startFen.trim().split(/\s+/)[5] ?? "1") || 1;
  const roundOf = (index: number): number => startNo + Math.floor((index + (firstBlack ? 1 : 0)) / 2);
  const where = (index: number): { round: number; side: string } => ({ round: roundOf(index), side: P.sideName[sides[index] ?? "red"]! });
  const resultLabel = input.result === "red_win" ? N.redWin : input.result === "black_win" ? N.blackWin : input.result === "draw" ? N.draw : N.undecided;

  const curveValues = points.map((point, index) => winProbabilityForUser(point.final.playedWinProbability, sides[index] ?? "red", userSide));
  const curve = buildCurveSvg(curveValues, P.curveLabel, P.curveTitle);

  const header = `<section data-print-section="header"><h2>${P.headings.header}</h2><ul class="meta">`
    + `<li>${N.date}：${esc(input.reportDate)}</li><li>${esc(P.players(red, black))}</li><li>${N.result}：${resultLabel}</li>`
    + `<li>${P.youPlay}：${P.sideName[userSide]}</li></ul></section>`;
  const curveSection = `<section data-print-section="curve"><h2>${P.headings.curve}</h2><div class="curve">${curve}</div><p class="hint">${P.curveCaption}</p></section>`;
  // No key moves is not the same as no problems: smaller ones are still counted below.
  const emptyKeys = points.some((_, index) => flagged(index)) ? P.keyEmptyButProblems : N.clean;
  const summary = `<section data-print-section="summary"><h2>${P.headings.summary}</h2><p>${keys.length
    ? P.total(moves.length, where(keys[0]!.index).round, where(keys[0]!.index).side, keys[0]!.loss.toFixed(1)) : emptyKeys}</p></section>`;

  const moments = keys.map(({ index, ply, loss }) => {
    const final = points[index]!.final;
    const better = betterOf(index);
    const board = input.boards[index] ?? "";
    const svg = board.length === 90
      ? buildBoardSvg(board, N.boardTitle(ply), {
        flipped: userSide === "black", colorText: true,
        ...(arrowOf(moves[index]) ? { played: arrowOf(moves[index])! } : {}),
        ...(final.bestMove !== moves[index] && arrowOf(final.bestMove) ? { best: arrowOf(final.bestMove)! } : {}),
      }) : "";
    const reason = final.reason ? zhTW.review.reason(final.reason, level) : "";
    const advice = final.reason ? F.advice[final.reason.kind] : undefined;
    const sentences = final.comparison ? zhTW.review.comparison(final.comparison) : null;
    return `<article class="key-move" data-key-move="${ply}"><div class="board">${svg}</div><div class="body">`
      + `<h3>${P.momentTitle(where(index).round, where(index).side)}　${tag(final.classification)}　${P.lossText(loss.toFixed(1))}</h3>`
      + `<p><b>${P.played}</b>：${esc(notationOf(index))}</p>`
      + (better ? `<p><b>${P.better}</b>：${esc(better)}</p>` : "")
      + (reason ? `<p><b>${P.reasonLabel}</b>：${esc(reason)}</p>` : "")
      + (sentences ? `<p>${esc(sentences.played)}</p><p>${esc(sentences.best)}</p>` : "")
      + (advice ? `<p class="advice"><b>${P.adviceLabel}</b>：${esc(advice)}</p>` : "")
      + `</div></article>`;
  });
  const keySection = `<section data-print-section="key-moves"><h2>${P.headings.keyMoves}</h2>`
    + (keys.length ? `<p class="hint">${P.keyIntro(keys.length)}${P.legend}</p>${moments.join("")}` : `<p>${emptyKeys}</p>`) + `</section>`;

  const cell = (index: number): string => {
    const final = points[index]?.final;
    const user = mine(index);
    const better = user && final && final.lossPercent >= 2 ? betterOf(index) : null;
    return `<td data-ply-cell="${index + 1}"${user ? ' class="you"' : ""}>${esc(notationOf(index))}`
      + (user && final ? ` ${tag(final.classification)}` : "") + (better ? `<span class="better">${esc(P.betterNote(better))}</span>` : "") + `</td>`;
  };
  const rows: string[] = [];
  let index = 0;
  for (let n = 0; index < moves.length; n += 1) {
    const redCell = firstBlack && n === 0 ? "<td></td>" : cell(index++);
    const blackCell = index < moves.length ? cell(index++) : "<td></td>";
    rows.push(`<tr data-move-row><td class="no">${startNo + n}</td>${redCell}${blackCell}</tr>`);
  }
  const youMark = (side: ReviewSide) => (userSide === side ? P.youMark : "");
  const table = `<section data-print-section="moves"><h2>${P.headings.moves}</h2><table class="moves"><thead><tr><th class="no">${P.moveNo}</th>`
    + `<th>${P.red}${youMark("red")}</th><th>${P.black}${youMark("black")}</th></tr></thead><tbody>${rows.join("")}</tbody></table></section>`;

  const flaggedPoints = points.map((_, i) => i).filter(flagged).map((i) => points[i]!.final);
  const count = (kind: ReviewReasonKind) => flaggedPoints.filter((point) => point.reason?.kind === kind).length;
  const unknown = flaggedPoints.filter((point) => !point.reason).length;
  const optionalKinds: ReviewReasonKind[] = ["dropped_material", "sent_piece", "cannon_mount", "missed_material", "abandoned_protection", "check_capture", "position_type"];
  const lines = [
    N.kindCount(N.kindLabels.walked_into_mate, count("walked_into_mate")),
    N.kindCount(N.kindLabels.missed_mate, count("missed_mate")),
    ...optionalKinds.filter((kind) => count(kind) > 0).map((kind) => N.kindCount(N.kindLabels[kind], count(kind))),
    ...(unknown > 0 ? [N.unknownCount(unknown)] : []),
  ];
  // 局面型 is the catch-all reason, so it never becomes the focus.
  const ranked = (["walked_into_mate", "missed_mate", ...optionalKinds.filter((kind) => kind !== "position_type")] as ReviewReasonKind[])
    .map((kind) => ({ kind, value: count(kind) })).filter((item) => item.value > 0).sort((a, b) => b.value - a.value);
  const top = ranked.length && (ranked.length === 1 || ranked[0]!.value > ranked[1]!.value) ? ranked[0]!.kind : null;
  const improve = `<section data-print-section="improve"><h2>${P.headings.improve}</h2>`
    + (flaggedPoints.length
      ? `<p>${P.countsIntro}</p><ul>${lines.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>`
        + `<p class="advice"><b>${F.nextTime}</b>：${top ? esc(`${P.focusKind(N.kindLabels[top])}${F.advice[top] ?? ""}`) : P.focusNone}</p>`
      : `<p>${N.clean}</p><p class="advice"><b>${F.nextTime}</b>：${P.focusNone}</p>`)
    + `</section>`;

  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${P.docTitle}</title><style>${STYLE}</style></head><body><h1>${P.docTitle}</h1>`
    + `${header}${curveSection}${summary}${keySection}${table}${improve}<p class="footer">${P.footer}</p></body></html>`;
}

function tag(classification: string): string {
  if (classification === "unclassified") return "";
  const label = zhTW.review.classification(classification as Parameters<typeof zhTW.review.classification>[0]);
  const tone = classification === "good" || classification === "unique_move" ? "good"
    : classification === "inaccuracy" || classification === "doubtful_move" ? "warn"
      : "bad";
  return `<span class="tag ${tone}">${esc(label)}</span>`;
}

function arrowOf(move: string | undefined): { from: string; to: string } | null {
  return move && /^[a-i][0-9][a-i][0-9]$/.test(move) ? { from: move.slice(0, 2), to: move.slice(2) } : null;
}
