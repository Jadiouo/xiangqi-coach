import { expect, test } from "@playwright/test";
import { openSettings, openTab } from "./helpers/nav";

for (const difficultyLevel of [1, 9, 10]) {
test(`difficulty level ${difficultyLevel} reaches the real engine worker within five seconds`, async ({ page }) => {
  await page.addInitScript(() => {
    const sent: unknown[] = [];
    (window as Window & { __m6Requests?: unknown[] }).__m6Requests = sent;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message: unknown, options?: StructuredSerializeOptions): void {
        sent.push(message);
        super.postMessage(message, options);
      }
    };
  });

  await page.goto("/");
  await openSettings(page);
  const level = page.locator("#difficulty-level");
  await expect(level).toHaveValue("5");
  await expect(level.locator("option")).toHaveCount(10);
  await level.selectOption(String(difficultyLevel));

  await openTab(page, "play");
  const startedAt = Date.now();
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list li")).toHaveCount(2, { timeout: 5_000 });
  expect(Date.now() - startedAt).toBeLessThan(5_000);

  const requests = await page.evaluate(() =>
    (window as Window & { __m6Requests?: unknown[] }).__m6Requests ?? [],
  );
  expect(requests).toContainEqual(expect.objectContaining({
    type: "move",
    move: "h2e2",
    difficultyLevel,
  }));
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  await expect(page.locator("#difficulty-status")).toHaveText(`電腦已使用難度 ${difficultyLevel} 回應。`);
  await expect(page.locator("#board")).not.toHaveAttribute("aria-disabled", "true");
});
}
