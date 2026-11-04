import { expect, test, type Page } from "@playwright/test";
import { enableDevMode, openSettingsCategory, openTab, waitForImportJump } from "./helpers/nav";

// Playtest 2026-10-21, batch B (four additions). Each test was red before its feature.

const GAME = ["a3a4", "h7h5", "a4a5", "h5h4", "a5a6", "b7b5", "a6b6", "f9e8"];

async function setDifficulty(page: Page, level: string): Promise<void> {
  await openSettingsCategory(page, "play");
  await page.locator("#difficulty-level").selectOption(level);
  await openTab(page, "play");
}

async function movePiece(page: Page, from: string, to: string): Promise<void> {
  await page.locator(`[data-square="${from}"]`).click();
  await page.locator(`[data-square="${to}"]`).click();
}

const rowCount = (page: Page) => page.locator("#move-list .move-row").count();
const boardFen = async (page: Page) => (await page.locator("#board").getAttribute("data-fen"))!;

async function loadRecord(page: Page, text: string): Promise<void> {
  await openTab(page, "review");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill(text);
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await waitForImportJump(page);
}

async function readStore(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("xiangqi-coach-local", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const all = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const request = db.transaction("games", "readonly").objectStore("games").getAll();
      request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return all;
  });
}

// ---- 1. a refresh does not lose the game in progress ----

test("item 1: a refresh brings back the same position, turn, difficulty and side, and play goes on", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await setDifficulty(page, "3");
  await movePiece(page, "h2", "e2");
  await expect.poll(() => rowCount(page), { timeout: 30_000 }).toBe(2);
  const fen = await boardFen(page);
  const turn = await page.locator("#turn-status").innerText();
  const notation = await page.locator("#move-list .move-row strong").allInnerTexts();

  await page.reload();
  await expect.poll(() => rowCount(page), { timeout: 15_000 }).toBe(2);
  expect(await boardFen(page)).toBe(fen);
  expect(await page.locator("#turn-status").innerText()).toBe(turn);
  expect(await page.locator("#move-list .move-row strong").allInnerTexts()).toEqual(notation);
  await expect(page.locator("#difficulty-level")).toHaveValue("3");
  await expect(page.locator("#board")).toHaveAttribute("data-user-side", "red");

  await movePiece(page, "b0", "c2");
  await expect.poll(() => rowCount(page), { timeout: 30_000 }).toBe(4);
});

test("item 1: a game played as black comes back as black, flipped, with the computer's opening kept", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await setDifficulty(page, "1");
  await openSettingsCategory(page, "play");
  await page.locator("#user-side").selectOption("black");
  await openTab(page, "play");
  await expect.poll(() => rowCount(page), { timeout: 30_000 }).toBe(1);
  const first = await page.locator("#move-list .move-row strong").first().innerText();
  await movePiece(page, "h7", "e7");
  await expect.poll(() => rowCount(page), { timeout: 30_000 }).toBe(3);
  const fen = await boardFen(page);

  await page.reload();
  await expect.poll(() => rowCount(page), { timeout: 15_000 }).toBe(3);
  expect(await boardFen(page)).toBe(fen);
  expect(await page.locator("#move-list .move-row strong").first().innerText()).toBe(first);
  await expect(page.locator("#board")).toHaveAttribute("data-user-side", "black");
  await expect(page.locator("#board")).toHaveAttribute("data-flipped", "true");
  await expect(page.locator("#turn-status")).toHaveText("輪到黑方");
  await movePiece(page, "b7", "c7");
  await expect.poll(() => rowCount(page), { timeout: 30_000 }).toBe(5);
});

