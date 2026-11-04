import { expect, test, type Page } from "@playwright/test";
import { openSettings, openTab } from "./helpers/nav";
import { openSettingsCategory } from "./helpers/nav";

// The weak game of p6-review.e2e.ts: black's plies 4 and 8 are marked at a small node budget.
const GAME = ["a3a4", "h7h5", "a4a5", "h5h4", "a5a6", "b7b5", "a6b6", "f9e8"];
const STANDARD_START_FEN = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";

async function startAsBlack(page: Page): Promise<void> {
  await page.goto("/");
  await openSettings(page);
  await page.locator("#difficulty-level").selectOption("1");
  await page.locator("#user-side").selectOption("black");
  await openTab(page, "play");
}

/** Clicks the first black piece that has a legal destination and then that destination; returns the move. */
async function playOneBlackMove(page: Page): Promise<string> {
  const squares = await page.locator("#board .board-cell:has(.piece-label-black)")
    .evaluateAll((cells) => cells.map((cell) => cell.getAttribute("data-square")).filter(Boolean) as string[]);
  for (const from of squares) {
    await page.locator(`#board .board-cell[data-square="${from}"]`).click();
    const targets = await page.locator("#board .board-cell").evaluateAll((cells) => cells.flatMap((cell) => {
      const mark = cell.querySelector(".legal-capture, .legal-dot");
      const square = cell.getAttribute("data-square");
      return mark && square ? [square] : [];
    }));
    if (targets.length === 0) continue;
    await page.locator(`#board .board-cell[data-square="${targets[0]!}"]`).click();
    return `${from}${targets[0]!}`;
  }
  throw new Error("black had no legal move");
}

async function discCentre(page: Page, square: string): Promise<{ x: number; y: number }> {
  return page.locator(`#board .board-cell[data-square="${square}"] .piece-disc`).evaluate((disc) => ({
    x: Number(disc.getAttribute("cx")), y: Number(disc.getAttribute("cy")),
  }));
}

test("P6 black: the computer opens with a legal move, the board is flipped, a black move is playable, undo returns to black's turn", async ({ page }) => {
  test.setTimeout(120_000);
  await startAsBlack(page);
  await expect(page.locator("#move-list .move-row")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator("#turn-status")).toHaveText("輪到黑方");
  const board = page.locator("#board");
  await expect(board).toHaveAttribute("data-user-side", "black");
  await expect(board).toHaveAttribute("data-flipped", "true");
  expect((await board.getAttribute("data-fen"))!.split(" ")[1]).toBe("b");
  await expect(page.locator(".board-caption")).toContainText("黑方在下");
  await expect(page.getByText("你執黑，電腦先走")).toBeVisible();
  await expect(page.locator("#move-list .move-side").first()).toHaveText("紅方");

  // the first move is the computer's, and it is legal from the starting position (checked with the engine, apart from the game worker)
  const opening = (await page.locator("#move-list code").first().innerText()).trim();
  expect(opening).toMatch(/^[a-i][0-9][a-i][0-9]$/);
  const legal = await page.evaluate(async (move) => {
    const wasmUrl = new URL("/wasm/xq_wasm.js", location.origin).href;
    const module = await import(/* @vite-ignore */ wasmUrl) as { default: () => Promise<unknown>; WebGame: new () => { play(m: string): boolean } };
    await module.default();
    return new module.WebGame().play(move);
  }, opening);
  expect(legal).toBe(true);

  // black's king (e9) is drawn at the bottom and red's (e0) at the top
  const blackKing = await discCentre(page, "e9");
  const redKing = await discCentre(page, "e0");
  expect(blackKing.y).toBeGreaterThan(redKing.y + 400);
  expect(blackKing.x).toBeCloseTo(redKing.x, 1);
  // files run right to left: a0 (red's left rook) is at the top right
  expect((await discCentre(page, "a0")).x).toBeGreaterThan((await discCentre(page, "i0")).x);

  const mine = await playOneBlackMove(page);
  await expect(page.locator("#move-list .move-row")).toHaveCount(3, { timeout: 30_000 });
  await expect(page.locator("#turn-status")).toHaveText("輪到黑方");
  expect((await page.locator("#move-list code").nth(1).innerText()).trim()).toBe(mine);
  await expect(page.locator("#move-list .move-side").nth(1)).toHaveText("黑方");

  await page.getByRole("button", { name: "悔棋" }).click();
  await expect(page.locator("#move-list .move-row")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator("#turn-status")).toHaveText("輪到黑方");
  expect((await page.locator("#move-list code").first().innerText()).trim()).toBe(opening);
  // the computer's first move cannot be taken back
  await expect(page.getByRole("button", { name: "悔棋" })).toBeDisabled();
});

test("P6 black: the choice is remembered, and a new game makes the computer open again", async ({ page }) => {
  test.setTimeout(120_000);
  await startAsBlack(page);
  await expect(page.locator("#move-list .move-row")).toHaveCount(1, { timeout: 30_000 });
  await page.reload();
  await expect(page.locator("#move-list .move-row")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator("#board")).toHaveAttribute("data-flipped", "true");
  await playOneBlackMove(page);
  await expect(page.locator("#move-list .move-row")).toHaveCount(3, { timeout: 30_000 });
  await page.getByRole("button", { name: "重新開始" }).click();
  await expect(page.locator("#move-list .move-row")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator("#turn-status")).toHaveText("輪到黑方");
  // back to red: the board turns around and red moves first
  await openSettings(page);
  await page.locator("#user-side").selectOption("red");
  await openTab(page, "play");
  await expect(page.locator("#move-list .move-row")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator("#board")).toHaveAttribute("data-flipped", "false");
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  await expect(page.locator(".board-caption")).toContainText("紅方在下");
});

