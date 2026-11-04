import { expect, test, type Page } from "@playwright/test";
import { openSettings, openSettingsCategory, openTab } from "./helpers/nav";

// Eight plies of a weak game (the same record as p6-review.e2e.ts).
const GAME = ["a3a4", "h7h5", "a4a5", "h5h4", "a5a6", "b7b5", "a6b6", "f9e8"];

const CATEGORIES = [
  { id: "play", label: "對弈" },
  { id: "review", label: "覆盤" },
  { id: "level", label: "我的程度" },
  { id: "data", label: "棋譜與資料" },
  { id: "advanced", label: "進階" },
] as const;

test("P6 settings: five categories, each shows its own title", async ({ page }) => {
  await page.goto("/");
  await openSettings(page);
  const nav = page.getByRole("navigation", { name: "設定分類" });
  await expect(nav.getByRole("button")).toHaveCount(5);
  for (const category of CATEGORIES) {
    await nav.getByRole("button", { name: category.label, exact: true }).click();
    await expect(page.locator("#settings-body").getByRole("heading", { level: 2, name: category.label, exact: true })).toBeVisible();
    await expect(nav.getByRole("button", { name: category.label, exact: true })).toHaveAttribute("aria-pressed", "true");
    // only the chosen category is on screen
    await expect(page.locator("[data-settings-panel]:visible")).toHaveCount(1);
  }
});

test("P6 settings: every control lives in the category the plan names", async ({ page }) => {
  await page.goto("/");
  await openSettingsCategory(page, "play");
  await expect(page.locator("#difficulty-level")).toBeVisible();
  await expect(page.locator("#user-side")).toBeVisible();
  await openSettingsCategory(page, "review");
  await expect(page.locator('[data-settings-panel="review"] #review-budget')).toBeVisible();
  await expect(page.locator('[data-settings-panel="review"] #review-perspective')).toBeVisible();
  await openSettingsCategory(page, "level");
  for (const id of ["#user-level", "#user-level-reestimate", "#user-level-status"]) {
    await expect(page.locator(`[data-settings-panel="level"] ${id}`)).toBeVisible();
  }
  await openSettingsCategory(page, "data");
  await expect(page.getByLabel("貼上棋譜")).toBeVisible();
  await expect(page.getByRole("button", { name: "辨識並載入" })).toBeVisible();
  await expect(page.locator("#archive-export")).toBeVisible();
  await openSettingsCategory(page, "advanced");
  await expect(page.locator("#dev-mode-toggle")).toBeVisible();
  await expect(page.locator("#review-engine-notice")).toBeVisible();
  // the review budget is not a play-page or advanced-page control any more
  await expect(page.locator("#review-budget")).toBeHidden();
});

test("P6 settings: the review budget set in settings is remembered", async ({ page }) => {
  await page.goto("/");
  await openSettingsCategory(page, "review");
  await expect(page.locator("#review-budget")).toHaveValue("100000");
  await page.locator("#review-budget").selectOption("1000000");
  await page.reload();
  await openSettingsCategory(page, "review");
  await expect(page.locator("#review-budget")).toHaveValue("1000000");
});

async function loadAndReview(page: Page): Promise<void> {
  await page.goto("/?review-workers=2");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill(GAME.join(" "));
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await expect(page.locator("#move-list code")).toHaveCount(GAME.length);
  await openSettingsCategory(page, "review");
  await page.evaluate(() => {
    document.querySelector<HTMLSelectElement>("#review-budget")!.append(new Option("test 2000", "2000"));
  });
  await page.locator("#review-budget").selectOption("2000");
  await openTab(page, "review");
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator("#review-panel")).toContainText("分析完成", { timeout: 240_000 });
}

const DEV_TEXTS = ["原始搜尋", "逐局面續算", "分支樹", "選擇此變化", "讓引擎走", "想更久", "分支註解"];

