import { expect, test, type Page } from "@playwright/test";
import { enableDevMode, openSettings, openTab } from "./helpers/nav";

// Guards added after the closed-door review of playtest batch A (same-game save, move list scrolling).

async function playRedTurn(page: Page): Promise<void> {
  const before = await page.locator("#move-list .move-row").count();
  const redSquares = await page.locator("#board .board-cell:has(.piece-label-red)")
    .evaluateAll((cells) => cells.map((cell) => cell.getAttribute("data-square")).filter(Boolean) as string[]);
  for (const from of redSquares) {
    await page.locator(`#board .board-cell[data-square="${from}"]`).click();
    const targets = await page.locator("#board .board-cell").evaluateAll((cells) => cells.flatMap((cell) => {
      const square = cell.getAttribute("data-square");
      return cell.querySelector(".legal-capture, .legal-dot") && square ? [square] : [];
    }));
    if (targets.length === 0) continue;
    await page.locator(`#board .board-cell[data-square="${targets[0]}"]`).click();
    await expect.poll(() => page.locator("#move-list .move-row").count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(before + 2);
    return;
  }
  throw new Error("red had no legal move");
}

async function easyGame(page: Page): Promise<void> {
  await page.goto("/");
  await openSettings(page);
  await page.getByLabel("電腦難度").selectOption("1");
  await openTab(page, "play");
}

async function firstMove(page: Page): Promise<void> {
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list code")).toHaveCount(2, { timeout: 10_000 });
}

async function save(page: Page): Promise<void> {
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-status")).toHaveText("棋局已儲存");
}

interface Row { id: string; savedAt: number; moves: string[]; reviewSnapshot: unknown; reviewNote: unknown; variationTree: { nodes: Array<{ annotation: string }> } | null }

async function rows(page: Page): Promise<Row[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("xiangqi-coach-local", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const all = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction("games", "readonly").objectStore("games").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return all as Row[];
  });
}

test("saving again after a review with a note and a branch keeps snapshot, note and tree", async ({ page }) => {
  test.setTimeout(180_000);
  await easyGame(page);
  await enableDevMode(page);
  await firstMove(page);
  await save(page);
  await openTab(page, "review");
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator("[data-review-point]").first()).toBeVisible({ timeout: 120_000 });
  await expect(page.locator("#review-panel")).toContainText("分析完成", { timeout: 120_000 });
  await page.locator("[data-review-point]").first().click();
  await page.locator('[data-square="b2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator('#variation-tree [data-variation-node="branch-1"]')).toBeVisible({ timeout: 30_000 });
  await page.locator('#variation-tree [data-variation-node="branch-1"]').click();
  await page.getByLabel("分支註解").fill("保留這條");
  await page.getByRole("button", { name: "儲存註解" }).click();
  await page.getByRole("button", { name: "產生覆盤筆記" }).click();
  await expect.poll(async () => (await rows(page))[0]?.reviewNote ?? null, { timeout: 30_000 }).not.toBeNull();
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list button")).toHaveCount(1);
  const [row] = await rows(page);
  expect(row!.reviewSnapshot).not.toBeNull();
  expect(row!.reviewNote).not.toBeNull();
  expect(JSON.stringify(row!.variationTree)).toContain("保留這條");
});

test("guard: undo, play a different move and save adds a second entry and leaves the first unchanged", async ({ page }) => {
  await easyGame(page);
  await firstMove(page);
  await save(page);
  const [first] = await rows(page);
  await openTab(page, "play");
  await page.getByRole("button", { name: "悔棋" }).click();
  await expect(page.locator("#move-list code")).toHaveCount(0);
  await page.locator('[data-square="b2"]').click();
  await page.locator('[data-square="c2"]').click();
  await expect(page.locator("#move-list code")).toHaveCount(2, { timeout: 10_000 });
  await save(page);
  await expect(page.locator("#game-library-list button")).toHaveCount(2);
  const all = await rows(page);
  expect(all.find((row) => row.id === first!.id)).toEqual(first);
});

test("guard: opening a saved game, playing one more move and saving adds an entry and leaves the original unchanged", async ({ page }) => {
  await easyGame(page);
  await firstMove(page);
  await save(page);
  const [first] = await rows(page);
  await page.reload();
  await openTab(page, "library");
  await page.getByRole("button", { name: "看覆盤" }).click();
  await page.locator('.app-shell[data-route="review"]').waitFor();
  await expect(page.locator("#move-list code")).toHaveCount(2);
  await openTab(page, "play");
  await playRedTurn(page);
  await expect(page.locator("#move-list code")).toHaveCount(4);
  await save(page);
  await expect(page.locator("#game-library-list button")).toHaveCount(2);
  const all = await rows(page);
  expect(all.find((row) => row.id === first!.id)).toEqual(first);
});

async function longGame(page: Page): Promise<void> {
  await easyGame(page);
  for (let turn = 0; turn < 9; turn += 1) await playRedTurn(page);
}

test("scroll: coming back to the play page shows the newest move again", async ({ page }) => {
  test.setTimeout(120_000);
  await longGame(page);
  await page.locator("#move-list").evaluate((list) => { list.scrollTop = 0; });
  await openTab(page, "library");
  await openTab(page, "play");
  const gap = await page.locator("#move-list").evaluate((list) => list.scrollHeight - list.scrollTop - list.clientHeight);
  expect(gap).toBeLessThanOrEqual(2);
});

test("scroll: a redraw with the same number of moves keeps the reading position", async ({ page }) => {
  test.setTimeout(120_000);
  await longGame(page);
  await page.locator("#move-list").evaluate((list) => { list.scrollTop = 60; });
  const before = await page.locator("#move-list").evaluate((list) => list.scrollTop);
  expect(before).toBeGreaterThan(20);
  await page.locator('[data-square="a3"]').click(); // selecting a piece redraws the page, the move list included
  await page.waitForTimeout(300);
  const after = await page.locator("#move-list").evaluate((list) => list.scrollTop);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
});
