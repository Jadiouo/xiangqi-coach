import { expect, test } from "@playwright/test";
import { openSettings, openTab } from "./helpers/nav";

const legacyLibraryKey = "xiangqi.game-library.v1";
const legacyGames = [{ id: "legacy-game-1", savedAt: 1_728_000_000_000, moves: ["h2e2", "h9g7"] }];

test("a saved game stays in the library after reload and reopens its real move record", async ({ page }) => {
  await page.goto("/");
  await openSettings(page);
  await page.getByLabel("電腦難度").selectOption("1");
  await openTab(page, "play");

  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list code")).toHaveCount(2, { timeout: 5_000 });
  const recordedMoves = await page.locator("#move-list code").allTextContents();
  expect(recordedMoves).toContain("h2e2");
  expect(recordedMoves).toHaveLength(2);
  const recordedFen = await page.locator("#board").getAttribute("data-fen");

  await openTab(page, "library");
  await expect(page.getByRole("button", { name: "儲存棋局" })).toBeVisible();
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.getByRole("region", { name: "棋局庫" }).locator("#game-library-list button")).toHaveCount(1);
  const savedBeforeReload = await readIndexedDbGames(page);
  expect(savedBeforeReload).toHaveLength(1);
  expect(savedBeforeReload[0].moves).toEqual(recordedMoves);
  expect(savedBeforeReload[0].id).toBeTruthy();

  await page.reload();

  const savedAfterReload = await readIndexedDbGames(page);
  expect(savedAfterReload).toEqual(savedBeforeReload);
  const library = page.getByRole("region", { name: "棋局庫" });
  await expect(library).toBeVisible();
  const savedGame = library.getByRole("button", { name: /第 1 局（2 手）/ });
  await expect(savedGame).toBeVisible();
  await savedGame.click();
  await openTab(page, "play");

  await expect(page.locator("#move-list code")).toHaveCount(2);
  await expect(page.locator("#move-list code").nth(0)).toHaveText("h2e2");
  await expect(page.locator("#move-list code").nth(1)).toHaveText(recordedMoves[1]);
  await expect(page.locator("#board")).toHaveAttribute("data-fen", recordedFen!);
});

async function readIndexedDbGames(page: import("@playwright/test").Page): Promise<Array<{
  id: string;
  savedAt: number;
  moves: string[];
  variationTree: unknown;
}>> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("xiangqi-coach-local", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("games", "readonly");
      const games = transaction.objectStore("games").getAll();
      const fail = (error: DOMException | null, fallback: string) => {
        database.close();
        reject(error ?? new Error(fallback));
      };
      games.onerror = () => fail(games.error, "IndexedDB getAll request failed");
      transaction.oncomplete = () => {
        const records = games.result;
        database.close();
        resolve(records);
      };
      transaction.onerror = () => fail(transaction.error, "IndexedDB read transaction failed");
      transaction.onabort = () => fail(transaction.error, "IndexedDB read transaction aborted");
    };
  }));
}

test("legacy local game library migrates to IndexedDB and survives reload", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(({ key, records }) => {
    localStorage.setItem(key, JSON.stringify(records));
  }, { key: legacyLibraryKey, records: legacyGames });
  await page.reload();
  await openTab(page, "library");

  const entry = page.locator("#game-library-list button").first();
  await expect(entry).toBeVisible();
  await expect(entry).toContainText("2 手");
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), legacyLibraryKey)).toBeNull();

  await page.reload();
  await page.locator("#game-library-list button").first().click();
  await openTab(page, "play");
  await expect(page.locator("#move-list code")).toHaveCount(2);
  await expect(page.locator("#move-list code").nth(0)).toHaveText("h2e2");
  await expect(page.locator("#move-list code").nth(1)).toHaveText("h9g7");
});

test("legacy local game library remains intact when IndexedDB migration cannot complete", async ({ page }) => {
  await page.addInitScript(({ key, records }) => {
    localStorage.setItem(key, JSON.stringify(records));
    Object.defineProperty(window, "indexedDB", { configurable: true, value: null });
  }, { key: legacyLibraryKey, records: legacyGames });
  await page.goto("/");
  await openTab(page, "library");

  await expect(page.getByRole("status", { name: "棋局庫狀態" })).toHaveText("棋局庫無法讀取，請重新整理後再試。");
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), legacyLibraryKey)).toBe(JSON.stringify(legacyGames));
});
