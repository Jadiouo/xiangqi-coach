import { expect, test, type Page } from "@playwright/test";
import { openSettings, openTab } from "./helpers/nav";
import { enableDevMode, openSettingsCategory } from "./helpers/nav";

test("saved games reopen their own branch and annotation snapshots", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await createAnnotatedGame(page, "第一盤的分支筆記");
  await createAnnotatedGame(page, "第二盤的分支筆記");

  await page.reload();
  const library = page.getByRole("region", { name: "棋局庫" });
  const entries = library.locator("#game-library-list button");
  await expect(entries).toHaveCount(2);

  await entries.nth(1).click();
  await expect(page.locator("#move-list code")).toHaveCount(2);
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator("#variation-tree")).toBeVisible();
  const expectedOlderBranchFen = await expectedFenAfter(page, ["b2e2"]);
  await page.locator('#variation-tree [data-variation-node="branch-1"]').click();
  await expect(page.locator("#board")).toHaveAttribute("data-fen", expectedOlderBranchFen);
  await expect(page.locator("#variation-tree")).toContainText("第一盤的分支筆記");

  await openTab(page, "library");
  await entries.nth(0).click();
  await expect(page.locator("#move-list code")).toHaveCount(2);
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator("#variation-tree")).toBeVisible();
  const expectedNewerBranchFen = await expectedFenAfter(page, ["b2e2"]);
  await page.locator('#variation-tree [data-variation-node="branch-1"]').click();
  await expect(page.locator("#board")).toHaveAttribute("data-fen", expectedNewerBranchFen);
  await expect(page.locator("#variation-tree")).toContainText("第二盤的分支筆記");

  await openTab(page, "library");
  const names = await entries.allTextContents();
  expect(new Set(names).size).toBe(2);
});

test("saving a continued mainline leaves the opened game's saved snapshot intact", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await createAnnotatedGame(page, "原棋局的分支筆記");
  await page.locator("#game-library-list button").first().click();
  await expect(page.locator("#move-list code")).toHaveCount(2);

  await openTab(page, "play");
  await page.locator('[data-square="h0"]').click();
  await page.locator('[data-square="g2"]').click();
  await expect(page.locator("#move-list code")).toHaveCount(4, { timeout: 5_000 });
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list button")).toHaveCount(2);
  await page.reload();

  await page.locator("#game-library-list button").nth(1).click();
  await expect(page.locator("#move-list code")).toHaveCount(2);
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator("#variation-tree")).toBeVisible();
  const expectedOlderBranchFen = await expectedFenAfter(page, ["b2e2"]);
  await page.locator('#variation-tree [data-variation-node="branch-1"]').click();
  await expect(page.locator("#board")).toHaveAttribute("data-fen", expectedOlderBranchFen);
  await expect(page.locator("#variation-tree")).toContainText("原棋局的分支筆記");
});

test("saved games with identical move counts have distinct accessible names", async ({ page }) => {
  await page.goto("/");
  await openSettings(page);
  await page.getByLabel("電腦難度").selectOption("1");
  await openTab(page, "play");
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list code")).toHaveCount(2, { timeout: 5_000 });

  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list button")).toHaveCount(1);
  // saving the same game again now updates its entry (playtest 2026-10-21 bug 4), so make a second game with the same move count
  await openTab(page, "play");
  await page.getByRole("button", { name: "重新開始" }).click();
  await expect(page.locator("#move-list code")).toHaveCount(0);
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list code")).toHaveCount(2, { timeout: 5_000 });
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list button")).toHaveCount(2);
  const names = await page.locator("#game-library-list button").allTextContents();
  expect(new Set(names).size).toBe(2);
});

test("the library reports a visible save error when IndexedDB is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", { configurable: true, value: null });
  });
  await page.goto("/");
  await openSettings(page);
  await page.getByLabel("電腦難度").selectOption("1");
  await openTab(page, "play");
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list code")).toHaveCount(2, { timeout: 5_000 });
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.getByRole("status", { name: "棋局庫狀態" })).toHaveText("棋局無法儲存，請檢查瀏覽器本機儲存空間。");
  await expect(page.locator("#game-library-list button")).toHaveCount(0);
});

async function createAnnotatedGame(page: Page, annotation: string): Promise<void> {
  await openTab(page, "play");
  if (await page.locator("#move-list code").count() !== 0) {
    await page.getByRole("button", { name: "重新開始" }).click();
    await expect(page.locator("#move-list code")).toHaveCount(0);
  }
  await openSettings(page);
  await openSettingsCategory(page, "play");
  await page.getByLabel("電腦難度").selectOption("1");
  await enableDevMode(page);
  await openTab(page, "play");
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list code")).toHaveCount(2, { timeout: 5_000 });
  await openTab(page, "review");
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator("[data-review-point]").first()).toBeVisible({ timeout: 30_000 });
  await page.locator("[data-review-point]").first().click();
  await page.locator('[data-square="b2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator('#variation-tree [data-variation-node="branch-1"]')).toBeVisible({ timeout: 30_000 });
  const expectedBranchPosition = await expectedFenAfter(page, ["b2e2"]);
  await page.locator('#variation-tree [data-variation-node="branch-1"]').click();
  await expect(page.locator("#board")).toHaveAttribute("data-fen", expectedBranchPosition);
  await page.getByLabel("分支註解").fill(annotation);
  await page.getByRole("button", { name: "儲存註解" }).click();
  await expect(page.locator("#variation-tree")).toContainText(annotation);
  const priorEntries = await page.locator("#game-library-list button").count();
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list button")).toHaveCount(priorEntries + 1);
}

async function expectedFenAfter(page: Page, moves: string[]): Promise<string> {
  return page.evaluate(async (path) => {
    const module = await import("/wasm/xq_wasm.js") as {
      default: () => Promise<void>;
      WebGame: new () => { play(move: string): boolean; fen(): string };
    };
    await module.default();
    const game = new module.WebGame();
    for (const move of path) if (!game.play(move)) throw new Error(`illegal expected branch move ${move}`);
    return game.fen();
  }, moves);
}