test("item 1: a refresh while the computer is thinking asks the computer again and does not hang", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?test-long-search=1");
  await setDifficulty(page, "10"); // low levels cap their own nodes and answer instantly
  await movePiece(page, "h2", "e2");
  await expect(page.locator("#game-message")).toContainText("電腦思考中", { timeout: 5_000 });
  expect(await rowCount(page)).toBe(1);

  await page.goto("/");
  await expect.poll(() => rowCount(page), { timeout: 30_000 }).toBe(2);
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  await expect(page.locator("#game-message")).not.toContainText("電腦思考中");
  await movePiece(page, "b0", "c2");
  await expect.poll(() => rowCount(page), { timeout: 30_000 }).toBe(4);
});

test("item 1: storage that refuses reads and writes leaves the game working", async ({ page }) => {
  await page.addInitScript(() => {
    const refuse = () => { throw new DOMException("denied", "SecurityError"); };
    Storage.prototype.getItem = refuse;
    Storage.prototype.setItem = refuse;
    Storage.prototype.removeItem = refuse;
  });
  await page.goto("/");
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  await movePiece(page, "h2", "e2");
  await expect.poll(() => rowCount(page), { timeout: 30_000 }).toBe(2);
  await expect(page.locator("#game-message")).not.toContainText("中斷");
});

test("item 1: an unreadable or impossible stored game is ignored and a new game starts", async ({ page }) => {
  for (const stored of ["{not json", JSON.stringify({ version: 1, game: {
    startFen: "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1",
    moves: ["a0a9", "b0b9"], userSide: "red", difficulty: 2, source: "played",
    importFormat: null, importMetadata: {}, importWarnings: [], assisted: false, libraryRecordId: null,
  } })]) {
    await page.addInitScript((value) => {
      if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("xq.game-in-progress.v1", value); }
    }, stored);
    await page.goto("/");
    await expect(page.locator("#turn-status")).toHaveText("輪到紅方", { timeout: 15_000 });
    expect(await rowCount(page)).toBe(0);
    await expect(page.locator("#game-message")).toHaveText("");
    await movePiece(page, "h2", "e2");
    await expect.poll(() => rowCount(page), { timeout: 30_000 }).toBe(2);
    await page.evaluate(() => { sessionStorage.removeItem("seeded"); localStorage.clear(); });
  }
});

test("item 1: after a refresh the saved game is still the same game, so saving again does not add a copy", async ({ page }) => {
  await page.goto("/");
  await loadRecord(page, "h2e2 h9g7");
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list button")).toHaveCount(1);

  await page.reload();
  await expect.poll(() => rowCount(page), { timeout: 15_000 }).toBe(2);
  await openTab(page, "library");
  await expect(page.locator("#game-library-list button")).toHaveCount(1);
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-status")).toHaveText("棋局已儲存");
  await expect(page.locator("#game-library-list button")).toHaveCount(1);
  expect(await readStore(page)).toHaveLength(1);
});

// ---- 2. no ICCS in normal mode; undo says why it is off ----

test("item 2: the move list hides coordinates in normal mode and shows them in developer mode", async ({ page }) => {
  await page.goto("/");
  await setDifficulty(page, "1");
  await movePiece(page, "h2", "e2");
  await expect.poll(() => rowCount(page), { timeout: 30_000 }).toBe(2);
  await expect(page.locator("#move-list code").first()).toBeHidden();
  await expect(page.locator("#move-list code").first()).toHaveText("h2e2"); // still in the page for developer mode
  expect(await page.locator("#move-list").innerText()).not.toMatch(/\b[a-i][0-9][a-i][0-9]\b/);
  await enableDevMode(page);
  await expect(page.locator("#move-list code").first()).toBeVisible();
});

test("item 2: a grey undo button says why, in words a phone can show", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/?test-long-search=1");
  await setDifficulty(page, "10"); // low levels cap their own nodes and answer instantly
  const undo = page.locator("#undo");
  const reason = page.locator("#undo-reason");
  await expect(undo).toBeDisabled();
  await expect(reason).toHaveText("還沒有可悔的步");
  await expect(reason).toBeVisible();
  await expect(undo).toHaveAttribute("aria-describedby", "undo-reason");
  await expect(undo).toHaveAttribute("title", "還沒有可悔的步");

  await movePiece(page, "h2", "e2");
  await expect(page.locator("#game-message")).toContainText("電腦思考中", { timeout: 5_000 });
  await expect(undo).toBeDisabled();
  await expect(reason).toHaveText("電腦思考中");
  await expect(undo).toHaveAttribute("title", "電腦思考中");
});

