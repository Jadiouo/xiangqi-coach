import { expect, test, type Page } from "@playwright/test";
import { openSettingsCategory, openTab } from "./helpers/nav";

// P6 segment 5: a finished game is reviewed in the background and the level line says
// "N played, M counted". Every game here is a one-move mate (red plays b0b9), from distinct positions.
const MATES = [
  "4k4/R8/9/9/9/9/9/9/9/1R1K5 w - - 0 1",
  "4k4/R8/9/9/9/9/9/9/9/1RK6 w - - 0 1",
  "4k4/R8/9/9/9/9/9/9/9/1R3K3 w - - 0 1",
  "4k4/R8/9/9/9/9/9/9/9/1R1K5 w - - 0 2",
];

async function seedGame(page: Page, fen: string, extra: { assisted?: boolean; moves?: string[]; difficulty?: number } = {}): Promise<void> {
  // let the page write its own first state before the seed goes in, or it would overwrite the seed
  await expect(page.locator("#turn-status")).toHaveText(/^(輪到紅方|輪到黑方|紅方勝|黑方勝|和棋)$/);
  await page.evaluate(([startFen, assisted, moves, difficulty]) => {
    localStorage.setItem("xq.game-in-progress.v1", JSON.stringify({ version: 1, game: {
      startFen, moves, userSide: "red", difficulty, source: "played", importFormat: null, importMetadata: {},
      importWarnings: [], assisted, libraryRecordId: null,
    } }));
  }, [fen, extra.assisted ?? false, extra.moves ?? [], extra.difficulty ?? 1] as const);
  await page.reload();
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  // the default board also says "red to move": wait until the seeded position is really the one on the board
  if (!(extra.moves?.length)) await expect(page.locator("#board")).toHaveAttribute("data-fen", new RegExp(`^${fen.split(" ")[0]!.replace(/\//g, "\\/")}`));
}

async function mate(page: Page): Promise<void> {
  await page.locator('#board .board-cell[data-square="b0"]').click();
  await page.locator('#board .board-cell[data-square="b9"]').click();
  await expect(page.locator("#game-over-card")).toBeVisible();
}

/** The page has read its level and drawn once, so the background review has had its chance to start. */
async function settled(page: Page): Promise<void> {
  await expect(page.locator("#user-level-status")).toHaveAttribute("data-level", /.+/);
}

async function bgState(page: Page): Promise<string | null> {
  return page.locator("#played-count").getAttribute("data-bg-state");
}

/** Holds back every review worker's first message, so a background review stays "running" long enough to look at. */
async function slowReviewWorkers(page: Page, ms = 4_000): Promise<void> {
  await page.addInitScript((delay) => {
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes("review.worker")) {
          const post = this.postMessage.bind(this);
          this.postMessage = ((message: unknown, transfer?: StructuredSerializeOptions) => { setTimeout(() => post(message, transfer), delay); }) as typeof this.postMessage;
        }
      }
    };
  }, ms);
}

async function playedLine(page: Page): Promise<string> {
  await openSettingsCategory(page, "level");
  return (await page.locator("#played-count").innerText()).trim();
}

async function expectPlayedLine(page: Page, text: RegExp | string): Promise<void> {
  await openSettingsCategory(page, "level");
  await expect(page.locator("#played-count")).toHaveText(text, { timeout: 60_000 });
}

test("a finished game is reviewed in the background and counted once", async ({ page }) => {
  await page.goto("/");
  await seedGame(page, MATES[0]!);
  await mate(page);
  await expect(page.locator("#game-over-bg-review")).toHaveText("背景覆盤中…");
  await expect(page.locator("#played-count")).toHaveAttribute("aria-live", "off");
  await expect(page.locator("#played-count")).toHaveAttribute("data-bg-state", "done", { timeout: 60_000 });
  await expectPlayedLine(page, /^已下 1 盤，1 盤已計入$/);
  await openTab(page, "play");
  await expect(page.locator("#game-over-bg-review")).toBeHidden();
  await page.reload();
  expect(await playedLine(page)).toBe("已下 1 盤，1 盤已計入");
});

test("after three games the level shows, and M is three", async ({ page }) => {
  await page.goto("/");
  for (const fen of MATES.slice(0, 3)) {
    await seedGame(page, fen);
    await mate(page);
    await openTab(page, "play");
  }
  await expectPlayedLine(page, /^已下 3 盤，3 盤已計入$/);
  await expect(page.locator("#user-level-status")).toHaveAttribute("data-displayed", "true");
  await expect(page.locator("#user-level-status")).toHaveAttribute("data-game-count", "3");
});

test("a game played with the live win rate counts in neither N nor M, and is said so", async ({ page }) => {
  await page.goto("/");
  await seedGame(page, MATES[0]!, { assisted: true });
  await mate(page);
  await expectPlayedLine(page, /^已下 0 盤，0 盤已計入。另有 1 盤開了即時勝率，不計入$/);
  await page.reload();
  await settled(page);
  expect(await bgState(page)).toBe("idle");
  await expect(page.locator("#user-level-status")).toHaveAttribute("data-game-count", "0");
});

