import { expect, test } from "@playwright/test";
import type { ReviewPlyResult } from "../src/review-client";

// Real wasm review of a one-move game that walks into mate (same fixture as m8-worker-reason):
// the blunder must carry a played-versus-best comparison in Chinese notation, and the ordinary
// screen text (reason and comparison elements only; the candidate list is untouched) must show
// no scores, nodes, depth or ICCS coordinates. Not run locally; written for the cloud E2E run.
test("a real review of a blunder shows a Chinese-notation comparison and no developer data", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  const shown = await page.evaluate(async () => {
    const { ReviewWorkerClient } = await import("/src/review-client.ts");
    const { createReviewComparisonElement } = await import("/src/review-comparison.ts");
    const { createReviewReasonElement } = await import("/src/review-reason.ts");
    const worker = new Worker(new URL("/src/review.worker.ts", location.origin), { type: "module" });
    const fen = "2R6/9/5k3/9/r8/2C6/9/6R2/9/2C1K4 w - - 0 1";
    const final = await new Promise<ReviewPlyResult>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        worker.terminate();
        reject(new Error("real review worker did not complete before timeout"));
      }, 150_000);
      const client = new ReviewWorkerClient(worker, (state) => {
        if (state.status === "failed") {
          window.clearTimeout(timeout);
          worker.terminate();
          reject(new Error(state.error ?? "review worker failed"));
          return;
        }
        if (state.status !== "complete") return;
        window.clearTimeout(timeout);
        worker.terminate();
        const point = state.points[0];
        if (!point) reject(new Error("completed worker result has no review point"));
        else resolve(point.final);
      });
      client.start(["c0d0"], 100_000, fen);
    });
    const host = document.createElement("div");
    host.id = "comparison-probe";
    if (final.reason) host.append(createReviewReasonElement(final.reason, "beginner"));
    const comparison = createReviewComparisonElement(final.comparison);
    if (comparison) host.append(comparison);
    document.body.append(host);
    return { hasComparison: Boolean(final.comparison), classification: final.classification };
  });
  expect(shown.hasComparison).toBe(true);
  expect(["doubtful_move", "mistake", "blunder", "missed_mate"]).toContain(shown.classification);

  const block = page.locator("#comparison-probe [data-review-comparison]");
  await expect(block).toHaveCount(1);
  const comparisonText = await block.innerText();
  expect(comparisonText).toContain("你這樣走，接下來會是：");
  expect(comparisonText).toMatch(/[一二三四五六七八九１-９1-9][進退平]/);
  expect(comparisonText).toMatch(/你|對方/);
  expect(comparisonText).not.toMatch(/紅|黑/);

  const ordinary = await page.locator("#comparison-probe").innerText();
  expect(ordinary).not.toMatch(/\d+\s*分|節點|深度|centipawn|\bcp\b/);
  expect(ordinary).not.toMatch(/\b[a-i][0-9]\b/);
});