test("item 2: with undo available there is no reason text", async ({ page }) => {
  await page.goto("/");
  await setDifficulty(page, "1");
  await movePiece(page, "h2", "e2");
  await expect.poll(() => rowCount(page), { timeout: 30_000 }).toBe(2);
  await expect(page.locator("#undo")).toBeEnabled();
  await expect(page.locator("#undo-reason")).toBeHidden();
  await expect(page.locator("#undo")).not.toHaveAttribute("title", /.+/);
});

// ---- 3. library rows: result, side, difficulty, moves; delete with a page-level confirmation ----

async function seedLibrary(page: Page, records: Array<Record<string, unknown>>, path = "/"): Promise<void> {
  await page.goto(path);
  await openTab(page, "library");
  await expect(page.locator("#game-library-list")).toBeVisible();
  await page.evaluate(async (rows) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("xiangqi-coach-local", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("games", "readwrite");
      for (const row of rows) tx.objectStore("games").put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, records);
  await page.reload();
  await openTab(page, "library");
}

const STANDARD = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";
const record = (id: string, savedAt: number, extra: Record<string, unknown>) => ({
  id, savedAt, moves: ["h2e2", "h9g7", "b0c2"], startFen: STANDARD, source: "played",
  importFormat: null, importMetadata: {}, importWarnings: [], variationTree: null, ...extra,
});

test("item 3: every row shows result, side, difficulty and move count; an older save shows a dash", async ({ page }) => {
  await seedLibrary(page, [
    record("new", 3000, { userSide: "black", difficulty: 7, outcome: "black_win" }),
    record("old", 2000, {}),
    record("imp", 1000, { source: "imported", outcome: "red_win" }),
  ]);
  const rows = page.locator("#game-library-list li");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("你贏");
  await expect(rows.nth(0)).toContainText("執黑");
  await expect(rows.nth(0)).toContainText("難度 7");
  await expect(rows.nth(0)).toContainText("3 手");
  await expect(rows.nth(1)).toContainText("執紅");
  await expect(rows.nth(1)).toContainText("難度 —");
  await expect(rows.nth(1)).toContainText("3 手");
  await expect(rows.nth(2)).toContainText("紅方勝");
  await expect(rows.nth(2)).not.toContainText("難度");
});

test("item 3: a newly saved game keeps its difficulty, side and outcome", async ({ page }) => {
  await page.goto("/");
  await setDifficulty(page, "4");
  await movePiece(page, "h2", "e2");
  await expect.poll(() => rowCount(page), { timeout: 30_000 }).toBe(2);
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list li")).toContainText("難度 4");
  await expect(page.locator("#game-library-list li")).toContainText("執紅");
  await expect(page.locator("#game-library-list li")).toContainText("未結束");
  const [saved] = await readStore(page);
  expect(saved).toMatchObject({ difficulty: 4, userSide: "red", outcome: "ongoing" });
});

test("item 3: delete asks first on the page itself, cancel keeps the game, confirm removes it", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await seedLibrary(page, [record("a", 3000, { difficulty: 2 }), record("b", 2000, { difficulty: 9 })]);
  const rows = page.locator("#game-library-list li");
  await expect(rows).toHaveCount(2);

  await rows.nth(0).getByRole("button", { name: /刪除/ }).click();
  const confirm = page.locator("#library-delete-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("確定要刪除");
  await confirm.getByRole("button", { name: "先不要" }).click();
  await expect(confirm).toBeHidden();
  await expect(rows).toHaveCount(2);
  expect(await readStore(page)).toHaveLength(2);

  await rows.nth(0).getByRole("button", { name: /刪除/ }).click();
  await page.locator("#library-delete-confirm").getByRole("button", { name: "確定刪除" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("難度 9");
  await expect(page.locator("#game-library-status")).toContainText("已刪除");
  expect((await readStore(page)).map((row) => row.id)).toEqual(["b"]);
  await page.reload();
  await openTab(page, "library");
  await expect(page.locator("#game-library-list li")).toHaveCount(1);
  expect(dialogs, "window.confirm must not be used").toEqual([]);
});

// ---- 4. review time: remaining-time estimate and a warning before a long review ----

async function loadGame(page: Page): Promise<void> {
  // the estimate's seconds-per-ply is injected (1000 s), so the test never depends on how fast this machine is
  await page.goto("/?review-workers=1&review-seconds-per-ply=1000&review-cache=off");
  await loadRecord(page, GAME.join(" "));
  await expect(page.locator("#move-list code")).toHaveCount(GAME.length);
}

test("item 4: a long review is announced first, with the choice to go on or use a quicker budget", async ({ page }) => {
  test.setTimeout(120_000);
  await loadGame(page);
  await openSettingsCategory(page, "review");
  await page.locator("#review-budget").selectOption("1000000");
  await openTab(page, "review");
  await page.locator("#start-review").click();
  const warning = page.locator("#review-warning");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(`${GAME.length} 手`);
  await expect(warning).toContainText("預估");
  await expect(page.locator("#review-panel")).toBeHidden(); // nothing started yet

  await warning.getByRole("button", { name: "改用較快的預算" }).click();
  await expect(warning).toBeHidden();
  await expect(page.locator("#review-budget")).toHaveValue("100000");
  await expect(page.locator("#review-panel")).toBeVisible();
  await expect(page.locator("#review-eta")).toContainText("估算中");
  await page.getByRole("button", { name: "取消" }).click();
  // the quicker budget was for this review only: the saved setting is still the one the user chose
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("xq.settings.v1") ?? "{}").reviewBudget);
  expect(saved).toBe(1_000_000);
});

test("item 4: choosing to go on starts the review at the budget that was warned about", async ({ page }) => {
  test.setTimeout(120_000);
  await loadGame(page);
  await openSettingsCategory(page, "review");
  await page.locator("#review-budget").selectOption("1000000");
  await openTab(page, "review");
  await page.locator("#start-review").click();
  await page.locator("#review-warning").getByRole("button", { name: "照樣開始" }).click();
  await expect(page.locator("#review-warning")).toBeHidden();
  await expect(page.locator("#review-panel")).toBeVisible();
  await expect(page.locator("#review-budget")).toHaveValue("1000000");
  await expect(page.locator("#review-eta")).toContainText("估算中");
  await page.getByRole("button", { name: "取消" }).click();
});

test("item 4: a short review starts at once, without a warning", async ({ page }) => {
  test.setTimeout(120_000);
  await loadGame(page);
  await page.goto("/?review-workers=1&review-seconds-per-ply=1&review-cache=off");
  await loadRecord(page, GAME.join(" "));
  await openTab(page, "review");
  await page.locator("#start-review").click();
  await expect(page.locator("#review-warning")).toBeHidden();
  await expect(page.locator("#review-panel")).toBeVisible(); // started at once
  await page.getByRole("button", { name: "取消" }).click();
});


test("item 4: plies already in the review cache are left out of the estimate", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/?review-workers=1&review-seconds-per-ply=5000");
  await loadRecord(page, "h2e2 h9g7");
  await page.evaluate(() => { document.querySelector<HTMLSelectElement>("#review-budget")!.append(new Option("test 2000", "2000")); });
  await openSettingsCategory(page, "review");
  await page.locator("#review-budget").selectOption("2000");
  await openTab(page, "review");
  await page.locator("#start-review").click();
  await page.locator("#review-warning").getByRole("button", { name: "照樣開始" }).click(); // 2 plies x ~1300 s at this budget: warned
  await expect(page.locator("#review-panel")).toContainText("分析完成", { timeout: 200_000 });
  await page.locator("#review-panel").getByRole("button", { name: "重新分析" }).click();
  await expect(page.locator("#review-warning")).toBeHidden(); // everything is cached: nothing left to wait for
  await expect(page.locator("#review-panel")).toContainText("已從先前的分析載入 2 步");
});

