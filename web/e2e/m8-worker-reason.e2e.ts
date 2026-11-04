import { expect, test } from "@playwright/test";
import type { ReviewPlyResult, ReviewReason, ReviewWorkerResponse } from "../src/review-client";

test("the real review worker returns a typed mate reason from its completed deep pass", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { ReviewWorkerClient } = await import("/src/review-client.ts");
    const worker = new Worker(new URL("/src/review.worker.ts", location.origin), { type: "module" });
    const fen = "2R6/9/5k3/9/r8/2C6/9/6R2/9/2C1K4 w - - 0 1";
    return await new Promise<{
      deepened: boolean;
      deepReason: ReviewReason | null;
      finalReason: ReviewReason | null;
    }>((resolve, reject) => {
      let deepFinal: ReviewPlyResult | null = null;
      const timeout = window.setTimeout(() => {
        worker.terminate();
        reject(new Error("real review worker did not complete its deep pass before timeout"));
      }, 150_000);
      worker.addEventListener("message", ((event: MessageEvent<ReviewWorkerResponse>) => {
        const response = event.data;
        if (response.status === "point" && response.pass === "deep") {
          deepFinal = response.point.final;
        }
      }) as EventListener);
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
        if (!point) {
          reject(new Error("completed worker result has no review point"));
          return;
        }
        resolve({
          deepened: point.deepened,
          deepReason: deepFinal?.reason ?? null,
          finalReason: point.final.reason ?? null,
        });
      });
      client.start(["c0d0"], 100_000, fen);
    });
  });
  expect(result.deepened).toBe(true);
  // The DTO carries every evidence slot; a mate reason has none of them filled.
  expect(result.deepReason).toEqual({
    kind: "walked_into_mate",
    moves: 3,
    material: null,
    protection: null,
    checkCapture: null,
    cannonMount: null,
    position: null,
  });
  expect(result.finalReason).toEqual(result.deepReason);
});