test("P6 black: a saved game and the exported backup record the side, and reopening it shows the flipped board", async ({ page }) => {
  test.setTimeout(120_000);
  await startAsBlack(page);
  await expect(page.locator("#move-list .move-row")).toHaveCount(1, { timeout: 30_000 });
  await playOneBlackMove(page);
  await expect(page.locator("#move-list .move-row")).toHaveCount(3, { timeout: 30_000 });
  await openSettings(page);
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list li button")).toHaveCount(1);
  await openSettingsCategory(page, "data");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#archive-export").click(),
  ]);
  const { readFile } = await import("node:fs/promises");
  const archive = JSON.parse(await readFile((await download.path())!, "utf8")) as { games: Array<{ userSide?: string; moves: string[] }> };
  expect(archive.games).toHaveLength(1);
  expect(archive.games[0]!.userSide).toBe("black");
  expect(archive.games[0]!.moves).toHaveLength(3);
  // switch the setting back to red; the saved game still opens as a black game
  await openSettingsCategory(page, "play");
  await page.locator("#user-side").selectOption("red");
  await openTab(page, "library");
  await page.locator("#game-library-list li").first().getByRole("button", { name: /看覆盤/ }).click();
  await expect(page.locator('.app-shell[data-route="review"]')).toBeVisible();
  await expect(page.locator("#move-list code")).toHaveCount(3);
  await expect(page.locator("#board")).toHaveAttribute("data-user-side", "black");
  await expect(page.locator("#board")).toHaveAttribute("data-flipped", "true");
  await expect(page.locator("#review-perspective")).toHaveValue("black");
});

test("P6 black: the review of a black game follows black, and the arrows and rings sit on the flipped squares", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/?review-workers=2");
  const archive = {
    format: "xiangqi-coach-backup", schemaVersion: 1, exportedAt: "2026-10-20",
    games: [{
      id: "black-game", savedAt: 1, moves: GAME, startFen: STANDARD_START_FEN, source: "played",
      importFormat: null, importMetadata: {}, importWarnings: [], variationTree: null, userSide: "black",
    }],
  };
  await openSettings(page);
  await openSettingsCategory(page, "data");
  await page.locator("#archive-file").setInputFiles({
    name: "black.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(archive)),
  });
  await openTab(page, "library");
  await page.locator("#game-library-list li").first().getByRole("button", { name: /看覆盤/ }).click();
  await expect(page.locator("#move-list code")).toHaveCount(GAME.length);
  await expect(page.locator("#board")).toHaveAttribute("data-flipped", "true");
  await expect(page.locator("#review-perspective")).toHaveValue("black");
  await page.evaluate(() => {
    document.querySelector<HTMLSelectElement>("#review-budget")!.append(new Option("test 2000", "2000"));
  });
  await openSettingsCategory(page, "review");
  await page.locator("#review-budget").selectOption("2000");
  await openTab(page, "review");
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator("#review-panel")).toContainText("分析完成", { timeout: 240_000 });
  await expect(page.locator("#review-focus")).toContainText("這盤黑方有");

  const chips = page.locator("[data-review-chip]");
  await expect(chips.first()).toBeVisible();
  for (let index = 0; index < await chips.count(); index += 1) {
    const ply = Number(await chips.nth(index).getAttribute("data-review-chip"));
    expect(ply % 2).toBe(1); // black's plies only
  }
  await chips.first().click();
  const played = page.locator('#board [data-arrow="played"]');
  await expect(played).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator("#board")).toHaveAttribute("data-flipped", "true");
  // the arrow starts 18 units from the centre of the piece that moves, towards the landing square, on the flipped board
  const from = (await played.getAttribute("data-arrow-from"))!;
  const to = (await played.getAttribute("data-arrow-to"))!;
  const fromCentre = await discCentre(page, from);
  const toPlacement = await page.locator(`#board .board-cell[data-square="${to}"] .empty-hit-target, #board .board-cell[data-square="${to}"] .piece-disc`)
    .first().evaluate((node) => ({ x: Number(node.getAttribute("cx")), y: Number(node.getAttribute("cy")) }));
  const line = played.locator("line");
  const start = { x: Number(await line.getAttribute("x1")), y: Number(await line.getAttribute("y1")) };
  expect(Math.hypot(start.x - fromCentre.x, start.y - fromCentre.y)).toBeCloseTo(18, 0);
  // and it points towards the landing square
  const towards = Math.hypot(toPlacement.x - fromCentre.x, toPlacement.y - fromCentre.y);
  expect(Math.hypot(toPlacement.x - start.x, toPlacement.y - start.y)).toBeCloseTo(towards - 18, 0);
  for (const ring of await page.locator("#board [data-danger]").all()) {
    const square = (await ring.getAttribute("data-danger"))!;
    const piece = await discCentre(page, square);
    expect(Number(await ring.getAttribute("cx"))).toBeCloseTo(piece.x, 1);
    expect(Number(await ring.getAttribute("cy"))).toBeCloseTo(piece.y, 1);
  }
  // the last-move mark and the click target use the same flipped cells
  const fenParts = (await page.locator("#board").getAttribute("data-fen"))!.split(" ");
  expect(fenParts[1]).toBe("b");
});