// ---- review round 1 ----

test("M1: a refresh while the computer thinks does not tie the new position to the saved game it grew from", async ({ page }) => {
  test.setTimeout(120_000);
  await seedLibrary(page, [record("x", 3000, { userSide: "red", difficulty: 1, outcome: "ongoing", moves: ["h2e2", "h9g7"] })], "/?test-long-search=1");
  await page.locator("#game-library-list li").first().locator("button.library-row").click();
  await setDifficulty(page, "10");
  await movePiece(page, "b0", "c2");
  await expect(page.locator("#game-message")).toContainText("電腦思考中", { timeout: 5_000 });

  await page.goto("/");
  await expect.poll(() => rowCount(page), { timeout: 30_000 }).toBe(4);
  await openTab(page, "library");
  await expect(page.locator("#game-library-list li")).toHaveCount(1);
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list li")).toHaveCount(2); // a new entry, not an overwrite
  const x = (await readStore(page)).find((row) => row.id === "x")!;
  expect(x.moves).toEqual(["h2e2", "h9g7"]);
});

test("M2: deleting the game the board is bound to also drops the binding kept for a refresh", async ({ page }) => {
  await page.goto("/");
  await loadRecord(page, "h2e2 h9g7");
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list li")).toHaveCount(1);
  const bound = () => page.evaluate(() => JSON.parse(localStorage.getItem("xq.game-in-progress.v1") ?? "{}").game?.libraryRecordId ?? null);
  expect(await bound()).not.toBeNull();
  await page.locator("#game-library-list li").first().getByRole("button", { name: /刪除/ }).click();
  await page.locator("#library-delete-confirm").getByRole("button", { name: "確定刪除" }).click();
  await expect(page.locator("#game-library-list li.library-item")).toHaveCount(0);
  expect(await bound()).toBeNull();
});

