import { expect, test, type Page } from "@playwright/test";
import { enableDevMode, openSettings, openSettingsCategory, openTab, waitForImportJump } from "./helpers/nav";

// Playtest 2026-10-21, batch A (bugs 1-5). Each test was red before its fix.

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

async function loadRecord(page: Page, text: string): Promise<void> {
  await openTab(page, "review");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill(text);
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await waitForImportJump(page);
}

const gapToBottom = (page: Page) => page.locator("#move-list").evaluate((list) => list.scrollHeight - list.scrollTop - list.clientHeight);

test("bug 1: the move list follows the newest move on the play page and on the review page", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await openSettings(page);
  await page.getByLabel("電腦難度").selectOption("1");
  await openTab(page, "play");
  for (let turn = 0; turn < 9; turn += 1) await playRedTurn(page);
  const overflow = await page.locator("#move-list").evaluate((list) => list.scrollHeight - list.clientHeight);
  expect(overflow, "the list is long enough to scroll").toBeGreaterThan(20);
  expect(await gapToBottom(page)).toBeLessThanOrEqual(2);
  await openTab(page, "review");
  expect(await gapToBottom(page)).toBeLessThanOrEqual(2);
});

test("bug 2: a finished game no longer says to pick a piece, and the review line is spaced from the buttons", async ({ page }) => {
  await page.goto("/");
  await loadRecord(page, ['[FEN "4k4/R8/9/9/1R7/8p/9/9/9/3K5 b - - 0 1"]', "1. i4i3 *"].join("\n"));
  await openSettings(page);
  await openSettingsCategory(page, "play");
  await page.locator("#difficulty-level").selectOption("10");
  await openTab(page, "play");
  await page.locator('[data-square="b5"]').click();
  await page.locator('[data-square="b9"]').click();
  await expect(page.locator("#turn-status")).toHaveText("紅方勝", { timeout: 5_000 });
  await expect(page.locator("#selection-status")).not.toContainText("選擇自己一方的棋子");
  await expect(page.locator("#selection-status")).not.toHaveText("");
  const body = await page.getByText("想知道哪幾步可以走得更好").boundingBox();
  const button = await page.getByRole("button", { name: "覆盤這盤" }).boundingBox();
  expect(button!.y - (body!.y + body!.height), "gap between the hint line and the buttons").toBeGreaterThanOrEqual(8);
});

async function devValue(page: Page, label: string): Promise<string> {
  return (await page.locator(`#dev-info-lines dt:text-is("${label}") + dd`).innerText()).trim();
}

test("bug 3: with live evaluation on, the dev info shows nodes, depth, score and time", async ({ page }) => {
  await page.goto("/");
  await enableDevMode(page);
  await openSettingsCategory(page, "advanced");
  await page.locator("#live-evaluation-toggle").check();
  await openTab(page, "play");
  await expect(page.locator("#live-win-probability")).toBeVisible({ timeout: 15_000 });
  for (const label of ["節點數", "深度", "分數 (cp)", "耗時 (ms)"]) {
    await expect.poll(() => devValue(page, label), { message: label }).toMatch(/^-?\d+$/);
  }
});

test("bug 3: with live evaluation off, the dev info says why there is no number", async ({ page }) => {
  await page.goto("/");
  await enableDevMode(page);
  for (const label of ["節點數", "深度", "分數 (cp)", "耗時 (ms)"]) {
    expect(await devValue(page, label), label).toBe("開啟即時評估後顯示");
  }
});

test("bug 4: saving the same game twice keeps one entry in the library", async ({ page }) => {
  await page.goto("/");
  await loadRecord(page, "h2e2 h9g7");
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list button")).toHaveCount(1);
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-status")).toHaveText("棋局已儲存");
  await expect(page.locator("#game-library-list button")).toHaveCount(1);
  const rows = await page.evaluate(async () => {
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
    return all.length;
  });
  expect(rows).toBe(1);
});

test("bug 5: before a review starts, the review page board does not take moves", async ({ page }) => {
  await page.goto("/");
  await loadRecord(page, "h2e2 h9g7");
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list button")).toHaveCount(1);
  await page.getByRole("button", { name: "看覆盤" }).click();
  await page.locator('.app-shell[data-route="review"]').waitFor();
  await expect(page.locator("#move-list .move-row")).toHaveCount(2);
  // the board is disabled, so a plain click is refused by Playwright: force it to prove the app ignores the move too
  await page.locator('[data-square="b2"]').click({ force: true });
  await page.locator('[data-square="c2"]').click({ force: true });
  await page.waitForTimeout(1_500);
  await expect(page.locator("#move-list .move-row")).toHaveCount(2);
  await expect(page.locator("#board")).toHaveAttribute("aria-disabled", "true");
});

test("bug 5: a move tried on the reviewed board is labelled as a trial and can be undone with one button", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await openSettings(page);
  await page.getByLabel("電腦難度").selectOption("1");
  await openTab(page, "play");
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list code")).toHaveCount(2, { timeout: 30_000 });
  await openTab(page, "review");
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator("[data-review-point]").first()).toBeVisible({ timeout: 120_000 });
  await expect(page.locator("#branch-banner")).toBeHidden();
  await page.locator("[data-review-point]").nth(0).click();
  await page.locator('[data-square="b2"]').click();
  await page.locator('[data-square="e2"]').click();
  const banner = page.locator("#branch-banner");
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner).toContainText("試走");
  await expect(banner).toContainText("不會改到原棋局");
  const trialFen = await page.locator("#board").getAttribute("data-fen");
  await banner.getByRole("button", { name: "回到原局面" }).click();
  await expect(banner).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => page.locator("#board").getAttribute("data-fen")).not.toBe(trialFen);
  await expect(page.locator("#move-list .move-row")).toHaveCount(2);
});
