// Production-build smoke test. Run with E2E_PREVIEW=1 against a build served under a
// sub-path (default /xiangqi-coach/), as GitHub Pages would. Uses relative URLs only.
import { expect, test } from "@playwright/test";

test("desktop: WASM and Worker load under the sub-path, AI replies, undo restores the start", async ({ page }) => {
  const failed: string[] = [];
  page.on("response", (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1, name: "象棋教練" })).toBeVisible();
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  const startingFen = await page.locator("#board").getAttribute("data-fen");
  expect(startingFen).toBeTruthy();

  await page.locator('[data-square="h2"]').click();
  await expect(page.locator('[data-square="e2"] .legal-dot')).toBeVisible();
  const startedAt = Date.now();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list li")).toHaveCount(2, { timeout: 5_000 });
  expect(Date.now() - startedAt).toBeLessThan(5_000);
  await expect(page.locator("#move-list")).toContainText("炮二平五");
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");

  await page.getByRole("button", { name: "悔棋" }).click();
  await expect(page.locator("#move-list")).toContainText("尚未走棋");
  expect(await page.locator("#board").getAttribute("data-fen")).toBe(startingFen);
  expect(failed).toEqual([]);
});

test.describe("mobile width", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("board fits the viewport and touch play gets an AI reply", async ({ page }) => {
    await page.goto("./");
    const boardPanel = await page.locator(".board-panel").boundingBox();
    expect(boardPanel).not.toBeNull();
    expect(boardPanel!.x).toBeGreaterThanOrEqual(0);
    expect(boardPanel!.x + boardPanel!.width).toBeLessThanOrEqual(390);
    await page.locator('[data-square="h2"]').tap();
    await page.locator('[data-square="e2"]').tap();
    await expect(page.locator("#move-list li")).toHaveCount(2, { timeout: 5_000 });
    await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  });
});
