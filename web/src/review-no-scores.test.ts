import { describe, expect, it } from "vitest";
import { zhTW } from "./locale/zh-TW";
import { REVIEW_REASON_KINDS } from "./review-client";
import type { ReviewExplanationLevel, ReviewPiece, ReviewReason, ReviewReasonKind } from "./review-client";

// TEST_PLAN 6.3.13: no ordinary-screen review sentence shows scores, nodes or depth.
// Expected to be red until the sentence templates are reworded (move-comparison batch, step H).

const LEVELS: ReviewExplanationLevel[] = ["beginner", "intermediate", "proficient"];
const redHorse: ReviewPiece = { side: "red", kind: "horse" };
const redCannon: ReviewPiece = { side: "red", kind: "cannon" };
const redRook: ReviewPiece = { side: "red", kind: "rook" };
const blackRook: ReviewPiece = { side: "black", kind: "rook" };
const blackPawn: ReviewPiece = { side: "black", kind: "pawn" };
const blackHorse: ReviewPiece = { side: "black", kind: "horse" };

const material = {
  mover: "red" as const,
  bestNet: 600,
  playedNet: -600,
  plies: 2,
  bestCaptures: [{ piece: blackPawn, square: "a5", capturer: "red" as const, ply: 1 }],
  playedCaptures: [{ piece: redRook, square: "a0", capturer: "black" as const, ply: 2 }],
};

const samples: Record<ReviewReasonKind, ReviewReason> = {
  walked_into_mate: { kind: "walked_into_mate", moves: 2 },
  missed_mate: { kind: "missed_mate", moves: 3 },
  dropped_material: { kind: "dropped_material", moves: 0, material },
  missed_material: { kind: "missed_material", moves: 0, material },
  sent_piece: {
    kind: "sent_piece",
    moves: 0,
    protection: {
      piece: redHorse, from: "b2", to: "c4", capturedAt: "c4", capturer: "black",
      attacker: blackPawn, net: -300, protectedPiece: null, protectedSquare: null,
    },
  },
  abandoned_protection: {
    kind: "abandoned_protection",
    moves: 0,
    protection: {
      piece: redRook, from: "a5", to: "a4", capturedAt: "b5", capturer: "black",
      attacker: blackRook, net: -300, protectedPiece: redCannon, protectedSquare: "b5",
    },
  },
  cannon_mount: {
    kind: "cannon_mount",
    moves: 0,
    cannonMount: {
      screen: redHorse, screenSquare: "a2", cannon: { side: "black", kind: "cannon" }, cannonFrom: "a5",
      victim: redRook, victimSquare: "a0", net: -600,
    },
  },
  check_capture: {
    kind: "check_capture",
    moves: 0,
    checkCapture: { victim: redHorse, victimSquare: "e3", attacker: blackRook, attackerFrom: "a3", net: -300 },
  },
  position_type: {
    kind: "position_type",
    moves: 0,
    position: { component: "mobility", playedValue: 36, bestValue: 40, mobilityBefore: 11, mobilityAfter: 4 },
  },
};

const SCORE_WORDS = /\d+\s*分|cp|centipawn|節點|深度/;

function allReasons(): Array<[string, ReviewReason]> {
  const list: Array<[string, ReviewReason]> = Object.entries(samples);
  for (const component of ["material", "position", "mobility", "king_safety"] as const) {
    list.push([`position_type/${component}`, {
      kind: "position_type", moves: 0,
      position: { component, playedValue: 10, bestValue: 14, mobilityBefore: 11, mobilityAfter: 4 },
    }]);
  }
  // The other side to move, and a release of protection that names no protected piece.
  list.push(["sent_piece/black", {
    kind: "sent_piece", moves: 0,
    protection: {
      piece: { side: "black", kind: "cannon" }, from: "b7", to: "b4", capturedAt: "b4", capturer: "red",
      attacker: { side: "red", kind: "pawn" }, net: -300, protectedPiece: null, protectedSquare: null,
    },
  }]);
  list.push(["abandoned_protection/unnamed", {
    kind: "abandoned_protection", moves: 0,
    protection: {
      piece: redRook, from: "a5", to: "a4", capturedAt: "b5", capturer: "black",
      attacker: blackHorse, net: -120, protectedPiece: null, protectedSquare: null,
    },
  }]);
  return list;
}

describe("no scores on the ordinary screen (TEST_PLAN 6.3.13)", () => {
  it("covers every reason kind the engine can emit", () => {
    expect(Object.keys(samples).sort()).toEqual([...REVIEW_REASON_KINDS].sort());
  });

  it.each(allReasons())("%s has no score, node or depth wording at any level", (_name, reason) => {
    for (const level of LEVELS) {
      const text = zhTW.review.reason(reason, level);
      expect(text, `${level}: ${text}`).not.toMatch(SCORE_WORDS);
    }
  });

  // User 2026-10-16: ordinary users cannot read ICCS coordinates; positions belong to the board marks.
  it.each(allReasons())("%s shows no ICCS coordinate at any level", (_name, reason) => {
    for (const level of LEVELS) {
      const text = zhTW.review.reason(reason, level);
      expect(text, `${level}: ${text}`).not.toMatch(/\b[a-i][0-9]\b/);
    }
  });
});
