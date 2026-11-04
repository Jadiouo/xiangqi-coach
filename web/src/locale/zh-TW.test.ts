import { describe, expect, it } from "vitest";
import { zhTW } from "./zh-TW";
import type { ReviewReason } from "../review-client";
import { REVIEW_REASON_KINDS } from "../review-client";

describe("mate explanation wording", () => {
  it("provides distinct complete wording for the three supported voice groups", () => {
    const reason = { kind: "walked_into_mate" as const, moves: 2 };
    const beginner = zhTW.review.reason(reason, "beginner");
    const intermediate = zhTW.review.reason(reason, "intermediate");
    const proficient = zhTW.review.reason(reason, "proficient");
    expect(beginner).toContain("引擎算到");
    expect(beginner).toContain("2 步");
    expect(intermediate).toContain("2 步殺");
    expect(proficient).toContain("入 2 步殺");
    for (const text of [beginner, intermediate, proficient]) {
      expect(text).toContain("引擎算到");
      expect(text).not.toMatch(/[{}]/);
    }
  });

  it("names the missed mating chance at each voice level", () => {
    const reason = { kind: "missed_mate" as const, moves: 3 };
    expect(zhTW.review.reason(reason, "beginner")).toContain("錯過了");
    expect(zhTW.review.reason(reason, "intermediate")).toContain("實戰未走");
    expect(zhTW.review.reason(reason, "proficient")).toBe("引擎算到：漏了 3 步殺。");
  });

  it.each([
    ["dropped_material", "一輛車", "淨少", "實走", 600],
    ["missed_material", "一個卒", "錯過", "漏了", 70],
  ] as const)("explains %s with concrete material evidence at all voice levels", (kind, pieceText, beginnerHint, proficientHint, amount) => {
    const reason: ReviewReason = kind === "dropped_material"
      ? {
          kind,
          moves: 0,
          material: {
            mover: "red",
            bestNet: amount,
            playedNet: -amount,
            plies: 2,
            bestCaptures: [],
            playedCaptures: [{ piece: { side: "red", kind: "rook" }, square: "a0", capturer: "black", ply: 2 }],
          },
        }
      : {
          kind,
          moves: 0,
          material: {
            mover: "red",
            bestNet: amount,
            playedNet: 0,
            plies: 2,
            bestCaptures: [{ piece: { side: "black", kind: "pawn" }, square: "a5", capturer: "red", ply: 1 }],
            playedCaptures: [],
          },
        };
    const texts = (["beginner", "intermediate", "proficient"] as const).map((level) => zhTW.review.reason(reason, level));
    expect(texts[0]).toContain(beginnerHint);
    expect(texts[2]).toContain(proficientHint);
    for (const text of texts) {
      expect(text).toContain(pieceText);
      expect(text).not.toContain(String(amount));
      expect(text).not.toMatch(/[{}]/);
    }
  });
});

describe("review note fault labels", () => {
  it("has a non-empty label for exactly the REVIEW_REASON_KINDS", () => {
    const labels = zhTW.reviewNote.kindLabels as Record<string, string>;
    expect(Object.keys(labels).sort()).toEqual([...REVIEW_REASON_KINDS].sort());
    expect(REVIEW_REASON_KINDS).toHaveLength(9);
    for (const kind of REVIEW_REASON_KINDS) expect(labels[kind]?.trim()).toBeTruthy();
  });
});
