import { describe, expect, it } from "vitest";
import type { ReviewReason } from "./review-client";
import {
  buildArrowPlan,
  focusNav,
  focusPoints,
  liveWinProbabilityForUser,
  winProbabilityForUser,
} from "./review-presentation";

describe("review win probability perspective", () => {
  it("keeps the curve on the selected user's side when the mover changes", () => {
    expect(winProbabilityForUser(0.7, "red", "red")).toBeCloseTo(0.7);
    expect(winProbabilityForUser(0.7, "black", "red")).toBeCloseTo(0.3);
    expect(winProbabilityForUser(0.7, "red", "black")).toBeCloseTo(0.3);
    expect(winProbabilityForUser(0.7, "black", "black")).toBeCloseTo(0.7);
  });
});

describe("live game win probability", () => {
  it("maps the engine's side-to-move score to the human's side", () => {
    expect(liveWinProbabilityForUser(300, "red", "red")).toBeCloseTo(1 / (1 + Math.exp(-1)));
    expect(liveWinProbabilityForUser(300, "black", "red")).toBeCloseTo(1 / (1 + Math.exp(1)));
    expect(liveWinProbabilityForUser(-300, "red", "black")).toBeCloseTo(1 / (1 + Math.exp(-1)));
    expect(liveWinProbabilityForUser(-300, "black", "black")).toBeCloseTo(1 / (1 + Math.exp(1)));
  });
});

const redHorse = { side: "red", kind: "horse" } as const;
const blackRook = { side: "black", kind: "rook" } as const;

describe("review arrow plan", () => {
  it("draws the played move and the better move from their own squares", () => {
    const plan = buildArrowPlan({ playedMove: "h2e2", bestMove: "b2e2", reason: null });
    expect(plan.played).toEqual({ from: "h2", to: "e2" });
    expect(plan.best).toEqual({ from: "b2", to: "e2" });
    expect(plan.danger).toEqual([]);
  });

  it("outputs no best arrow without a best move or when it equals the played move", () => {
    expect(buildArrowPlan({ playedMove: "h2e2", bestMove: "", reason: null }).best).toBeNull();
    expect(buildArrowPlan({ playedMove: "h2e2", bestMove: "h2e2", reason: null }).best).toBeNull();
    expect(buildArrowPlan({ playedMove: "h2e2", bestMove: "", reason: null }).played).toEqual({ from: "h2", to: "e2" });
  });

  it("outputs no arrows for malformed moves", () => {
    const plan = buildArrowPlan({ playedMove: "xx", bestMove: "h2", reason: null });
    expect(plan.played).toBeNull();
    expect(plan.best).toBeNull();
  });

  // Pre-move board (90 chars, row 0 = rank 9) built from a square -> piece map; "." elsewhere.
  const boardOf = (pieces: Record<string, string>): string => {
    const cells = Array.from({ length: 90 }, () => ".");
    for (const [square, piece] of Object.entries(pieces)) {
      cells[(9 - Number(square[1])) * 9 + (square.charCodeAt(0) - 97)] = piece;
    }
    return cells.join("");
  };
  const sentFrom = (board: string, capturedAt: string, extra: Partial<{ playedMove: string }> = {}) =>
    buildArrowPlan({
      playedMove: extra.playedMove ?? "h0g2",
      bestMove: "b0c2",
      mover: "red",
      board,
      reason: {
        kind: "sent_piece", moves: 0,
        protection: { piece: redHorse, from: "h0", to: "g2", capturedAt, capturer: "black", attacker: blackRook, net: -400, protectedPiece: null, protectedSquare: null },
      },
    }).danger;

  it("circles a sent piece where it stood before the move (the review names the square it lands on)", () => {
    // landing square g2 is empty before the move: the ring goes on the origin h0
    expect(sentFrom(boardOf({ h0: "N", e0: "K" }), "g2")).toEqual(["h0"]);
  });

  it("never circles the enemy piece the sent piece captured", () => {
    // the move itself captures a black rook on g2; the ring still goes on the horse's origin, not on g2
    expect(sentFrom(boardOf({ h0: "N", g2: "r", e0: "K" }), "g2")).toEqual(["h0"]);
  });

  it("draws nothing when the pre-move board has no matching piece of the mover on that square", () => {
    expect(sentFrom(boardOf({ e0: "K" }), "g2")).toEqual([]);
    expect(sentFrom(boardOf({ h0: "n", e0: "K" }), "g2")).toEqual([]);
    expect(sentFrom(boardOf({ h0: "R", e0: "K" }), "g2")).toEqual([]);
    expect(buildArrowPlan({ playedMove: "h0g2", bestMove: "b0c2", mover: "red", reason: {
      kind: "sent_piece", moves: 0,
      protection: { piece: redHorse, from: "h0", to: "g2", capturedAt: "g2", capturer: "black", attacker: blackRook, net: -400, protectedPiece: null, protectedSquare: null },
    } }).danger).toEqual([]);
  });

  it("circles an attacked piece that did not move on its own square", () => {
    const abandoned: ReviewReason = {
      kind: "abandoned_protection", moves: 0,
      protection: { piece: redHorse, from: "h0", to: "g2", capturedAt: "e3", capturer: "black", attacker: blackRook, net: -400, protectedPiece: redHorse, protectedSquare: "e3" },
    };
    const plan = buildArrowPlan({ playedMove: "h0g2", bestMove: "b0c2", mover: "red", board: boardOf({ h0: "N", e3: "N" }), reason: abandoned });
    expect(plan.danger).toEqual(["e3"]);
  });

  it("circles cannon-mount and check-capture victims, and drops the first lost piece of a dropped-material line only if it stood there", () => {
    const mount: ReviewReason = {
      kind: "cannon_mount", moves: 0,
      cannonMount: { screen: redHorse, screenSquare: "e4", cannon: blackRook, cannonFrom: "e9", victim: redHorse, victimSquare: "e0", net: -500 },
    };
    const check: ReviewReason = {
      kind: "check_capture", moves: 0,
      checkCapture: { victim: redHorse, victimSquare: "c5", attacker: blackRook, attackerFrom: "c9", net: -400 },
    };
    const dropped: ReviewReason = {
      kind: "dropped_material", moves: 3,
      material: {
        mover: "red", bestNet: 0, playedNet: -400, plies: 3,
        bestCaptures: [],
        playedCaptures: [
          { piece: blackRook, square: "a9", capturer: "red", ply: 1 },
          { piece: redHorse, square: "d4", capturer: "black", ply: 2 },
        ],
      },
    };
    const circle = (reason: ReviewReason, pieces: Record<string, string>) =>
      buildArrowPlan({ playedMove: "h0g2", bestMove: "b0c2", mover: "red", board: boardOf(pieces), reason }).danger;
    expect(circle(mount, { h0: "N", e0: "N" })).toEqual(["e0"]);
    expect(circle(mount, { h0: "N" })).toEqual([]);
    expect(circle(check, { h0: "N", c5: "N" })).toEqual(["c5"]);
    expect(circle(dropped, { h0: "N", d4: "N" })).toEqual(["d4"]);
    expect(circle(dropped, { h0: "N" })).toEqual([]);
    expect(circle(dropped, { h0: "N", d4: "R" })).toEqual([]);
    const mate: ReviewReason = { kind: "walked_into_mate", moves: 2 };
    expect(circle(mate, { h0: "N" })).toEqual([]);
  });
});

