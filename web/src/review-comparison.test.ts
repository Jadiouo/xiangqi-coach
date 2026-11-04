import { afterEach, describe, expect, it, vi } from "vitest";
import { zhTW } from "./locale/zh-TW";
import { createReviewComparisonElement } from "./review-comparison";
import type { ReviewComparison, ReviewLineStep } from "./review-client";

const step = (iccs: string, notation: string, side: "red" | "black", captured: ReviewLineStep["captured"] = null): ReviewLineStep =>
  ({ iccs, notation, side, captured });
const comparison = (over: Partial<ReviewComparison> = {}): ReviewComparison => ({
  playedLine: [step("h9g7", "馬8進7", "black"), step("h0g2", "馬二進三", "red")],
  bestLine: [step("h2e2", "炮二平五", "red"), step("h9g7", "馬8進7", "black")],
  playedComplete: true,
  bestComplete: true,
  playedSettled: true,
  bestSettled: true,
  ...over,
});

describe("comparison sentences (SPEC 8.4.1)", () => {
  it("names both lines in Chinese notation, hedged as the engine's expectation", () => {
    const text = zhTW.review.comparison(comparison());
    // The mover is whoever plays the best line's first step; each step says who plays it.
    expect(text.played).toContain("你這樣走，接下來會是：對方馬8進7、你馬二進三");
    // The first step sits in the brackets only; the rest follows.
    expect(text.best).toContain("改走〔炮二平五〕，接下來會是：對方馬8進7");
    expect(text.best.match(/炮二平五/g)).toHaveLength(1);
    expect(`${text.played}${text.best}`).not.toMatch(/紅|黑/);
    expect(text.played).toContain("引擎預期");
    expect(text.best).toContain("引擎預期");
    expect(`${text.played}${text.best}`).not.toMatch(/一定/);
    expect(`${text.played}${text.best}`).not.toMatch(/\d+\s*分|cp|centipawn|節點|深度/);
  });

  it("says where the engine stopped when a line is not complete", () => {
    const text = zhTW.review.comparison(comparison({ playedComplete: false }));
    expect(text.played).toContain("（引擎只算到這裡）");
    expect(text.best).not.toContain("（引擎只算到這裡）");
  });

  it("marks the captured piece right after the step that takes it", () => {
    const text = zhTW.review.comparison(comparison({
      playedLine: [step("c5c4", "卒7進1", "black", { side: "red", kind: "horse" })],
    }));
    // The mover is red here, so the red horse is "your" horse.
    expect(text.played).toContain("對方卒7進1（吃你的馬）");
  });

  it("marks a capture of the opponent's piece from the best line", () => {
    const text = zhTW.review.comparison(comparison({
      bestLine: [step("c3c4", "兵七進一", "red", { side: "black", kind: "pawn" })],
    }));
    expect(text.best).toContain("改走〔兵七進一〕（吃對方的卒）");
    expect(text.best).not.toContain("接下來會是");
  });

  it("notes an open exchange and stays quiet about it otherwise", () => {
    const open = zhTW.review.comparison(comparison({ bestSettled: false }));
    expect(open.best).toContain("交換還沒結束");
    expect(open.played).not.toContain("交換還沒結束");
    const closed = zhTW.review.comparison(comparison());
    expect(`${closed.played}${closed.best}`).not.toContain("交換還沒結束");
  });

  it("treats a missing settled flag (older data) as settled", () => {
    const old = comparison() as Partial<ReviewComparison>;
    delete old.playedSettled;
    delete old.bestSettled;
    const text = zhTW.review.comparison(old as ReviewComparison);
    expect(`${text.played}${text.best}`).not.toContain("交換還沒結束");
  });

  it("handles a played line that ends the game", () => {
    const text = zhTW.review.comparison(comparison({ playedLine: [] }));
    expect(text.played.length).toBeGreaterThan(6);
    expect(text.played).not.toMatch(/undefined|NaN|\[object/);
  });
});

describe("comparison element", () => {
  afterEach(() => vi.unstubAllGlobals());
  const fakeDocument = () => {
    const make = (tag: string) => ({ tagName: tag.toUpperCase(), dataset: {} as Record<string, string>, textContent: "", children: [] as unknown[],
      append(...nodes: unknown[]) { this.children.push(...nodes); } });
    vi.stubGlobal("document", { createElement: vi.fn(make) });
  };

  it("shows nothing for an old save without a comparison", () => {
    fakeDocument();
    expect(createReviewComparisonElement(undefined)).toBeNull();
    expect(createReviewComparisonElement(null)).toBeNull();
  });

  it("renders a data-review-comparison block with both sentences", () => {
    fakeDocument();
    const element = createReviewComparisonElement(comparison()) as unknown as { dataset: Record<string, string>; children: Array<{ textContent: string }> };
    expect(element).not.toBeNull();
    expect(element.dataset.reviewComparison).toBeDefined();
    const texts = element.children.map((child) => child.textContent);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("你這樣走，接下來會是：");
    expect(texts[1]).toContain("改走〔炮二平五〕");
  });
});
