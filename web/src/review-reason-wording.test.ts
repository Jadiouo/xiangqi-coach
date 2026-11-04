import { describe, expect, it } from "vitest";
import { zhTW } from "./locale/zh-TW";
import type { ReviewExplanationLevel, ReviewPiece, ReviewReason } from "./review-client";

// Ordinary-screen wording (user 2026-10-16): pieces and step counts, never scores.

const LEVELS: ReviewExplanationLevel[] = ["beginner", "intermediate", "proficient"];
const horse: ReviewPiece = { side: "red", kind: "horse" };
const pawn: ReviewPiece = { side: "black", kind: "pawn" };
const rook: ReviewPiece = { side: "red", kind: "rook" };

const dropped: ReviewReason = {
  kind: "dropped_material", moves: 0,
  material: {
    mover: "red", bestNet: 0, playedNet: -230, plies: 3,
    bestCaptures: [],
    playedCaptures: [
      { piece: horse, square: "c4", capturer: "black", ply: 2 },
      { piece: pawn, square: "c5", capturer: "red", ply: 3 },
    ],
  },
};
const missed: ReviewReason = {
  kind: "missed_material", moves: 0,
  material: {
    mover: "red", bestNet: 600, playedNet: 0, plies: 2,
    bestCaptures: [{ piece: { side: "black", kind: "rook" }, square: "a5", capturer: "red", ply: 1 }],
    playedCaptures: [],
  },
};

describe("material wording", () => {
  it("lists what each side loses by piece, at every level", () => {
    for (const level of LEVELS) {
      const text = zhTW.review.reason(dropped, level);
      expect(text, level).toContain("你會少一匹馬");
      expect(text, level).toContain("對方少一個卒");
    }
  });

  it("merges pieces of one kind into a count (兩匹馬), keeps others apart", () => {
    const horse = { side: "red" as const, kind: "horse" as const };
    const cap = (piece: { side: "red" | "black"; kind: string }, ply: number) => ({ piece, square: "a0", capturer: "black" as const, ply });
    const reason = (pieces: { side: "red" | "black"; kind: string }[], theirs: { side: "red" | "black"; kind: string }[] = []): ReviewReason => ({
      kind: "dropped_material", moves: 0,
      material: { mover: "red", bestNet: 0, playedNet: -1200, plies: 4, bestCaptures: [],
        playedCaptures: [...pieces.map((p, i) => cap(p, i + 1)), ...theirs.map((p, i) => ({ ...cap(p, i + 5), capturer: "red" as const }))] },
    } as unknown as ReviewReason);
    for (const level of LEVELS) {
      const two = zhTW.review.reason(reason([horse, horse]), level);
      expect(two, level).toContain("你會少兩匹馬");
      expect(two, level).not.toContain("一匹馬、一匹馬");
      expect(zhTW.review.reason(reason([horse, horse, horse]), level), level).toContain("三匹馬");
      const mixed = zhTW.review.reason(reason([horse, { side: "red", kind: "rook" }, horse]), level);
      expect(mixed, level).toContain("兩匹馬");
      expect(mixed, level).toContain("一輛車");
      expect(zhTW.review.reason(reason([horse], [{ side: "black", kind: "pawn" }, { side: "black", kind: "pawn" }]), level), level).toContain("對方少兩個卒");
      expect(zhTW.review.reason(reason([{ side: "red", kind: "cannon" }, { side: "red", kind: "cannon" }]), level), level).toContain("兩門炮");
    }
  });

  it("names the piece a missed capture would have won", () => {
    for (const level of LEVELS) {
      const text = zhTW.review.reason(missed, level);
      expect(text, level).toContain("車");
    }
  });

  it("falls back to a piece-free sentence when nothing is captured on the played line", () => {
    const none: ReviewReason = { kind: "dropped_material", moves: 0, material: { ...(dropped as any).material, playedCaptures: [{ piece: rook, square: "a0", capturer: "red", ply: 1 }] } };
    for (const level of LEVELS) expect(zhTW.review.reason(none, level)).not.toMatch(/undefined|NaN/);
  });
});

describe("position wording", () => {
  const base = { kind: "position_type", moves: 0 } as const;
  it("says how many steps the mover can make for mobility", () => {
    const blocked: ReviewReason = { ...base, position: { component: "mobility", playedValue: 36, bestValue: 40, mobilityBefore: 11, mobilityAfter: 4 } };
    for (const level of LEVELS) {
      const text = zhTW.review.reason(blocked, level);
      expect(text, level).toContain("11");
      expect(text, level).toContain("4");
      expect(text, level).not.toContain("36");
    }
  });

  it("states the mobility change even when it is small", () => {
    const flat: ReviewReason = { ...base, position: { component: "mobility", playedValue: 36, bestValue: 40, mobilityBefore: 41, mobilityAfter: 40 } };
    for (const level of LEVELS) {
      const text = zhTW.review.reason(flat, level);
      expect(text, level).toContain("從 41 步變成 40 步");
      expect(text, level).not.toContain("36");
      expect(text, level).not.toContain("被擋住");
    }
  });

  it("gives other components one qualitative sentence with no numbers", () => {
    for (const component of ["material", "position", "king_safety"] as const) {
      const reason: ReviewReason = { ...base, position: { component, playedValue: 10, bestValue: 14, mobilityBefore: 11, mobilityAfter: 4 } };
      for (const level of LEVELS) expect(zhTW.review.reason(reason, level), `${component} ${level}`).not.toMatch(/\d/);
    }
  });
});

describe("small wording rules", () => {
  it("does not list mobility numbers when the count did not change", () => {
    const same: ReviewReason = { kind: "position_type", moves: 0, position: { component: "mobility", playedValue: 36, bestValue: 40, mobilityBefore: 20, mobilityAfter: 20 } };
    for (const level of LEVELS) {
      const text = zhTW.review.reason(same, level);
      expect(text, level).toContain("不如最佳走法");
      expect(text, level).not.toMatch(/\d/);
    }
  });

  it("says 子力 rather than 優勢 in the beginner material sentence", () => {
    const reason: ReviewReason = { kind: "position_type", moves: 0, position: { component: "material", playedValue: 10, bestValue: 14, mobilityBefore: 11, mobilityAfter: 4 } };
    const text = zhTW.review.reason(reason, "beginner");
    expect(text).toContain("子力");
    expect(text).not.toContain("優勢");
  });
});