test("P6 settings: the review page hides engine details and play buttons until developer mode is on", async ({ page }) => {
  test.setTimeout(300_000);
  await loadAndReview(page);
  // normal mode: the key-move area, board, curve, move list and the re-analyse button stay
  await expect(page.locator("#review-focus")).toBeVisible();
  await expect(page.locator("#board")).toBeVisible();
  await expect(page.getByRole("img", { name: "勝率曲線" })).toBeVisible();
  await expect(page.locator("#move-list")).toBeVisible();
  await expect(page.getByRole("button", { name: "重新分析" })).toBeVisible();
  for (const text of DEV_TEXTS) {
    await expect(page.getByText(text).first(), `${text} must not be visible in normal mode`).toBeHidden();
  }
  // the determinism attributes stay in the page, only the text is hidden
  expect(await page.locator("[data-pv-line]").count()).toBeGreaterThan(0);
  await expect(page.locator("[data-pv-nodes]").first()).toBeAttached();
  await expect(page.locator("[data-pv-continuation-status]").first()).toBeAttached();
  await expect(page.locator("#variation-tree")).toBeAttached();
  await expect(page.locator("#variation-tree")).toBeHidden();
  // the play page's restart button is not on the review page, the review's own step back is
  await expect(page.getByRole("button", { name: "重新開始" })).toHaveCount(0);
  await expect(page.locator("#undo")).toBeVisible();
  // the saved-game list belongs to the library page only
  await expect(page.locator("#game-library-list")).toBeHidden();
  await expect(page.getByRole("region", { name: "棋局庫" })).toHaveCount(0);

  // developer mode on: the details come back
  await openSettingsCategory(page, "advanced");
  await page.locator("#dev-mode-toggle").check();
  await openTab(page, "review");
  for (const text of ["原始搜尋", "分支樹", "逐局面續算"]) {
    await expect(page.getByText(text).first(), `${text} must be visible in developer mode`).toBeVisible();
  }
  await expect(page.locator("#variation-tree")).toBeVisible();
  await expect(page.getByRole("button", { name: "選擇此變化" }).first()).toBeVisible();
});

test("P6 settings: the review note can be made in normal mode once the review is done", async ({ page }) => {
  test.setTimeout(300_000);
  await loadAndReview(page);
  await expect(page.getByRole("button", { name: "產生覆盤筆記" })).toBeVisible();
  await page.getByRole("button", { name: "產生覆盤筆記" }).click();
  await expect(page.locator("#review-note-preview")).toBeVisible();
  await expect(page.getByRole("button", { name: "複製" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "下載 Markdown" })).toBeVisible();
});

test("P6 settings: the library page has the list and the save button, the play and review pages have neither", async ({ page }) => {
  await page.goto("/");
  await openTab(page, "library");
  await expect(page.locator("#game-library-list")).toBeVisible();
  await expect(page.getByRole("button", { name: "儲存棋局" })).toBeVisible();
  for (const route of ["play", "review", "settings"] as const) {
    await openTab(page, route);
    await expect(page.locator("#game-library-list")).toBeHidden();
    await expect(page.getByRole("button", { name: "儲存棋局" })).toHaveCount(0);
  }
});

test("P6 settings C1: switching to red while the computer still thinks about its black opening restarts as red", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await openSettings(page); // 對弈 is the category shown first
  await page.locator("#difficulty-level").selectOption("10");
  // both changes in one script: the computer's opening for black is still being computed at the second one
  await page.evaluate(() => {
    const side = document.querySelector<HTMLSelectElement>("#user-side")!;
    side.value = "black";
    side.dispatchEvent(new Event("change", { bubbles: true }));
    side.value = "red";
    side.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#user-side")).toHaveValue("red");
  await openTab(page, "play");
  await expect(page.locator("#board")).toHaveAttribute("data-user-side", "red");
  await expect(page.locator("#board")).toHaveAttribute("data-flipped", "false");
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  // the discarded black opening must not arrive on the red board
  await page.waitForTimeout(2_000);
  await expect(page.locator("#move-list .move-row")).toHaveCount(0);
  await expect(page.locator("#board")).toHaveAttribute("data-user-side", "red");
  await expect(page.locator("#side-next-note")).toBeHidden();
});

test("P6 settings C2: a side chosen mid-game says it applies next game, and the note goes away on the new game", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await openSettings(page); // 對弈 is the category shown first
  await page.locator("#difficulty-level").selectOption("1");
  await openTab(page, "play");
  await expect(page.locator("#side-next-note")).toBeHidden();
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list .move-row")).toHaveCount(2, { timeout: 30_000 });
  await openSettings(page); // 對弈 is the category shown first
  await page.locator("#user-side").selectOption("black");
  await openTab(page, "play");
  // this game goes on as red
  await expect(page.locator("#board")).toHaveAttribute("data-user-side", "red");
  await expect(page.locator("#side-next-note")).toBeVisible();
  await expect(page.locator("#side-next-note")).toHaveText("下一盤改執黑。");
  await page.getByRole("button", { name: "重新開始" }).click();
  await expect(page.locator("#board")).toHaveAttribute("data-user-side", "black");
  await expect(page.locator("#side-next-note")).toBeHidden();
  // choosing red again while black's game has not been touched restarts at once and needs no note
  await expect(page.locator("#move-list .move-row")).toHaveCount(1, { timeout: 30_000 });
});

