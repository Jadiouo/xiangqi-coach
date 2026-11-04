import { expect, test, type Page } from "@playwright/test";
import { openSettings, openTab } from "./helpers/nav";
import { enableDevMode } from "./helpers/nav";

// SPEC 8.7: a branch shows the win rate of "this line", and the engine can play several moves for both sides.
async function openBranch(page: Page): Promise<void> {
  await page.goto("/");
  await openSettings(page);
  await page.getByLabel("電腦難度").selectOption("1");
  await enableDevMode(page);
  await openTab(page, "play");
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list code")).toHaveCount(2, { timeout: 30_000 });
  await openTab(page, "review");
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator("[data-review-point]").first()).toBeVisible({ timeout: 120_000 });
  await page.locator("[data-review-point]").nth(0).click();
  await page.locator('[data-square="b2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator('#variation-tree [data-variation-node="branch-2"]')).toBeVisible({ timeout: 30_000 });
}

test("a branch shows the win probability of the displayed branch position", async ({ page }) => {
  test.setTimeout(180_000);
  await openBranch(page);
  const meter = page.locator("#branch-win-probability");
  await expect(meter).toBeVisible({ timeout: 30_000 });
  await expect(meter).toHaveAttribute("data-fen", (await page.locator("#board").getAttribute("data-fen"))!);
  await expect(meter).toHaveText(/\d{1,3}(\.\d)?%/);
});

test("the engine can play several plies for both sides inside a branch", async ({ page }) => {
  test.setTimeout(180_000);
  await openBranch(page);
  const nodes = page.locator("#variation-tree [data-variation-node]");
  const before = await nodes.count();
  const fenBefore = await page.locator("#board").getAttribute("data-fen");
  await page.getByRole("button", { name: "讓引擎走 4 步" }).click();
  await expect(nodes).toHaveCount(before + 4, { timeout: 60_000 });
  await expect(page.locator("#board")).not.toHaveAttribute("data-fen", fenBefore!);
  await expect(page.locator("#branch-win-probability")).toHaveAttribute(
    "data-fen", (await page.locator("#board").getAttribute("data-fen"))!);
});

test("a branch note being typed survives a background re-render", async ({ page }) => {
  test.setTimeout(180_000);
  await openBranch(page);
  await page.locator('#variation-tree [data-variation-node="branch-1"]').click();
  await expect(page.locator("#branch-win-probability")).toBeVisible({ timeout: 30_000 });
  const note = page.getByLabel("分支註解");
  await note.fill("正在輸入的註解");
  // Starting an engine run re-renders the whole panel synchronously; the draft must survive it.
  await page.getByRole("button", { name: "讓引擎走 4 步" }).click();
  await expect(page.getByLabel("分支註解")).toHaveValue("正在輸入的註解");
});