describe("review focus list", () => {
  const points = [
    { classification: "good" },
    { classification: "mistake" },
    { classification: "unique_move" },
    { classification: "blunder" },
    { classification: "inaccuracy" },
    { classification: "unclassified" },
    { classification: "missed_mate" },
    { classification: "blunder" },
  ];
  const sides = ["red", "black", "red", "red", "black", "red", "red", "black"] as const;

  it("lists only the user's moves that are not good, in ply order", () => {
    expect(focusPoints(points, [...sides], "red")).toEqual([3, 6]);
    expect(focusPoints(points, [...sides], "black")).toEqual([1, 4, 7]);
  });

  it("applies the level filter when one is given", () => {
    const onlyBlunders = (classification: string) => classification === "blunder";
    expect(focusPoints(points, [...sides], "black", onlyBlunders)).toEqual([7]);
  });

  it("disables previous on the first item and next on the last", () => {
    const list = [3, 6, 9];
    expect(focusNav(list, 3)).toMatchObject({ position: 1, total: 3, prev: null, next: 6, prevDisabled: true, nextDisabled: false });
    expect(focusNav(list, 6)).toMatchObject({ position: 2, prev: 3, next: 9, prevDisabled: false, nextDisabled: false });
    expect(focusNav(list, 9)).toMatchObject({ position: 3, prev: 6, next: null, prevDisabled: false, nextDisabled: true });
  });

  it("moves to the neighbours when the selected move is not a focus move", () => {
    expect(focusNav([3, 6], 4)).toMatchObject({ position: null, prev: 3, next: 6, prevDisabled: false, nextDisabled: false });
    expect(focusNav([3, 6], 1)).toMatchObject({ position: null, prev: null, next: 3, prevDisabled: true, nextDisabled: false });
    expect(focusNav([], 0)).toMatchObject({ total: 0, prevDisabled: true, nextDisabled: true });
  });
});
