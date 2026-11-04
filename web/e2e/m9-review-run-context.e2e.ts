import { expect, test } from "@playwright/test";
import { openTab } from "./helpers/nav";
import { enableDevMode, openSettingsCategory, waitForImportJump } from "./helpers/nav";

const mate11Fen = "4k4/4r4/9/9/C8/2C6/2R6/9/5K1R1/9 w - - 0 1";

test("a focused 1M review stores its own budget and matching position result", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await enableDevMode(page);
  await openTab(page, "review");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill([
    '[Red "紅方"]', '[Black "黑方"]', `[FEN "${mate11Fen}"]`, "1. h1h9 *",
  ].join("\n"));
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await expect(page.locator("#move-list code")).toHaveText("h1h9");
  await waitForImportJump(page);
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list button")).toHaveCount(1);
  await openSettingsCategory(page, "review");
  await page.locator("#review-budget").selectOption("100000");
  await openTab(page, "review");
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator("#review-panel")).toContainText("分析完成", { timeout: 150_000 });
  await page.getByRole("button", { name: "想更久" }).first().click();
  await expect(page.locator("#review-panel")).toContainText("正在分析", { timeout: 5_000 });
  await expect(page.locator("#review-panel")).toContainText("分析完成", { timeout: 150_000 });

  const snapshot = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("xiangqi-coach-local", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<Array<{ reviewSnapshot?: unknown }>>((resolve, reject) => {
      const transaction = db.transaction("games", "readonly");
      const request = transaction.objectStore("games").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return rows[0]?.reviewSnapshot as {
      startFen: string; moves: string[]; points: Array<{ final: { playedMove: string; bestMove: string } }>;
      analyzer: { quickNodeLimit: number; deepNodeLimit: number; config: string };
    } | undefined;
  });
  expect(snapshot?.startFen).toBe(mate11Fen);
  expect(snapshot?.moves).toEqual(["h1h9"]);
  expect(snapshot?.points).toHaveLength(1);
  expect(snapshot?.points[0]?.final.playedMove).toBe("h1h9");
  expect(snapshot?.analyzer).toEqual({ name: "內建引擎", quickNodeLimit: 300_000, deepNodeLimit: 900_000, config: "SearchConfig::default()" });
});
