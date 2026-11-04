import { expect, test, type Page } from "@playwright/test";
import { openTab } from "./helpers/nav";
import { enableDevMode, openSettingsCategory, waitForImportJump } from "./helpers/nav";

// P3: a second review of the same game (or of a game that starts the same way) reuses finished
// plies from the IndexedDB cache; a changed engine version never reuses them.
const GAME = ["c3c4", "g6g5", "h2g2", "g9e7", "h0i2", "h9g7"];
// Same first four moves, different ending (both are horse moves from the start squares).
const GAME_SHARED_OPENING = ["c3c4", "g6g5", "h2g2", "g9e7", "b0c2", "b9c7"];
const SMALL_BUDGET = "2000";

/** Pages in one context share IndexedDB; this counts the review workers a page ever starts. */
function countReviewWorkers(page: Page): () => number {
  let count = 0;
  page.on("worker", (worker) => {
    if (worker.url().includes("review.worker")) count += 1;
  });
  return () => count;
}

async function loadGame(page: Page, query: string, moves: string[]): Promise<void> {
  await page.goto(`/?review-workers=2${query}`);
  await enableDevMode(page);
  await openTab(page, "review");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill(moves.join(" "));
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await expect(page.locator("#move-list code")).toHaveCount(moves.length);
  await waitForImportJump(page);
}

async function selectBudget(page: Page, value: string): Promise<void> {
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

async function reviewToCompletion(page: Page, moves: string[]): Promise<void> {
  await selectBudget(page, SMALL_BUDGET);
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator("#review-panel [role=status]").first()).toHaveText("分析完成", { timeout: 240_000 });
  await expect(page.locator("[data-review-point]")).toHaveCount(moves.length);
}

async function collect(page: Page, moves: string[]) {
  const collected: Array<Record<string, string | null>> = [];
  for (let index = 0; index < moves.length; index += 1) {
    await page.locator(`[data-review-point="${index}"]`).click();
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>("#review-panel")?.dataset.continuationComplete === "true",
      null,
      { timeout: 60_000 },
    );
    const attributes = await page.locator(`[data-review-point="${index}"]`).evaluate((element) => ({
      classification: element.getAttribute("data-review-classification"),
      winProbability: element.getAttribute("data-review-user-win-probability"),
    }));
    let text = "";
    await expect.poll(async () => {
      text = await page.locator("#review-panel").innerText();
      return text.includes("這條線的勝率") && !text.includes("正在載入分支局面");
    }, { timeout: 60_000 }).toBe(true);
    // The note about cached plies is the one thing allowed to differ between a first and a repeat review.
    collected.push({ ...attributes, text: text.replace(/已從先前的分析載入[^\n]*/, "").replace(/\s+/g, " ") });
  }
  return collected;
}

test("reviewing the same game again is served from the cache and shows identical results", async ({ context }) => {
  test.setTimeout(600_000);
  const first = await context.newPage();
  const firstWorkers = countReviewWorkers(first);
  await loadGame(first, "", GAME);
  await reviewToCompletion(first, GAME);
  expect(firstWorkers()).toBeGreaterThan(0);
  await expect(first.locator("#review-panel")).toHaveAttribute("data-review-cached-plies", "0");
  const computed = await collect(first, GAME);
  await first.close();

  const second = await context.newPage();
  const secondWorkers = countReviewWorkers(second);
  await loadGame(second, "", GAME);
  await reviewToCompletion(second, GAME);
  // The deterministic signal: every ply came from the cache and no review worker was ever started.
  await expect(second.locator("#review-panel")).toHaveAttribute("data-review-cached-plies", String(GAME.length));
  await expect(second.getByText(`已從先前的分析載入 ${GAME.length} 步，不必重算`)).toBeVisible();
  expect(secondWorkers()).toBe(0);
  const cached = await collect(second, GAME);
  expect(cached).toEqual(computed);

  // A game that shares its opening reuses only the shared plies and computes the rest.
  const third = await context.newPage();
  const thirdWorkers = countReviewWorkers(third);
  await loadGame(third, "", GAME_SHARED_OPENING);
  await reviewToCompletion(third, GAME_SHARED_OPENING);
  await expect(third.locator("#review-panel")).toHaveAttribute("data-review-cached-plies", "4");
  expect(thirdWorkers()).toBeGreaterThan(0);
  await third.close();
  await second.close();
});

test("a different engine version does not reuse cached results", async ({ context }) => {
  test.setTimeout(600_000);
  const first = await context.newPage();
  await loadGame(first, "", GAME);
  await reviewToCompletion(first, GAME);
  await first.close();

  const other = await context.newPage();
  const otherWorkers = countReviewWorkers(other);
  await loadGame(other, "&review-cache-version=next-build", GAME);
  await selectBudget(other, SMALL_BUDGET);
  await other.getByRole("button", { name: "開始覆盤" }).click();
  await expect.poll(() => otherWorkers(), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(other.locator("#review-panel")).toHaveAttribute("data-review-cached-plies", "0");
  await other.getByRole("button", { name: "取消分析" }).click();
  await other.close();
});