test("M3: delete works from the keyboard alone and focus always lands somewhere sensible", async ({ page }) => {
  await seedLibrary(page, [record("a", 3000, { difficulty: 2 }), record("b", 2000, { difficulty: 9 })]);
  const rows = page.locator("#game-library-list li.library-item");
  const active = () => page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    return element ? `${element.tagName}|${element.textContent?.trim()}|${element.getAttribute("aria-label") ?? ""}` : "none";
  });
  await rows.nth(0).locator("button.library-row").focus();
  await page.keyboard.press("Tab"); // the 刪除 control of the first row
  expect(await active()).toContain("刪除第 1 局");
  await page.keyboard.press("Enter");
  const confirm = page.locator("#library-delete-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toHaveAttribute("role", "alertdialog");
  const labelledBy = await confirm.getAttribute("aria-labelledby");
  expect(labelledBy).toBeTruthy();
  await expect(page.locator(`#${labelledBy}`)).toContainText("確定要刪除");
  expect(await active()).toContain("先不要"); // the safe choice has focus

  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  expect(await active()).toContain("刪除第 1 局");
  await expect(rows).toHaveCount(2);

  await page.keyboard.press("Enter");
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Shift+Tab"); // 確定刪除
  expect(await active()).toContain("確定刪除");
  await page.keyboard.press("Enter");
  await expect(rows).toHaveCount(1);
  expect(await active()).toContain("第 1 局"); // the next row's game button
  expect((await readStore(page)).map((row) => row.id)).toEqual(["b"]);

  // the last row: nothing follows or precedes it, so focus goes to the list's heading
  await rows.first().getByRole("button", { name: /刪除/ }).click();
  await page.locator("#library-delete-confirm").getByRole("button", { name: "確定刪除" }).click();
  await expect(rows).toHaveCount(0);
  expect(await active()).toContain("棋局庫");
});

