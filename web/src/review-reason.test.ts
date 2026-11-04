import { afterEach, describe, expect, it, vi } from "vitest";
import { createReviewReasonElement } from "./review-reason";

describe("review reason presentation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates the visible beginner-default annotation from a typed worker reason", () => {
    const element = { tagName: "P", dataset: {} as Record<string, string>, textContent: "" };
    vi.stubGlobal("document", { createElement: vi.fn(() => element) });
    const result = createReviewReasonElement({ kind: "walked_into_mate", moves: 3 });
    expect(result.dataset.reviewReason).toBe("walked_into_mate");
    expect(result.textContent).toContain("引擎算到");
    expect(result.textContent).toContain("3 步");
  });

  it("renders material reasons through the same typed worker boundary", () => {
    const element = { tagName: "P", dataset: {} as Record<string, string>, textContent: "" };
    vi.stubGlobal("document", { createElement: vi.fn(() => element) });
    const result = createReviewReasonElement({
      kind: "dropped_material",
      moves: 0,
      material: {
        mover: "red",
        bestNet: 600,
        playedNet: -600,
        plies: 2,
        bestCaptures: [],
        playedCaptures: [{ piece: { side: "red", kind: "rook" }, square: "a0", capturer: "black", ply: 2 }],
      },
    });
    expect(result.dataset.reviewReason).toBe("dropped_material");
    expect(result.textContent).toContain("車");
    expect(result.textContent).not.toMatch(/\b[a-i][0-9]\b/);
  });
});
