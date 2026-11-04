import { expect, test } from "@playwright/test";
import { openSettings, openTab } from "./helpers/nav";

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

test("a mobile player can finish a real game by touch and review its Chinese record", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await openSettings(page);
  await page.locator("#difficulty-level").selectOption("1");
  await openTab(page, "play");
  await expect(page.locator("#board")).toBeVisible();
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");

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
      await page.locator(`#board .board-cell[data-square="${from}"]`).tap();
      const choices = await page.locator("#board .board-cell").evaluateAll((cells) => cells.flatMap((cell) => {
        const target = cell.querySelector(".legal-capture, .legal-dot");
        const square = cell.getAttribute("data-square");
        return target && square ? [{ square, capture: target.classList.contains("legal-capture") }] : [];
      }));
      if (choices.length === 0) continue;
      const captures = choices.filter((choice) => choice.capture);
      const available = captures.length > 0 ? captures : choices;
      const target = available[turn % available.length]!.square;
      await page.locator(`#board .board-cell[data-square="${target}"]`).tap();
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
  const rows = page.locator("#move-list .move-row");
  const moveCount = await rows.count();
  expect(moveCount).toBeGreaterThan(0);
  await expect(page.locator("#move-count")).toHaveText(`${moveCount} 手`);
  expect(await rows.locator("strong").count()).toBe(moveCount);
  expect(await rows.locator("code").count()).toBe(moveCount);
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    boardWidth: document.querySelector("#board")?.getBoundingClientRect().width ?? 0,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width);
  expect(viewport.boardWidth).toBeGreaterThan(300);
});
