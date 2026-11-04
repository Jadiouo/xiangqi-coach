import { expect, test } from "@playwright/test";

test("an uncaught game worker error disables stale state and offers a clean reload", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        const workerUrl = new URL(scriptURL.toString(), window.location.href);
        workerUrl.searchParams.set("test-crash-on-move", "1");
        super(workerUrl, options);
      }
    };
  });

  await page.goto("/");
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  const startingFen = await page.locator("#board").getAttribute("data-fen");
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();

  await expect(page.locator("#turn-status")).toHaveText("棋局狀態未確認");
  await expect(page.locator("#board")).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator("#game-message")).toContainText("請重新載入新局");
  await expect(page.getByRole("button", { name: "重新載入新局" })).toBeEnabled();
  expect(await page.locator("#board").getAttribute("data-fen")).toBe(startingFen);

  await page.getByRole("button", { name: "重新載入新局" }).click();
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  await expect(page.locator("#move-list")).toContainText("尚未走棋");
  expect(await page.locator("#board").getAttribute("data-fen")).toBe(startingFen);
});
