import { describe, expect, it } from "vitest";
import { isReviewPoint, normalizeSavedGameRecord, STANDARD_START_FEN } from "./game-library";

const board = "rnbakabnr" + "........." + ".c.....c." + "p.p.p.p.p" + "........." + "........." + "P.P.P.P.P" + ".C.....C." + "........." + "RNBAKABNR";
const candidate = { move: "h2e2", score: { centipawns: 20, mateIn: null }, pv: ["h2e2"], depth: 1, nodes: 100,
  pvEnd: "depth_limit", continuation: [], continuationNodeLimit: 100_000, continuationTerminal: false,
  replayAudit: { failedIndex: null }, continuationStatus: "minimum_reached" };
const result = { bestMove: "h2e2", playedMove: "h2e2", playedRank: 1, bestScore: { centipawns: 20, mateIn: null },
  playedScore: { centipawns: 20, mateIn: null }, bestWinProbability: 0.5, playedWinProbability: 0.5, lossPercent: 0,
  classification: "good", candidates: [candidate] };
const validPoint = { quick: result, final: result, deepened: false, continuationComplete: true };

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "kept-game", savedAt: 1, moves: ["h2e2"], startFen: STANDARD_START_FEN,
    source: "played", importFormat: null, importMetadata: {}, importWarnings: [], variationTree: null,
    reviewSnapshot: {
      startFen: STANDARD_START_FEN, moves: ["h2e2"], points: [null], boards: [board, board],
      analyzer: { name: "內建引擎", quickNodeLimit: 100_000, deepNodeLimit: 1_000_000, config: "SearchConfig::default()" },
      result: "unknown", reportDate: "2026-10-09",
    },
    reviewNote: { reportDate: "2026-10-09", markdown: "# note", plainText: "note", curveSvg: '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>' },
    ...overrides,
  };
}

describe("saved review artifacts are isolated from valid game records", () => {
  it("drops malformed points and unsafe notes while preserving the playable game", () => {
    const game = normalizeSavedGameRecord(row());
    expect(game?.id).toBe("kept-game");
    expect(game?.moves).toEqual(["h2e2"]);
    expect(game?.reviewSnapshot).toBeNull();
    expect(game?.reviewNote).toBeNull();
  });

  it("drops a snapshot whose analysis point fails its FEN/move position contract", () => {
    const invalid = row({ reviewSnapshot: {
      ...(row().reviewSnapshot as object),
      points: [{ quick: null, final: {}, deepened: false, continuationComplete: true }],
    } });
    const game = normalizeSavedGameRecord(invalid);
    expect(game).not.toBeNull();
    expect(game?.reviewSnapshot).toBeNull();
    expect(game?.reviewNote).toBeNull();
  });

  it("keeps a valid analysis while isolating a malformed note payload", () => {
    expect(isReviewPoint(validPoint, "h2e2")).toBe(true);
    expect(board).toHaveLength(90);
    expect(/^[prnbakcPRNBAKC.]{90}$/.test(board)).toBe(true);
    const source = row({
      reviewSnapshot: { ...(row().reviewSnapshot as object), points: [validPoint] },
      reviewNote: { reportDate: "2026-10-09", markdown: "# note", plainText: "note", curveSvg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' },
    });
    const game = normalizeSavedGameRecord(source);
    expect(game?.id).toBe("kept-game");
    expect(game?.reviewSnapshot).not.toBeNull();
    expect(game?.reviewNote).toBeNull();
  });

  it("rejects out-of-range or non-finite analysis values without discarding the game", () => {
    const point = structuredClone(validPoint) as { final: { playedWinProbability: number } } & typeof validPoint;
    point.final.playedWinProbability = Number.POSITIVE_INFINITY;
    const game = normalizeSavedGameRecord(row({ reviewSnapshot: { ...(row().reviewSnapshot as object), points: [point] } }));
    expect(game?.id).toBe("kept-game");
    expect(game?.reviewSnapshot).toBeNull();
  });

  it("keeps every engine reason kind and drops an unknown one", () => {
    const withReason = (reason: unknown) => ({ ...validPoint, final: { ...result, reason }, quick: result });
    const horse = { side: "red", kind: "horse" };
    const reasons = [
      { kind: "walked_into_mate", moves: 2 },
      { kind: "missed_mate", moves: 3 },
      { kind: "dropped_material", moves: 0, material: { mover: "red", bestNet: 600, playedNet: -600, plies: 2, bestCaptures: [], playedCaptures: [] } },
      { kind: "missed_material", moves: 0, material: { mover: "red", bestNet: 70, playedNet: 0, plies: 2, bestCaptures: [], playedCaptures: [] } },
      { kind: "sent_piece", moves: 0, protection: { piece: horse, from: "b2", to: "c4", capturedAt: "c4", capturer: "black", attacker: { side: "black", kind: "pawn" }, net: -300, protectedPiece: null, protectedSquare: null } },
      { kind: "abandoned_protection", moves: 0, protection: { piece: horse, from: "a5", to: "a4", capturedAt: "b5", capturer: "black", attacker: { side: "black", kind: "rook" }, net: -300, protectedPiece: { side: "red", kind: "cannon" }, protectedSquare: "b5" } },
      { kind: "check_capture", moves: 0, checkCapture: { victim: horse, victimSquare: "e3", attacker: { side: "black", kind: "rook" }, attackerFrom: "a3", net: -300 } },
      { kind: "position_type", moves: 0, position: { component: "mobility", playedValue: 36, bestValue: 40, mobilityBefore: 11, mobilityAfter: 4 } },
    ];
    for (const reason of reasons) expect(isReviewPoint(withReason(reason), "h2e2"), reason.kind).toBe(true);
    expect(isReviewPoint(withReason({ kind: "made_up", moves: 0 }), "h2e2")).toBe(false);
    expect(isReviewPoint(withReason({ kind: "sent_piece", moves: 0 }), "h2e2"), "evidence is required").toBe(false);
    expect(isReviewPoint(withReason({ kind: "walked_into_mate", moves: 0 }), "h2e2"), "a mate has a distance").toBe(false);
  });
});
