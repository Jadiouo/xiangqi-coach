import { describe, expect, it } from "vitest";
import { zhTW } from "./locale/zh-TW";
import { REVIEW_REASON_KINDS } from "./review-client";
import type { ReviewExplanationLevel, ReviewPiece, ReviewReason, ReviewReasonKind } from "./review-client";

// TEST_PLAN 6.3.10: every reason kind, at every explanation level, produces a sentence and
// leaves no placeholder behind.

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

const LEFTOVER = /[{}$]|undefined|NaN|null|Infinity|\[object|%s|%d/;

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

describe("reason templates (TEST_PLAN 6.3.10)", () => {
  it("has a sample for exactly the reason kinds the engine can emit", () => {
    expect(Object.keys(samples).sort()).toEqual([...REVIEW_REASON_KINDS].sort());
    expect(REVIEW_REASON_KINDS).toHaveLength(9);
  });

  it.each(allReasons())("%s yields a clean sentence at every level", (_name, reason) => {
    for (const level of LEVELS) {
      const text = zhTW.review.reason(reason, level);
      expect(typeof text).toBe("string");
      expect(text.length, `${level}`).toBeGreaterThan(6);
      expect(text, `${level}: ${text}`).not.toMatch(LEFTOVER);
      expect(text.trim()).toBe(text);
    }
  });

  it.each(allReasons())("%s reads differently for the three levels", (_name, reason) => {
    const texts = LEVELS.map((level) => zhTW.review.reason(reason, level));
    expect(new Set(texts).size).toBe(3);
  });

  it("names the concrete pieces from the evidence (squares belong to the board marks)", () => {
    const sent = LEVELS.map((level) => zhTW.review.reason(samples.sent_piece, level));
    for (const text of sent) expect(text).toMatch(/馬/);
    expect(sent[0]).toContain("卒");
    const abandoned = LEVELS.map((level) => zhTW.review.reason(samples.abandoned_protection, level));
    for (const text of abandoned) {
      expect(text).toContain("炮");
    }
    const check = LEVELS.map((level) => zhTW.review.reason(samples.check_capture, level));
    for (const text of check) {
      expect(text).toContain("將軍");
    }
    const mobility = LEVELS.map((level) => zhTW.review.reason(samples.position_type, level));
    for (const text of mobility) {
      expect(text).toContain("11");
      expect(text).toContain("4");
    }
  });

  it("keeps the beginner wording free of jargon", () => {
    for (const [name, reason] of allReasons()) {
      expect(zhTW.review.reason(reason, "beginner"), name).not.toMatch(/PV|抽將|歐拉|SEE|centipawn/i);
    }
  });

  it("does not repeat the possessive and does not claim a blocked position when mobility did not drop", () => {
    for (const reason of [samples.sent_piece, samples.abandoned_protection]) {
      for (const level of LEVELS) expect(zhTW.review.reason(reason, level), level).not.toContain("你把你的");
    }
    const flat: ReviewReason = {
      kind: "position_type", moves: 0,
      position: { component: "mobility", playedValue: 36, bestValue: 40, mobilityBefore: 41, mobilityAfter: 40 },
    };
    const blocked = zhTW.review.reason(samples.position_type, "beginner");
    expect(blocked).toContain("被擋住");
    for (const level of LEVELS) {
      const text = zhTW.review.reason(flat, level);
      expect(text, level).not.toContain("被擋住");
      expect(text, level).toContain("40");
      expect(text, level).not.toContain("36");
    }
    // Still three distinct wordings.
    expect(new Set(LEVELS.map((level) => zhTW.review.reason(flat, level))).size).toBe(3);
  });
});
