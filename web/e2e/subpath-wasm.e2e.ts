// Sub-path regression: review.worker, record-import.worker and main.ts used to load "/wasm/xq_wasm.js"
// (absolute), which 404s when the app is served under /xiangqi-coach/ (GitHub Pages).
import { openSettingsCategory, waitForImportJump } from "./helpers/nav";
// Production build only (E2E_PREVIEW=1), served by e2e/serve-subpath.mjs under the sub-path.
import { expect, test, type Page } from "@playwright/test";
import { openSettings, openTab } from "./helpers/nav";

const DONGPING = "[DhtmlXQ_movelist]774770627967807089791022[/DhtmlXQ_movelist]\n[DhtmlXQ_move_1_2_3]0000[/DhtmlXQ_move_1_2_3]";

function trackFailures(page: Page): string[] {
  const failed: string[] = [];
  page.on("response", (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
  return failed;
}

async function importDongping(page: Page): Promise<void> {
  await openTab(page, "review");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill(DONGPING);
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await waitForImportJump(page);
  await openSettingsCategory(page, "data");
  await expect(page.getByRole("status", { name: "匯入狀態" })).toContainText("東萍格式，6 步", { timeout: 15_000 });
  await expect(page.locator("#move-list code")).toHaveCount(6);
}

test("sub-path: importing a Dongping movelist works (record-import.worker loads the wasm)", async ({ page }) => {
  const failed = trackFailures(page);
  await page.goto("./");
  await importDongping(page);
  expect(failed).toEqual([]);
});

test("sub-path: starting a review yields at least one classified move (review.worker loads the wasm)", async ({ page }) => {
  test.setTimeout(180_000);
  const failed = trackFailures(page);
  await page.goto("./");
  await openSettings(page);
  await page.getByLabel("電腦難度").selectOption("1");
  await openTab(page, "play");
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list code")).toHaveCount(2, { timeout: 30_000 });
  await openTab(page, "review");
  await openSettingsCategory(page, "review");
  await page.locator("#review-budget").selectOption("100000");
  await openTab(page, "review");
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator("[data-review-point]").first()).toBeVisible({ timeout: 120_000 });
  expect(failed).toEqual([]);
});

test("sub-path: after one online visit, the import still works offline after a reload", async ({ page, context }) => {
  const failed = trackFailures(page);
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1, name: "象棋教練" })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    }
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "象棋教練" })).toBeVisible();
  await importDongping(page);
  expect(failed).toEqual([]);
});
