import { expect, test, type Page } from "@playwright/test";
import { enableDevMode, openSettings, openTab } from "./helpers/nav";
import { openSettingsCategory } from "./helpers/nav";

// 覆盤中：悔棋退回棋盤上一步（不動主棋局），即時勝率跟著棋盤局面。
async function boardFen(page: Page): Promise<string> {
  return (await page.locator("#board").getAttribute("data-fen"))!;
}

async function openReview(page: Page): Promise<void> {
  await page.goto("/");
  await openSettings(page);
  await page.getByLabel("電腦難度").selectOption("1");
  await openSettingsCategory(page, "advanced");
  await page.locator("#dev-mode-toggle").check();
  await page.locator("#live-evaluation-toggle").check();
  await enableDevMode(page);
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list code")).toHaveCount(2, { timeout: 30_000 });
  await startReview(page);
}

async function startReview(page: Page): Promise<void> {
  await openTab(page, "review");
  await page.locator("#start-review").click();
  await expect(page.locator("[data-review-point]").first()).toBeVisible({ timeout: 120_000 });
}

async function expectMeterFollowsBoard(page: Page): Promise<void> {
  const meter = page.locator("#live-win-probability");
  // the board loads the clicked node asynchronously; compare both sides each poll instead of a FEN read before the load
  await expect.poll(async () => {
    const board = page.locator("#board");
    if ((await board.getAttribute("aria-disabled")) === "true") return "loading";
    return (await meter.getAttribute("data-evaluation-fen")) === (await boardFen(page)) ? "match" : "differ";
  }, { timeout: 30_000 }).toBe("match");
  await expect(meter).toBeVisible();
  await expect(page.locator("#live-win-probability")).toContainText(/\d{1,3}(\.\d)?%/);
}

// main-0 is the start position, main-1 is after 炮二平五 (h2e2), the first move openReview plays
const NODE_FENS: Record<string, string> = {
  "main-1": "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C2C4/9/RNBAKABNR b - - 1 1",
  "main-0": "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1",
};

async function clickTwoNodes(page: Page): Promise<void> {
  for (const id of ["main-1", "main-0"]) {
    await page.locator(`#variation-tree [data-variation-node="${id}"]`).click();
    // the board must show the clicked node first, so a meter that already matched the previous node cannot pass
    await expect(page.locator("#board")).toHaveAttribute("data-fen", NODE_FENS[id], { timeout: 30_000 });
    await expectMeterFollowsBoard(page);
  }
}

test("in review, undo steps back on the displayed line and leaves the main game alone", async ({ page }) => {
  test.setTimeout(240_000);
  await openReview(page);
  const movesBefore = await page.locator("#move-list code").count();
  await page.locator('#variation-tree [data-variation-node="main-1"]').click();
  // main-1 is after 炮二平五, black to move
  await expect(page.locator("#board")).toHaveAttribute("data-fen", / b /, { timeout: 30_000 });
  const parentFen = await boardFen(page);
  await page.locator('[data-square="h7"]').click();
  await page.locator('[data-square="e7"]').click();
  await expect(page.locator('#variation-tree [data-variation-node="branch-1"]')).toBeVisible({ timeout: 30_000 });
  expect(await boardFen(page)).not.toBe(parentFen);
  await expect(page.locator("#undo")).toBeEnabled();
  await page.locator("#undo").click();
  await expect(page.locator("#board")).toHaveAttribute("data-fen", parentFen, { timeout: 30_000 });
  await expect(page.locator("#move-list code")).toHaveCount(movesBefore);
});

test("in review, undo is disabled at the start position", async ({ page }) => {
  test.setTimeout(240_000);
  await openReview(page);
  await page.locator('#variation-tree [data-variation-node="main-0"]').click();
  await expect(page.locator('#variation-tree [data-variation-node="main-0"]')).toBeVisible();
  await expect(page.locator("#undo")).toBeDisabled({ timeout: 30_000 });
});

test("in review, the live meter follows the displayed position, also after a second review", async ({ page }) => {
  test.setTimeout(300_000);
  await openReview(page);
  await clickTwoNodes(page);
  await startReview(page);
  await clickTwoNodes(page);
});

// 回合表隨棋局保存：存檔、重新打開之後，在分支上走一步（電腦自動回一步），悔棋一次退一整回合。
test("in review, one undo still takes back a whole turn after the saved game is reopened", async ({ page }) => {
  test.setTimeout(300_000);
  await openReview(page);
  await page.locator('#variation-tree [data-variation-node="main-1"]').click();
  await expect(page.locator("#board")).toHaveAttribute("data-fen", / b /, { timeout: 30_000 });
  const turnStartFen = await boardFen(page);
  await page.locator('[data-square="h7"]').click();
  await page.locator('[data-square="e7"]').click();
  // the computer answers the branch move by itself, so the line shown ends two plies after the turn start
  await expect(page.locator('#variation-tree [data-variation-node="branch-2"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#board")).not.toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
  const afterReplyFen = await boardFen(page);
  expect(afterReplyFen).not.toBe(turnStartFen);

  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list li.library-item")).toHaveCount(1);

  await page.reload();
  await page.locator("#game-library-list button.library-row").first().click();
  await page.locator('.app-shell[data-route="review"]').waitFor();
  // the saved game carries its variation tree but not the review itself unless it was saved after one: review again
  await startReview(page);
  await page.locator('#variation-tree [data-variation-node="branch-2"]').click();
  await expect(page.locator("#board")).toHaveAttribute("data-fen", afterReplyFen, { timeout: 30_000 });
  await expect(page.locator("#undo")).toBeEnabled({ timeout: 30_000 });
  await page.locator("#undo").click();
  await expect(page.locator("#board")).toHaveAttribute("data-fen", turnStartFen, { timeout: 30_000 });
});
