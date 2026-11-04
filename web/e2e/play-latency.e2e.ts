import { expect, test, type Page } from "@playwright/test";
import { enableDevMode, openSettings, openTab } from "./helpers/nav";
import { openSettingsCategory, waitForImportJump } from "./helpers/nav";

// The game worker is told to run a very long search (dev-only hook) so the user's own move
// is visibly shown before the computer answers.
async function passLongSearchFlagToWorkers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        const workerUrl = new URL(scriptURL.toString(), window.location.href);
        if (window.location.search.includes("test-long-search=1")) {
          workerUrl.searchParams.set("test-long-search", "1");
        }
        super(workerUrl, options);
      }
    };
  });
}

test("the user's move is drawn within 300 ms while the computer is still thinking", async ({ page }) => {
  await passLongSearchFlagToWorkers(page);
  await page.goto("/?test-long-search=1");
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  await openSettings(page);
  await page.locator("#difficulty-level").selectOption("10"); // low levels cap their own nodes and answer instantly
  await openTab(page, "play");
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  const clickedAt = Date.now();
  await expect(page.locator('[data-square="e2"] .piece-label')).toHaveText("炮", { timeout: 300 });
  await expect(page.locator('[data-square="h2"] .piece-label')).toHaveCount(0);
  expect(Date.now() - clickedAt).toBeLessThan(300);
  await expect(page.locator("#game-message")).toContainText("電腦思考中", { timeout: 300 });
  await expect(page.locator("#move-list")).toContainText("炮二平五");
  // still the computer's turn: the board must not accept another red move yet
  await page.locator('[data-square="a3"]').click();
  await expect(page.locator("#selection-status")).not.toContainText("a3");
});

test("after the computer answers the board, the move list and the turn are consistent", async ({ page }) => {
  await page.goto("/");
  await openSettings(page);
  await page.locator("#difficulty-level").selectOption("1");
  await openTab(page, "play");
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list li")).toHaveCount(2, { timeout: 5_000 });
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  await expect(page.locator("#game-message")).not.toContainText("電腦思考中");
  await expect(page.locator('[data-square="e2"] .piece-label')).toHaveText("炮");
  await expect(page.locator("#board")).not.toHaveAttribute("aria-disabled", "true");
  await page.getByRole("button", { name: "悔棋" }).click();
  await expect(page.locator("#move-list")).toContainText("尚未走棋");
});

test("live evaluation runs once per step, after the move is shown", async ({ page }) => {
  await page.goto("/");
  await openSettings(page);
  await page.locator("#difficulty-level").selectOption("1");
  await openTab(page, "play");
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  await openSettings(page);
  await openSettingsCategory(page, "advanced");
  await page.locator("#dev-mode-toggle").check();
  await page.locator("#live-evaluation-toggle").check();
  await enableDevMode(page);
  const probability = page.locator("#live-win-probability");
  await expect(probability).toHaveAttribute("data-evaluation-count", "1");
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list li")).toHaveCount(2, { timeout: 5_000 });
  await expect(probability).toHaveAttribute("data-evaluation-count", "2", { timeout: 5_000 });
  const fen = await page.locator("#board").getAttribute("data-fen");
  await expect(probability).toHaveAttribute("data-evaluation-fen", fen!);
  await page.waitForTimeout(500);
  await expect(probability).toHaveAttribute("data-evaluation-count", "2");
});

test("default difficulty is 5 and the chosen level is remembered after a reload", async ({ page }) => {
  await page.goto("/");
  await openSettings(page);
  await expect(page.locator("#difficulty-level")).toHaveValue("5");
  await page.locator("#difficulty-level").selectOption("7");
  await page.reload();
  await expect(page.locator("#difficulty-level")).toHaveValue("7");
});

test("an unreadable stored level falls back to 5", async ({ page }) => {
  await page.addInitScript(() => {
    try { window.localStorage.setItem("xq.difficulty.v1", "banana"); } catch { /* ignore */ }
  });
  await page.goto("/");
  await openSettings(page);
  await expect(page.locator("#difficulty-level")).toHaveValue("5");
});

test("the difficulty note no longer says the levels are uncalibrated", async ({ page }) => {
  await page.goto("/");
  await openSettings(page);
  const note = page.locator("#difficulty-note");
  await expect(note).not.toContainText("尚未完成");
  await expect(note).toContainText("1 最弱");
  await expect(note).toContainText("10 最強");
  // the figure comes from engine-vs-engine matches two levels apart; keep that premise in the sentence
  await expect(note).toContainText("電腦互相對下");
  await expect(note).toContainText("相差兩級");
});

test("undo with live evaluation on re-evaluates the position now on the board", async ({ page }) => {
  await page.goto("/");
  await openSettings(page);
  await page.locator("#difficulty-level").selectOption("1");
  await openTab(page, "play");
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  await openSettings(page);
  await openSettingsCategory(page, "advanced");
  await page.locator("#dev-mode-toggle").check();
  await page.locator("#live-evaluation-toggle").check();
  await enableDevMode(page);
  const probability = page.locator("#live-win-probability");
  await expect(probability).toHaveAttribute("data-evaluation-count", "1");
  const startFen = await page.locator("#board").getAttribute("data-fen");
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list li")).toHaveCount(2, { timeout: 5_000 });
  await expect(probability).toHaveAttribute("data-evaluation-count", "2", { timeout: 5_000 });
  await page.getByRole("button", { name: "悔棋" }).click();
  await expect(page.locator("#board")).toHaveAttribute("data-fen", startFen!);
  await expect(probability).toHaveAttribute("data-evaluation-fen", startFen!, { timeout: 5_000 });
});

test("a move that mates the computer ends the game at once and never shows the thinking message", async ({ page }) => {
  await page.goto("/");
  await openTab(page, "review");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill([
    '[FEN "4k4/R8/9/9/1R7/8p/9/9/9/3K5 b - - 0 1"]',
    "1. i4i3 *",
  ].join("\n"));
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await waitForImportJump(page);
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  await openSettings(page);
  await openSettingsCategory(page, "play");
  await page.locator("#difficulty-level").selectOption("10");
  await openTab(page, "play");
  await page.locator('[data-square="b5"]').click();
  await page.locator('[data-square="b9"]').click();
  await expect(page.locator("#turn-status")).toHaveText("紅方勝", { timeout: 2_000 });
  await expect(page.locator("#game-message")).not.toContainText("電腦思考中");
  await expect(page.locator("#move-list li")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "悔棋" })).toBeEnabled();
  await page.waitForTimeout(500);
  await expect(page.locator("#turn-status")).toHaveText("紅方勝");
  await expect(page.locator("#game-message")).not.toContainText("電腦思考中");
});