test("an imported record is not entered", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill("a3a4 h7h5 a4a5 h5h4");
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await expect(page.locator("#move-list code")).toHaveCount(4);
  await page.reload();
  await settled(page);
  expect(await bgState(page)).toBe("idle");
  await openSettingsCategory(page, "level");
  await expect(page.locator("#played-count")).toHaveText("");
  await expect(page.locator("#user-level-status")).toHaveAttribute("data-game-count", "0");
});

test("reviewing the same game by hand counts it once, also after a reload", async ({ page }) => {
  await page.goto("/");
  await seedGame(page, MATES[0]!);
  await mate(page);
  await page.locator("#game-over-review").click();
  await expect(page.locator('.app-shell[data-route="review"]')).toBeVisible();
  await expect(page.locator("#review-panel")).toContainText("分析完成", { timeout: 60_000 });
  await expectPlayedLine(page, /^已下 1 盤，1 盤已計入$/);
  await page.reload();
  await settled(page);
  expect(await bgState(page)).toBe("idle");
  expect(await playedLine(page)).toBe("已下 1 盤，1 盤已計入");
  await expect(page.locator("#user-level-status")).toHaveAttribute("data-game-count", "1");
});

test("a game left pending is picked up on the next page load, but not while another game is on", async ({ page }) => {
  await page.goto("/?auto-review=off");
  await seedGame(page, MATES[0]!);
  await mate(page);
  await settled(page);
  expect(await bgState(page)).toBe("idle");
  expect(await playedLine(page)).toBe("已下 1 盤，0 盤已計入");
  // a game in progress keeps the background review away from the machine
  await seedGame(page, MATES[1]!, { moves: ["a8a7", "e9e8"] });
  await page.goto("/");
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  await settled(page);
  expect(await bgState(page)).toBe("idle");
  expect(await playedLine(page)).toBe("已下 1 盤，0 盤已計入");
  // finishing that game frees the machine: both are counted
  await openTab(page, "play");
  await seedGame(page, MATES[1]!);
  await mate(page);
  await expectPlayedLine(page, /^已下 2 盤，2 盤已計入$/);
});

test("with a level chosen by hand nothing is counted and the line says so", async ({ page }) => {
  await page.goto("/");
  await openSettingsCategory(page, "level");
  await page.locator("#user-level").selectOption("expert");
  await openTab(page, "play");
  await seedGame(page, MATES[0]!);
  await mate(page);
  await settled(page);
  expect(await bgState(page)).toBe("idle");
  expect(await playedLine(page)).toBe("已下 1 盤。程度是你指定的，不另外計入");
  await expect(page.locator("#game-over-bg-review")).toBeHidden();
  // back to automatic: the waiting game is reviewed and counted
  await page.locator("#user-level-reestimate").click();
  await expectPlayedLine(page, /^已下 1 盤，1 盤已計入$/);
});

test("while it runs the line reads as a sentence, and the review writes nothing to the library", async ({ page }) => {
  await slowReviewWorkers(page);
  await page.goto("/");
  await seedGame(page, MATES[0]!);
  await mate(page);
  await openSettingsCategory(page, "level");
  await expect(page.locator("#played-count")).toHaveText("已下 1 盤，0 盤已計入（背景覆盤中…）");
  expect(await bgState(page)).toBe("running");
  await expect(page.locator("#played-count")).toHaveAttribute("data-bg-state", "done", { timeout: 60_000 });
  await expect(page.locator("#played-count")).toHaveText("已下 1 盤，1 盤已計入");
  // the background review only fills the level and the review cache: no saved game, no review shown
  await openTab(page, "library");
  await expect(page.locator("#game-library-list li.library-item")).toHaveCount(0);
  await openTab(page, "review");
  await expect(page.locator("#review-panel")).toBeHidden();
});

test("the player's first move of the next game stops the background review before the computer answers", async ({ page }) => {
  await page.addInitScript(() => {
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        const workerUrl = new URL(url.toString(), window.location.href);
        if (window.location.search.includes("test-long-search=1")) workerUrl.searchParams.set("test-long-search", "1");
        super(workerUrl, options);
      }
    };
  });
  await slowReviewWorkers(page, 60_000);
  await page.goto("/?auto-review=off&test-long-search=1");
  await seedGame(page, MATES[0]!);
  await mate(page);
  await page.goto("/?test-long-search=1");
  await seedGame(page, MATES[1]!, { difficulty: 10 }); // a new game, no move yet (the waiting game is reviewed meanwhile); a high level so the computer takes long
  await expect.poll(() => bgState(page)).toBe("running");
  await page.locator('[data-square="a8"]').click();
  await page.locator('[data-square="a7"]').click();
  await expect(page.locator("#game-message")).toContainText("電腦思考中", { timeout: 2_000 });
  expect(await bgState(page)).toBe("idle");
});