test("M1: a stored game whose position no longer matches the saved game it names is not tied to it", async ({ page }) => {
  // e.g. the page went away between the player's move and the computer's reply: the stored position has moved on
  await seedLibrary(page, [record("x", 3000, { userSide: "red", difficulty: 1, outcome: "ongoing", moves: ["h2e2", "h9g7"] })]);
  await page.evaluate((fen) => {
    localStorage.setItem("xq.game-in-progress.v1", JSON.stringify({ version: 1, game: {
      startFen: fen, moves: ["h2e2", "h9g7", "b0c2", "h7h6"], userSide: "red", difficulty: 1, source: "played",
      importFormat: null, importMetadata: {}, importWarnings: [], assisted: false, libraryRecordId: "x",
    } }));
  }, STANDARD);
  await page.reload();
  await expect.poll(() => rowCount(page), { timeout: 15_000 }).toBe(4);
  await openTab(page, "library");
  await expect(page.locator("#game-library-list li.library-item")).toHaveCount(1);
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list li.library-item")).toHaveCount(2);
  const x = (await readStore(page)).find((row) => row.id === "x")!;
  expect(x.moves).toEqual(["h2e2", "h9g7"]);
});

// 棋譜庫刪除鈕是 span role=button：按空白鍵時，確認列要保持打開、焦點在「先不要」，
// keyup 落在「先不要」上也不能把它取消或按下去。
test("pressing Space on the delete control opens the confirmation and it stays open on the safe choice", async ({ page }) => {
  await seedLibrary(page, [record("a", 3000, { difficulty: 2 }), record("b", 2000, { difficulty: 9 })]);
  const rows = page.locator("#game-library-list li.library-item");
  await rows.nth(0).locator("button.library-row").focus();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "")).toContain("刪除第 1 局");
  await page.keyboard.down("Space");
  await page.keyboard.up("Space");
  const confirm = page.locator("#library-delete-confirm");
  await expect(confirm).toBeVisible();
  // let any late key or click event settle before looking again
  await page.waitForTimeout(300);
  await expect(confirm).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("先不要");
  await expect(rows).toHaveCount(2);
  expect((await readStore(page)).map((row) => row.id)).toEqual(["a", "b"]);
});

// the two rules of the keyup change: a key that is only held down opens nothing, and a release that did not start on the control opens nothing
test("Space on the delete control opens the confirmation on release, not on press", async ({ page }) => {
  await seedLibrary(page, [record("a", 3000, { difficulty: 2 }), record("b", 2000, { difficulty: 9 })]);
  await page.locator("#game-library-list li.library-item").nth(0).locator("button.library-row").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.down("Space");
  await page.waitForTimeout(200);
  await expect(page.locator("#library-delete-confirm")).toHaveCount(0);
  await page.keyboard.up("Space");
  await expect(page.locator("#library-delete-confirm")).toBeVisible();
});

test("a Space release on the delete control whose press was elsewhere does not open the confirmation", async ({ page }) => {
  await seedLibrary(page, [record("a", 3000, { difficulty: 2 }), record("b", 2000, { difficulty: 9 })]);
  const row = page.locator("#game-library-list li.library-item").nth(0);
  await row.locator("button.library-row").focus();
  await page.keyboard.down("Space"); // pressed on the game button (its click fires on release only if the release is there too)
  await page.keyboard.press("Tab"); // focus moves to the delete control while Space is still held
  await page.keyboard.up("Space");
  await page.waitForTimeout(300);
  await expect(page.locator("#library-delete-confirm")).toHaveCount(0);
});