async function loadGameOnly(page: Page): Promise<void> {
  await page.goto("/");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill(GAME.join(" "));
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await expect(page.locator("#move-list code")).toHaveCount(GAME.length);
  await openTab(page, "review");
}

test("P6 settings layout: before a review the start button is on the first screen and there is no turn-status card", async ({ page }) => {
  await loadGameOnly(page);
  await expect(page.locator("#turn-status")).toBeHidden();
  await expect(page.getByRole("region", { name: "覆盤" })).toBeHidden();
  const start = page.locator("#start-review");
  await expect(start).toBeVisible();
  const box = await start.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.y + box!.height, "start review must be inside the first screen").toBeLessThanOrEqual(viewport.height);
  const board = await page.locator("#board").boundingBox();
  // the side panel sits beside the board on a wide screen, so the button must not be pushed below the move list
  const moveList = await page.locator("#move-list").boundingBox();
  expect(box!.y, "start review comes before the move list").toBeLessThan(moveList!.y);
  expect(board).not.toBeNull();
});

test("P6 settings layout: after a review the order is key moves, curve, review actions, move list; no turn-status card", async ({ page }) => {
  test.setTimeout(300_000);
  await loadAndReview(page);
  await expect(page.locator("#turn-status")).toBeHidden();
  await expect(page.locator("#selection-status")).toBeHidden();
  const top = async (loc: ReturnType<Page["locator"]>): Promise<number> => (await loc.boundingBox())!.y;
  const focusY = await top(page.locator("#review-focus"));
  const curveY = await top(page.getByRole("img", { name: "勝率曲線" }));
  const actionY = await top(page.getByRole("button", { name: "重新分析" }));
  const noteY = await top(page.getByRole("button", { name: "產生覆盤筆記" }));
  const undoY = await top(page.locator("#undo"));
  const listY = await top(page.locator("#move-list"));
  expect(focusY, "key moves before the curve").toBeLessThan(curveY);
  expect(curveY, "curve before the review actions").toBeLessThan(actionY);
  expect(actionY, "re-analyse before the move list").toBeLessThan(listY);
  expect(noteY, "note button before the move list").toBeLessThan(listY);
  expect(undoY, "undo (branch step back) before the move list").toBeLessThan(listY);
  // the move list is short and scrolls inside itself
  const listHeight = (await page.locator("#move-list").boundingBox())!.height;
  expect(listHeight).toBeLessThanOrEqual(200);
});

test("P6 settings: ordinary mode settings page shows no 100,000 and no node wording", async ({ page }) => {
  await page.goto("/");
  await openSettingsCategory(page, "review");
  const panel = page.locator('[data-settings-panel="review"]');
  await expect(panel).not.toContainText("100,000");
  await expect(panel).not.toContainText("節點");
  const options = await page.locator("#review-budget option").allTextContents();
  expect(options.join("|")).not.toMatch(/\d{2,3},\d{3}|節點/);
  await expect(page.locator("#review-budget option")).toHaveCount(3);
});

test("P6 settings layout: on the review page, before a review starts, undo is disabled and the game stays whole", async ({ page }) => {
  await loadGameOnly(page);
  await expect(page.locator("#undo")).toBeDisabled();
  await expect(page.locator("#move-list code")).toHaveCount(GAME.length);
});

test("P6 settings layout: on a phone-sized screen the turn-status card is hidden and key moves come before the review panel", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await loadAndReview(page);
  await expect(page.locator("#turn-status")).toBeHidden();
  const focusY = (await page.locator("#review-focus").boundingBox())!.y;
  const panelY = (await page.getByRole("region", { name: "覆盤" }).boundingBox())!.y;
  expect(focusY, "key moves before the review panel").toBeLessThan(panelY);
});
