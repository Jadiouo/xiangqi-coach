import { expect, test } from "@playwright/test";
import { openSettings, openTab } from "./helpers/nav";
import { enableDevMode } from "./helpers/nav";

test("deepens only the selected review point and restores its controls", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await openSettings(page);
  await page.getByLabel("電腦難度").selectOption("1");
  await enableDevMode(page);
  await openTab(page, "play");

  // Create the shortest real game prefix through the normal board and AI controls.
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list code")).toHaveCount(2, { timeout: 30_000 });

  await openTab(page, "review");
  await expect(page.locator("#review-budget")).toHaveValue("100000");
  await page.evaluate(() => {
    const requests: Array<{ quickNodeLimit: number; focusIndex?: number }> = [];
    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: unknown): void {
      if (typeof message === "object" && message !== null && "type" in message && message.type === "start") {
        const request = message as { quickNodeLimit: number; focusIndex?: number };
        requests.push({ quickNodeLimit: request.quickNodeLimit, focusIndex: request.focusIndex });
      }
      originalPostMessage.call(this, message);
    };
    Object.assign(window, { __m7ReviewRequests: requests });
  });
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.getByRole("region", { name: "覆盤" })).toBeVisible();
  await expect(page.getByLabel("勝率曲線")).toBeVisible();
  await expect(page.locator("[data-review-point]")).toHaveCount(2, { timeout: 120_000 });
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>("#review-panel")?.dataset.continuationComplete === "true"
      && document.querySelector<HTMLElement>('#review-panel [role="status"]')?.textContent === "分析完成",
    null,
    { timeout: 120_000 },
  );
  const initialRequest = await page.evaluate(() =>
    (window as Window & { __m7ReviewRequests: Array<{ quickNodeLimit: number; focusIndex?: number }> }).__m7ReviewRequests[0],
  );
  expect(initialRequest).toEqual({ quickNodeLimit: 100_000, focusIndex: undefined });

  const readDisplayedPoint = async () => page.locator("[data-pv-line]").evaluateAll((lines) =>
    lines.map((line) => ({
      requestId: Number(JSON.parse(line.getAttribute("data-pv-replay-audit") ?? "{}").requestId),
      move: line.textContent?.trim().split(/\s+/)[0],
      nodes: Number(line.getAttribute("data-pv-nodes")),
    })),
  );

  await page.locator('[data-review-point="1"]').click();
  const otherPointBefore = await readDisplayedPoint();
  expect(otherPointBefore.length).toBeGreaterThan(0);

  await page.locator('[data-review-point="0"]').click();
  const selectedBefore = await readDisplayedPoint();
  expect(selectedBefore.length).toBeGreaterThan(0);
  const initialPointCount = await page.locator("[data-review-point]").count();
  await page.getByRole("button", { name: "想更久" }).click();

  await expect(page.locator('[data-review-point="0"]')).toHaveClass(/review-point-selected/);
  await expect(page.locator("[data-review-point]")).toHaveCount(initialPointCount);
  await expect(page.getByRole("button", { name: "取消分析" })).toBeVisible();
  expect(await readDisplayedPoint()).toEqual(selectedBefore);

  await page.waitForFunction(
    () => document.querySelector<HTMLElement>('#review-panel [role="status"]')?.textContent === "分析完成",
    null,
    { timeout: 120_000 },
  );
  const selectedAfter = await readDisplayedPoint();
  expect(selectedAfter).toHaveLength(selectedBefore.length);
  const focusedRequest = await page.evaluate(() =>
    (window as Window & { __m7ReviewRequests: Array<{ quickNodeLimit: number; focusIndex?: number }> }).__m7ReviewRequests.at(-1),
  );
  expect(focusedRequest).toEqual({ quickNodeLimit: 300_000, focusIndex: 0 });
  expect(selectedAfter.every((line) => line.requestId > selectedBefore[0].requestId)).toBe(true);
  expect(selectedAfter.map((line) => line.requestId)).not.toEqual(selectedBefore.map((line) => line.requestId));

  await page.locator('[data-review-point="1"]').click();
  expect(await readDisplayedPoint()).toEqual(otherPointBefore);
  await page.locator('[data-review-point="0"]').click();
  await expect(page.getByRole("button", { name: "想更久" })).toBeVisible();
  await expect(page.getByRole("button", { name: "想更久" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "取消分析" })).toHaveCount(0);
});
