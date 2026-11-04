import { expect, test } from "@playwright/test";
import { openSettings } from "./helpers/nav";
import { openSettingsCategory } from "./helpers/nav";

// Same touch-driven full game as m6-mobile-full-game (difficulty 1, a legal red move each turn).
async function playUntilGameOver(page: import("@playwright/test").Page): Promise<void> {
  const terminal = /^(紅方勝|黑方勝|和棋)$/;
  for (let turn = 0; turn < 300; turn += 1) {
    const status = (await page.locator("#turn-status").innerText()).trim();
    if (terminal.test(status)) break;
    expect(status).toBe("輪到紅方");
    const moveCountBefore = await page.locator("#move-list .move-row").count();
    const redSquares = await page.locator("#board .board-cell:has(.piece-label-red)")
      .evaluateAll((cells) => cells.map((cell) => cell.getAttribute("data-square")).filter(Boolean) as string[]);
    let played = false;
    for (const from of redSquares) {
      await page.locator(`#board .board-cell[data-square="${from}"]`).click();
      const choices = await page.locator("#board .board-cell").evaluateAll((cells) => cells.flatMap((cell) => {
        const target = cell.querySelector(".legal-capture, .legal-dot");
        const square = cell.getAttribute("data-square");
        return target && square ? [{ square, capture: target.classList.contains("legal-capture") }] : [];
      }));
      if (choices.length === 0) continue;
      const captures = choices.filter((choice) => choice.capture);
      const available = captures.length > 0 ? captures : choices;
      await page.locator(`#board .board-cell[data-square="${available[turn % available.length]!.square}"]`).click();
      played = true;
      break;
    }
    expect(played, `red had a legal move on turn ${turn + 1}`).toBe(true);
    await expect.poll(async () => {
      const currentStatus = (await page.locator("#turn-status").innerText()).trim();
      const currentMoveCount = await page.locator("#move-list .move-row").count();
      return terminal.test(currentStatus)
        || (currentStatus === "輪到紅方" && currentMoveCount >= moveCountBefore + 2);
    }, { timeout: 5_000 }).toBe(true);
  }
  await expect(page.locator("#turn-status")).toHaveText(terminal);
}

test("P6 play page: no numbers or tuning controls by default, opponent card present", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#board")).toBeVisible();
  await expect(page.locator("#live-win-probability")).not.toBeVisible();
  await expect(page.locator("#difficulty-level")).not.toBeVisible();
  await expect(page.locator("[data-dev-info]")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "悔棋" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新開始" })).toBeVisible();
  await expect(page.getByText("電腦・難度 5")).toBeVisible();
  await expect(page.getByText("你執紅，先走。要換難度，按右上角齒輪")).toBeVisible();
  await expect(page.getByRole("button", { name: "覆盤這盤" })).toHaveCount(0);
});

test("P6 play page: the difficulty control lives in settings and the opponent card follows it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "設定" }).click();
  await expect(page.locator("#difficulty-level")).toBeVisible();
  await page.locator("#difficulty-level").selectOption("7");
  await page.getByRole("button", { name: "下棋" }).click();
  await expect(page.getByText("電腦・難度 7")).toBeVisible();
});

test("P6 play page: developer mode switch in settings reveals the dev info", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "設定" }).click();
  await openSettingsCategory(page, "advanced");
  await page.locator("#dev-mode-toggle").check();
  await page.getByRole("button", { name: "下棋" }).click();
  await expect(page.locator("[data-dev-info]")).toBeVisible();
  await page.reload();
  await expect(page.locator("[data-dev-info]")).toBeVisible();
  await page.getByRole("button", { name: "設定" }).click();
  await openSettingsCategory(page, "advanced");
  await page.locator("#dev-mode-toggle").uncheck();
  await page.getByRole("button", { name: "下棋" }).click();
  await expect(page.locator("[data-dev-info]")).not.toBeVisible();
});

test("P6 play page: a finished game shows the done card and the review button starts the review", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await page.getByRole("button", { name: "設定" }).click();
  await page.locator("#difficulty-level").selectOption("1");
  await page.getByRole("button", { name: "下棋" }).click();
  await playUntilGameOver(page);
  await expect(page.getByText("這盤下完了")).toBeVisible();
  await expect(page.getByRole("button", { name: "再下一盤" })).toBeVisible();
  await page.getByRole("button", { name: "覆盤這盤" }).click();
  expect(new URL(page.url()).hash).toBe("#/review");
  // the start now checks the review cache first, so wait for whichever comes: the review itself or the long-review warning
  await expect(page.locator("#review-warning:not([hidden]), #review-panel:not([hidden])").first()).toBeVisible();
  if (await page.locator("#review-warning").isVisible()) await page.getByRole("button", { name: "照樣開始" }).click();
  // the review has started (same signal m7-review-worker uses): the panel is shown with a status line
  await expect(page.locator("#review-panel")).toBeVisible();
  await expect(page.locator("#review-panel [role=status]").first()).toBeVisible();
});

test("P6 settings: the live win rate switch exists only in developer mode and shows the bar when ticked", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "設定" }).click();
  await openSettingsCategory(page, "advanced");
  await expect(page.locator("#live-evaluation-toggle")).not.toBeVisible();
  await page.locator("#dev-mode-toggle").check();
  await expect(page.locator("#live-evaluation-toggle")).toBeVisible();
  await page.locator("#live-evaluation-toggle").check();
  await page.getByRole("button", { name: "下棋" }).click();
  await expect(page.locator("#live-win-probability")).toBeVisible({ timeout: 15_000 });
  // turning developer mode off also turns the live evaluation off, so nothing stays marked as assisted unseen
  await page.getByRole("button", { name: "設定" }).click();
  await page.locator("#dev-mode-toggle").uncheck();
  await expect(page.locator("#live-evaluation-toggle")).not.toBeVisible();
  await expect(page.locator("#live-evaluation-toggle")).not.toBeChecked();
});

test("P6 dev mode: turning it off while a record is loading still switches live evaluation off", async ({ page }) => {
  await page.goto("/");
  await openSettings(page);
  await openSettingsCategory(page, "advanced");
  await page.locator("#dev-mode-toggle").check();
  await page.locator("#live-evaluation-toggle").check();
  await expect(page.locator("#live-win-probability")).toHaveAttribute("data-assisted", "true");
  // As soon as the import turns "loading" (the load command is still in the worker), turn dev mode off.
  await page.evaluate(() => {
    const status = document.querySelector("#record-import-status")!;
    const observer = new MutationObserver(() => {
      if (!(status.textContent ?? "").includes("正在載入棋局")) return;
      observer.disconnect();
      const toggle = document.querySelector<HTMLInputElement>("#dev-mode-toggle")!;
      toggle.checked = false;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
    });
    observer.observe(status, { childList: true, characterData: true, subtree: true });
  });
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill("h2e2 h9g7");
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await expect(page.locator("#record-import-status")).not.toHaveText(/正在載入棋局/);
  await expect(page.locator("#dev-mode-toggle")).not.toBeChecked();
  await expect(page.locator("#live-win-probability")).toHaveAttribute("data-assisted", "false");
  await expect(page.locator("#live-evaluation-toggle")).not.toBeChecked();
});
