import { expect, test, type Page } from "@playwright/test";
import { openTab } from "./helpers/nav";
import { openSettingsCategory, waitForImportJump } from "./helpers/nav";

// Eight plies of a weak game (probe: with a 2,000 node budget black's plies 4 and 8 are marked, red's 3, 5, 7).
const GAME = ["a3a4", "h7h5", "a4a5", "h5h4", "a5a6", "b7b5", "a6b6", "f9e8"];

async function loadAndReview(page: Page): Promise<void> {
  await page.goto("/?review-workers=2");
  await openTab(page, "review");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill(GAME.join(" "));
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await expect(page.locator("#move-list code")).toHaveCount(GAME.length);
  await waitForImportJump(page);
  await page.evaluate(() => {
    document.querySelector<HTMLSelectElement>("#review-budget")!.append(new Option("test 2000", "2000"));
  });
  await openSettingsCategory(page, "review");
  await page.locator("#review-budget").selectOption("2000");
  await openTab(page, "review");
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator("#review-panel")).toContainText("分析完成", { timeout: 240_000 });
}

test("P6 review page: key-move chips, arrows on the board, and the played-versus-better card", async ({ page }) => {
  test.setTimeout(300_000);
  await loadAndReview(page);
  await openSettingsCategory(page, "review");
  await page.locator("#review-perspective").selectOption("black");
  await openTab(page, "review");
  const chips = page.locator("[data-review-chip]");
  await expect(chips.nth(1)).toBeVisible();
  expect(await chips.count()).toBeGreaterThanOrEqual(2);

  await chips.nth(0).click();
  await expect(page.getByRole("button", { name: "上一步" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "下一步" })).toBeEnabled();

  await page.getByRole("button", { name: "下一步" }).click();
  await expect(chips.nth(1)).toHaveAttribute("aria-current", "true");
  await expect(page.locator('#board [data-arrow="played"]')).toHaveCount(1);
  await expect(page.locator('#board [data-arrow="best"]')).toHaveCount(1);
  // the arrows carry the real squares: played = the record's move at the selected ply, best = another legal-looking move
  const ply = Number(await chips.nth(1).getAttribute("data-review-chip"));
  // the board under the arrows is the position right before that move: the mover (black here) is to move
  expect((await page.locator("#board").getAttribute("data-fen"))!.split(" ")[1]).toBe("b");
  expect((await page.locator("#board").getAttribute("data-fen"))!.split(" ")[5]).toBe(String(Math.floor(ply / 2) + 1));
  const playedMove = GAME[ply]!;
  const played = page.locator('#board [data-arrow="played"]');
  await expect(played).toHaveAttribute("data-arrow-from", playedMove.slice(0, 2));
  await expect(played).toHaveAttribute("data-arrow-to", playedMove.slice(2));
  const best = page.locator('#board [data-arrow="best"]');
  const bestFrom = (await best.getAttribute("data-arrow-from"))!;
  const bestTo = (await best.getAttribute("data-arrow-to"))!;
  expect(bestFrom).toMatch(/^[a-i][0-9]$/);
  expect(bestTo).toMatch(/^[a-i][0-9]$/);
  expect(bestFrom + bestTo).not.toBe(playedMove);
  // a danger ring, when drawn, sits on a piece of the board shown (the position before the move), never on the landing square
  for (const ring of await page.locator("#board [data-danger]").all()) {
    const square = (await ring.getAttribute("data-danger"))!;
    expect(square).not.toBe(playedMove.slice(2));
    await expect(page.locator(`#board [data-square="${square}"]`)).toHaveAttribute("aria-label", /將|士|象|馬|車|砲|卒/);
  }
  // the card title announces the change of key move to screen readers
  await expect(page.locator("#review-focus .focus-card-head")).toHaveAttribute("aria-live", "polite");
  const card = page.locator("#review-focus");
  await expect(card).toContainText("你走了");
  await expect(card).toContainText("比較好的是");
  await expect(card).toContainText("你這樣走，接下來會是");
  await expect(card).toContainText("改走");
  // no engine numbers on the ordinary screen
  await expect(card).not.toContainText(/節點|深度|centipawn/);

  // walking to the last key move disables the next button; the keyboard focus must stay inside the review card
  const next = page.getByRole("button", { name: "下一步" });
  while (await next.isEnabled()) await next.click();
  await expect(next).toBeDisabled();
  expect(await page.evaluate(() => document.activeElement?.closest("#review-focus") !== null)).toBe(true);
  const prev = page.getByRole("button", { name: "上一步" });
  while (await prev.isEnabled()) await prev.click();
  await expect(prev).toBeDisabled();
  expect(await page.evaluate(() => document.activeElement?.closest("#review-focus") !== null)).toBe(true);
});

test("P6 review page: a single chip click alone loads the branch position (no stuck loading, no page error)", async ({ page }) => {
  test.setTimeout(300_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await loadAndReview(page);
  await openSettingsCategory(page, "review");
  await page.locator("#review-perspective").selectOption("black");
  await openTab(page, "review");
  const chips = page.locator("[data-review-chip]");
  await expect(chips.nth(0)).toBeVisible();
  const ply = Number(await chips.nth(0).getAttribute("data-review-chip"));
  expect(ply).toBeGreaterThan(0);
  // only this one click: no step buttons, no keyboard (the focus stays on the chip)
  await chips.nth(0).click();
  await expect(page.getByText("正在載入分支局面")).toHaveCount(0, { timeout: 30_000 });
  // the board is the position before that move: replay the record up to it in the page's own data
  const played = page.locator('#board [data-arrow="played"]');
  await expect(played).toHaveCount(1);
  await expect(played).toHaveAttribute("data-arrow-from", GAME[ply]!.slice(0, 2));
  await expect(played).toHaveAttribute("data-arrow-to", GAME[ply]!.slice(2));
  const fen = (await page.locator("#board").getAttribute("data-fen"))!;
  expect(fen.split(" ")[0]).not.toBe("rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR"); // not the opening position (ply is at least 1)
  expect(fen.split(" ")[1]).toBe(ply % 2 === 0 ? "w" : "b");
  expect(fen.split(" ")[5]).toBe(String(Math.floor(ply / 2) + 1));
  expect(pageErrors).toEqual([]);
});

test("P6 library page: a saved game gets a row with a button that opens its review", async ({ page }) => {
  await page.goto("/");
  await openTab(page, "review");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill("h2e2 h9g7");
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await expect(page.locator("#move-list code")).toHaveCount(2);
  await waitForImportJump(page);
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await openTab(page, "library");
  const row = page.locator("#game-library-list li").first();
  await expect(row).toContainText("尚未覆盤");
  await expect(row.getByRole("button", { name: /看覆盤/ })).toBeVisible();
  await row.getByRole("button", { name: /看覆盤/ }).click();
  await expect(page.locator('.app-shell[data-route="review"]')).toBeVisible();
  await expect(page.locator("#move-list code")).toHaveCount(2);
});

test("P6 review page: a hidden page does not redraw the board", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list code")).toHaveCount(2, { timeout: 15_000 });
  await page.evaluate(() => { (document.querySelector("#board .board-cell") as Element & { __mark?: boolean }).__mark = true; });
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list li button")).toHaveCount(1);
  const stillThere = await page.evaluate(() => (document.querySelector("#board .board-cell") as Element & { __mark?: boolean }).__mark === true);
  expect(stillThere).toBe(true);
  await openTab(page, "play");
  await expect(page.locator("#board .board-cell")).toHaveCount(90);
  await expect(page.locator("#move-list code")).toHaveCount(2);
});
