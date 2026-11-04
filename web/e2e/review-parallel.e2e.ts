import { expect, test, type Page } from "@playwright/test";
import { openTab } from "./helpers/nav";
import { enableDevMode, openSettingsCategory, waitForImportJump } from "./helpers/nav";

// P2: reviewing with several workers must give exactly the same analysis as one worker.
// The analysis cache is switched off here (review-cache=off): pages of one context share IndexedDB,
// so the second review would otherwise be read back from the first instead of being computed.
const GAME = ["c3c4", "g6g5", "h2g2", "g9e7", "h0i2", "h9g7"];
const SMALL_BUDGET = "2000";

async function loadGame(page: Page, workers: number, moves: string[]): Promise<void> {
  await page.goto(`/?review-workers=${workers}&review-cache=off`);
  await enableDevMode(page);
  await openTab(page, "review");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill(moves.join(" "));
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await expect(page.locator("#move-list code")).toHaveCount(moves.length);
  await waitForImportJump(page);
}

async function selectBudget(page: Page, value: string): Promise<void> {
  // The UI only offers 100k and up; tests add a small budget so the run stays short.
  await page.evaluate((budget) => {
    const select = document.querySelector<HTMLSelectElement>("#review-budget")!;
    if (![...select.options].some((option) => option.value === budget)) {
      select.append(new Option(`test ${budget}`, budget));
    }
  }, value);
  await openSettingsCategory(page, "review");
  await page.locator("#review-budget").selectOption(value);
  await openTab(page, "review");
}

async function reviewAndCollect(page: Page, workers: number) {
  await loadGame(page, workers, GAME);
  await selectBudget(page, SMALL_BUDGET);
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator("#review-panel")).toHaveAttribute("data-review-workers", String(workers));
  await expect(page.locator("#review-panel [role=status]").first()).toHaveText("分析完成", { timeout: 240_000 });
  await expect(page.locator("[data-review-point]")).toHaveCount(GAME.length);
  const collected: Array<Record<string, string | null>> = [];
  for (let index = 0; index < GAME.length; index += 1) {
    const circle = page.locator(`[data-review-point="${index}"]`);
    await circle.click();
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>("#review-panel")?.dataset.continuationComplete === "true",
      null,
      { timeout: 60_000 },
    );
    const attributes = await page.locator(`[data-review-point="${index}"]`).evaluate((element) => ({
      classification: element.getAttribute("data-review-classification"),
      winProbability: element.getAttribute("data-review-user-win-probability"),
    }));
    // The branch evaluation for this point loads asynchronously; keep the first read that has settled.
    let text = "";
    await expect.poll(async () => {
      text = await page.locator("#review-panel").innerText();
      return text.includes("這條線的勝率") && !text.includes("正在載入分支局面");
    }, { timeout: 60_000 }).toBe(true);
    collected.push({ ...attributes, text });
  }
  return collected;
}

test("one worker and four workers produce identical review points", async ({ browser }) => {
  test.setTimeout(540_000);
  const single = await browser.newPage();
  const serial = await reviewAndCollect(single, 1);
  await single.close();
  const many = await browser.newPage();
  const parallel = await reviewAndCollect(many, 4);
  await many.close();
  expect(parallel).toHaveLength(GAME.length);
  for (let index = 0; index < GAME.length; index += 1) {
    expect(parallel[index], `ply ${index + 1}`).toEqual(serial[index]);
  }
});

test("cancelling a four-worker review stops every worker", async ({ page }) => {
  test.setTimeout(240_000);
  await loadGame(page, 4, GAME);
  await selectBudget(page, "20000");
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator("#review-panel")).toHaveAttribute("data-review-active-workers", "4");
  await page.getByRole("button", { name: "取消分析" }).click();
  await expect(page.locator("#review-panel [role=status]").first()).toHaveText("分析已取消", { timeout: 30_000 });
  await expect(page.locator("#review-panel")).toHaveAttribute("data-review-active-workers", "0");
  const settled = await page.locator("[data-review-point]").count();
  await page.waitForTimeout(4_000);
  await expect(page.locator("#review-panel [role=status]").first()).toHaveText("分析已取消");
  expect(await page.locator("[data-review-point]").count()).toBe(settled);
  expect(settled).toBeLessThan(GAME.length);
});
