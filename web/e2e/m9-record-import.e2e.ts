import { expect, test, type Page } from "@playwright/test";
import { openTab } from "./helpers/nav";
import { enableDevMode, openSettingsCategory, waitForImportJump } from "./helpers/nav";

async function deferImportResponses(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const pending: Array<{ id: number; deliver: () => void }> = [];
    (window as typeof window & {
      __m9PendingImports?: () => number[];
      __m9ReleaseImport?: (index: number) => void;
    }).__m9PendingImports = () => pending.map((entry) => entry.id);
    (window as typeof window & {
      __m9ReleaseImport?: (index: number) => void;
    }).__m9ReleaseImport = (index) => pending.splice(index, 1)[0]?.deliver();

    const OriginalWorker = window.Worker;
    window.Worker = new Proxy(OriginalWorker, {
      construct(target, args, newTarget) {
        const worker = Reflect.construct(target, args, newTarget) as Worker;
        if (!String(args[0]).includes("record-import.worker")) return worker;
        const add = worker.addEventListener.bind(worker);
        worker.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
          if (type !== "message" || typeof listener !== "function") {
            add(type, listener, options);
            return;
          }
          add(type, ((event: MessageEvent<{ id: number }>) => {
            pending.push({ id: event.data.id, deliver: () => listener.call(worker, event) });
            window.dispatchEvent(new Event("m9-import-response"));
          }) as EventListener, options);
        }) as typeof worker.addEventListener;
        return worker;
      },
    });
  });
}

async function waitForImport(page: Page, index = 0): Promise<void> {
  await page.waitForFunction((position) => {
    const ids = (window as typeof window & { __m9PendingImports: () => number[] }).__m9PendingImports();
    return ids.length > position;
  }, index);
}

async function releaseImport(page: Page, index = 0): Promise<void> {
  await waitForImport(page, index);
  await page.evaluate((position) => {
    (window as typeof window & { __m9ReleaseImport: (index: number) => void }).__m9ReleaseImport(position);
  }, index);
}

async function deferGameLoadReplies(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const pending: Array<{ id: number; deliver: () => void }> = [];
    const loadIds = new Set<number>();
    let corruptNextLoad = false;
    const testHooks = window as typeof window & {
      __m9PendingLoadReplies?: () => number[];
      __m9ReleaseLoadReply?: (index: number) => void;
      __m9CorruptNextLoad?: () => void;
    };
    testHooks.__m9PendingLoadReplies = () => pending.map((entry) => entry.id);
    testHooks.__m9ReleaseLoadReply = (index) => pending.splice(index, 1)[0]?.deliver();
    testHooks.__m9CorruptNextLoad = () => { corruptNextLoad = true; };

    const OriginalWorker = window.Worker;
    window.Worker = new Proxy(OriginalWorker, {
      construct(target, args, newTarget) {
        const worker = Reflect.construct(target, args, newTarget) as Worker;
        if (!String(args[0]).includes("game.worker")) return worker;
        const originalPostMessage = worker.postMessage.bind(worker);
        worker.postMessage = ((message: { id: number; type: string; moves?: string[] }, transfer?: Transferable[]) => {
          if (message.type === "load-review") {
            loadIds.add(message.id);
            if (corruptNextLoad) {
              corruptNextLoad = false;
              message = { ...message, moves: ["zzzz"] };
            }
          }
          originalPostMessage(message, transfer ?? []);
        }) as typeof worker.postMessage;
        const add = worker.addEventListener.bind(worker);
        worker.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
          if (type !== "message" || typeof listener !== "function") {
            add(type, listener, options);
            return;
          }
          add(type, ((event: MessageEvent<{ id: number; ok?: boolean }>) => {
            if (!loadIds.has(event.data.id) || typeof event.data.ok !== "boolean") {
              listener.call(worker, event);
              return;
            }
            loadIds.delete(event.data.id);
            pending.push({ id: event.data.id, deliver: () => listener.call(worker, event) });
            window.dispatchEvent(new Event("m9-game-load-response"));
          }) as EventListener, options);
        }) as typeof worker.addEventListener;
        return worker;
      },
    });
  });
}

async function releaseGameLoad(page: Page, index = 0): Promise<void> {
  await page.waitForFunction((position) => {
    const ids = (window as typeof window & { __m9PendingLoadReplies: () => number[] }).__m9PendingLoadReplies();
    return ids.length > position;
  }, index);
  await page.evaluate((position) => {
    (window as typeof window & { __m9ReleaseLoadReply: (index: number) => void }).__m9ReleaseLoadReply(position);
  }, index);
}

test("a PGN FEN import keeps its root through save, reload, and deep mate review", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await openTab(page, "review");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill([
    '[Red "匯入紅方"]',
    '[Black "匯入黑方"]',
    '[FEN "2R6/9/5k3/9/r8/2C6/9/6R2/9/2C1K4 w - - 0 1"]',
    "1. c0d0 *",
  ].join("\n"));
  await page.getByRole("button", { name: "辨識並載入" }).click();

  const expectedFen = "2R6/9/5k3/9/r8/2C6/9/6R2/9/3CK4 b - - 1 1";
  await expect(page.locator("#board")).toHaveAttribute("data-fen", expectedFen);
  await waitForImportJump(page);
  await openSettingsCategory(page, "data");
  await expect(page.getByRole("status", { name: "匯入狀態" })).toContainText("PGN");
  await expect(page.getByRole("status", { name: "匯入狀態" })).toContainText("非標準起局");
  await expect(page.locator("#move-list code")).toHaveText("c0d0");
  await expect(page.locator("#turn-status")).toHaveText("輪到黑方");

  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list button")).toHaveCount(1);
  await page.reload();
  await page.locator("#game-library-list button").first().click();
  await expect(page.locator("#board")).toHaveAttribute("data-fen", expectedFen);
  await openSettingsCategory(page, "review");
  await page.locator("#review-budget").selectOption("100000");
  await openTab(page, "review");
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator("[data-review-point]")).toHaveCount(1, { timeout: 30_000 });
  await openSettingsCategory(page, "review");
  await page.locator("#review-budget").selectOption("1000000");
  await enableDevMode(page);
  await openTab(page, "review");
  await page.getByRole("button", { name: "想更久" }).click();
  await expect(page.locator("#review-panel")).toContainText("對方可以在 3 步內將死你", { timeout: 150_000 });
  await expect(page.locator("#review-panel")).toHaveAttribute("data-continuation-complete", "true");
});

test("an illegal imported suffix leaves the active game and library untouched", async ({ page }) => {
  await page.goto("/");
  await openTab(page, "review");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill("h2e2 h9g7");
  await page.getByRole("button", { name: "辨識並載入" }).click();
  // the board is locked while the import applies; play only after both imported moves are in the record
  await expect(page.locator("#move-list code")).toHaveCount(2);
  await openTab(page, "play");
  await page.locator('[data-square="h0"]').click();
  await page.locator('[data-square="g2"]').click();
  await expect(page.locator("#move-list code")).toHaveCount(4, { timeout: 5_000 });
  const beforeFen = await page.locator("#board").getAttribute("data-fen");

  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill("h2e2 zzzz");
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await expect(page.getByRole("status", { name: "匯入狀態" })).toContainText("第 2 手");
  await expect(page.getByRole("button", { name: "採用前段合法棋譜" })).toBeVisible();
  await expect(page.locator("#board")).toHaveAttribute("data-fen", beforeFen!);
  await expect(page.locator("#game-library-list button")).toHaveCount(0);
  await page.getByRole("button", { name: "採用前段合法棋譜" }).click();
  await expect(page.locator("#move-list code")).toHaveCount(1);
  await waitForImportJump(page);
  await expect(page.locator("#move-list code")).toHaveText("h2e2");
  await expect(page.locator("#board")).toHaveAttribute("data-fen", "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C2C4/9/RNBAKABNR b - - 1 1");
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list button")).toHaveCount(1);
  const beforeInvalidRoot = await page.locator("#board").getAttribute("data-fen");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill('[FEN "not-a-fen"]\n1. h2e2 *');
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await expect(page.getByRole("status", { name: "匯入狀態" })).toContainText("起始局面無效");
  await expect(page.locator("#board")).toHaveAttribute("data-fen", beforeInvalidRoot!);
  await expect(page.locator("#game-library-list button")).toHaveCount(1);
});

test("variation snapshots stay attached to the same custom root across reloads", async ({ page }) => {
  await page.goto("/");
  await enableDevMode(page);
  await openTab(page, "review");
  await openSettingsCategory(page, "data");
  const startFen = "2R6/9/5k3/9/r8/2C6/9/6R2/9/2C1K4 w - - 0 1";
  await page.getByLabel("貼上棋譜").fill(`[FEN "${startFen}"]\n1. c0d0 *`);
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await expect(page.locator("#move-list code")).toHaveText("c0d0");
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await openTab(page, "review");
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator('#variation-tree [data-variation-node="main-0"]')).toBeVisible({ timeout: 30_000 });

  await page.locator('#variation-tree [data-variation-node="main-0"]').click();
  await expect(page.locator("#board")).toHaveAttribute("data-fen", startFen);
  await page.locator('[data-square="c0"]').click();
  await page.locator('[data-square="c1"]').click();
  await expect(page.locator('#variation-tree [data-variation-node="branch-1"]')).toBeVisible({ timeout: 30_000 });
  const branchFen = await expectedFenAfter(page, startFen, ["c0c1"]);
  await page.locator('#variation-tree [data-variation-node="branch-1"]').click();
  await expect(page.locator("#board")).toHaveAttribute("data-fen", branchFen);
  await page.getByLabel("分支註解").fill("自訂起局分支");
  await page.getByRole("button", { name: "儲存註解" }).click();
  await expect.poll(async () => page.evaluate(async () => {
    const request = indexedDB.open("xiangqi-coach-local", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("games", "readonly");
    const games = await new Promise<Array<{ variationTree?: { nodes?: Array<{ annotation?: string }> } }>>((resolve, reject) => {
      const getAll = transaction.objectStore("games").getAll();
      getAll.onsuccess = () => resolve(getAll.result);
      getAll.onerror = () => reject(getAll.error);
    });
    database.close();
    return games.some((game) => game.variationTree?.nodes?.some((node) => node.annotation === "自訂起局分支"));
  })).toBe(true);
  await page.reload();

  await openTab(page, "library");
  await page.locator("#game-library-list button").first().click();
  await expect(page.locator("#board")).toHaveAttribute("data-fen", "2R6/9/5k3/9/r8/2C6/9/6R2/9/3CK4 b - - 1 1");
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator('#variation-tree [data-variation-node="branch-1"]')).toBeVisible({ timeout: 30_000 });
  await page.locator('#variation-tree [data-variation-node="branch-1"]').click();
  await expect(page.locator("#board")).toHaveAttribute("data-fen", branchFen);
  await expect(page.locator("#variation-tree")).toContainText("自訂起局分支");
});

test("old IndexedDB records without a root still load from standard start", async ({ page }) => {
  await page.goto("/");
  await openTab(page, "review");
  await page.evaluate(async () => {
    const request = indexedDB.open("xiangqi-coach-local", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("games", "readwrite");
    transaction.objectStore("games").put({ id: "legacy-standard", savedAt: Date.now() + 1, moves: ["h2e2"], variationTree: null });
    transaction.objectStore("games").put({ id: "bad-root", savedAt: Date.now() + 2, moves: ["h2e2"], startFen: null, variationTree: null });
    transaction.objectStore("games").put({ id: "invalid-fen", savedAt: Date.now() + 3, moves: ["h2e2"], startFen: "not-a-fen", variationTree: null });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  });
  await page.reload();
  await expect(page.locator("#game-library-list button")).toHaveCount(2);
  await openTab(page, "play");
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list code")).toHaveCount(2, { timeout: 5_000 });
  const beforeInvalidSavedRoot = await page.locator("#board").getAttribute("data-fen");
  await openTab(page, "library");
  await page.locator("#game-library-list button").first().click();
  await expect(page.locator("#board")).toHaveAttribute("data-fen", beforeInvalidSavedRoot!);
  await expect(page.locator("#move-list code")).toHaveCount(2);
  await openTab(page, "library");
  await page.locator("#game-library-list button").nth(1).click();
  await expect(page.locator("#board")).toHaveAttribute("data-fen", "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C2C4/9/RNBAKABNR b - - 1 1");
});

test("the existing Dongping golden and variation warning appear in the import UI", async ({ page }) => {
  await page.goto("/");
  await openTab(page, "review");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill(
    "[DhtmlXQ_movelist]774770627967807089791022[/DhtmlXQ_movelist]\n[DhtmlXQ_move_1_2_3]0000[/DhtmlXQ_move_1_2_3]",
  );
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await expect(page.locator("#move-list code")).toHaveCount(6);
  await waitForImportJump(page);
  await openSettingsCategory(page, "data");
  await expect(page.getByRole("status", { name: "匯入狀態" })).toContainText("東萍格式，6 步");
  await expect(page.getByRole("status", { name: "匯入狀態" })).toContainText("含有變著");
  await expect(page.locator("#move-list code")).toHaveCount(6);
  await expect(page.locator("#move-list code").first()).toHaveText("h2e2");
});

test("a delayed import cannot replace a game opened from the library", async ({ page }) => {
  await deferImportResponses(page);
  await page.goto("/");
  await openTab(page, "review");
  await openTab(page, "play");
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方", { timeout: 10_000 });
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list button")).toHaveCount(1);
  const libraryFen = await page.locator("#board").getAttribute("data-fen");
  const libraryMoveCount = await page.locator("#move-list code").count();

  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill("h7e7");
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await waitForImport(page);
  await openTab(page, "library");
  await page.locator("#game-library-list button").first().click();
  await expect(page.locator("#board")).toHaveAttribute("data-fen", libraryFen!);
  await releaseImport(page);
  await expect(page.locator("#board")).toHaveAttribute("data-fen", libraryFen!);
  await expect(page.locator("#move-list code")).toHaveCount(libraryMoveCount);
});

test("a delayed import cannot replace a restarted game", async ({ page }) => {
  await deferImportResponses(page);
  await page.goto("/");
  await openTab(page, "review");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill("h7e7");
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await waitForImport(page);
  await openTab(page, "play");
  await page.getByRole("button", { name: "重新開始" }).click();
  await expect(page.locator("#move-list code")).toHaveCount(0);
  await expect.poll(() => page.locator("#board").getAttribute("data-fen")).not.toBeNull();
  const restartedFen = await page.locator("#board").getAttribute("data-fen");
  await releaseImport(page);
  await expect(page.locator("#move-list code")).toHaveCount(0);
  await expect(page.locator("#board")).toHaveAttribute("data-fen", restartedFen!);
});

test("when import replies arrive out of order only the latest request updates the game", async ({ page }) => {
  await deferImportResponses(page);
  await page.goto("/");
  await openTab(page, "review");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill("h2e2");
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await waitForImport(page);
  await page.getByLabel("貼上棋譜").fill("zzzz");
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await waitForImport(page, 1);
  await releaseImport(page, 1);
  await expect(page.getByRole("status", { name: "匯入狀態" })).toContainText("「zzzz」");
  const latestStatus = await page.getByRole("status", { name: "匯入狀態" }).textContent();
  await releaseImport(page);
  await expect(page.getByRole("status", { name: "匯入狀態" })).toHaveText(latestStatus!);
  await expect(page.locator("#move-list code")).toHaveCount(0);
});

test("editing the input invalidates a delayed partial import and its adopt action", async ({ page }) => {
  await deferImportResponses(page);
  await page.goto("/");
  await openTab(page, "review");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill("h2e2 zzzz");
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await waitForImport(page);
  await page.getByLabel("貼上棋譜").fill("h7e7");
  await releaseImport(page);
  await expect(page.getByRole("button", { name: "採用前段合法棋譜" })).toBeHidden();
  await expect(page.getByRole("status", { name: "匯入狀態" })).toHaveText("");
  await expect(page.locator("#move-list code")).toHaveCount(0);
});

test("adopting a legal prefix reports that it loaded and preserves the parse error", async ({ page }) => {
  await page.goto("/");
  await openTab(page, "review");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill("h2e2 zzzz");
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await expect(page.getByRole("button", { name: "採用前段合法棋譜" })).toBeVisible();
  await page.getByRole("button", { name: "採用前段合法棋譜" }).click();
  await waitForImportJump(page);
  await openSettingsCategory(page, "data");
  await expect(page.getByRole("status", { name: "匯入狀態" })).toContainText("已載入前 1 手");
  await expect(page.getByRole("status", { name: "匯入狀態" })).toContainText("第 2 手");
  await expect(page.getByRole("button", { name: "採用前段合法棋譜" })).toBeHidden();
});

test("the import commit phase locks conflicting controls until the worker accepts the new game", async ({ page }) => {
  await deferGameLoadReplies(page);
  await page.goto("/");
  await openTab(page, "review");
  await openTab(page, "play");
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方", { timeout: 10_000 });
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list button")).toHaveCount(1);
  const oldFen = await page.locator("#board").getAttribute("data-fen");
  const importedStartFen = "2R6/9/5k3/9/r8/2C6/9/6R2/9/2C1K4 w - - 0 1";
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill(`[FEN "${importedStartFen}"]\n1. c0d0 *`);
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await page.waitForFunction(() => (window as typeof window & { __m9PendingLoadReplies: () => number[] }).__m9PendingLoadReplies().length > 0);

  await expect(page.getByRole("status", { name: "匯入狀態" })).toHaveText("正在載入棋局…");
  await expect(page.getByLabel("貼上棋譜")).toBeDisabled();
  await expect(page.getByRole("button", { name: "辨識並載入" })).toBeDisabled();
  await openTab(page, "play");
  await expect(page.getByRole("button", { name: "重新開始" })).toBeDisabled();
  await openTab(page, "library");
  await expect(page.locator("#game-library-list button").first()).toBeDisabled();
  await expect(page.locator("#board")).toHaveAttribute("aria-disabled", "true");
  await openTab(page, "review");
  await expect(page.getByRole("button", { name: "開始覆盤" })).toBeDisabled();

  await page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>("#record-import-text")!;
    textarea.value = "h7e7";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    for (const selector of ["#restart", "#start-review", "#game-library-list button", "#record-import-submit"]) {
      document.querySelector<HTMLElement>(selector)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });
  await openSettingsCategory(page, "data");
  await expect(page.getByRole("status", { name: "匯入狀態" })).toHaveText("正在載入棋局…");
  await expect(page.locator("#board")).toHaveAttribute("data-fen", oldFen!);
  await releaseGameLoad(page);
  await expect(page.locator("#board")).toHaveAttribute("data-fen", "2R6/9/5k3/9/r8/2C6/9/6R2/9/3CK4 b - - 1 1");
  await expect(page.locator("#move-list code")).toHaveText("c0d0");
  await openSettingsCategory(page, "data");
  await expect(page.getByLabel("貼上棋譜")).toBeEnabled();
  await openTab(page, "play");
  await expect(page.getByRole("button", { name: "重新開始" })).toBeEnabled();
});

test("a rejected worker import unlocks controls and keeps the previous game intact", async ({ page }) => {
  await deferGameLoadReplies(page);
  await page.goto("/");
  await openTab(page, "review");
  await openSettingsCategory(page, "data");
  await expect(page.locator("#board")).toHaveAttribute("data-fen", /.+/);
  const oldFen = await page.locator("#board").getAttribute("data-fen");
  await page.evaluate(() => (window as typeof window & { __m9CorruptNextLoad: () => void }).__m9CorruptNextLoad());
  await page.getByLabel("貼上棋譜").fill("h2e2");
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await page.waitForFunction(() => (window as typeof window & { __m9PendingLoadReplies: () => number[] }).__m9PendingLoadReplies().length > 0);
  await expect(page.getByLabel("貼上棋譜")).toBeDisabled();
  await releaseGameLoad(page);
  await expect(page.locator("#board")).toHaveAttribute("data-fen", oldFen!);
  await expect(page.locator("#move-list code")).toHaveCount(0);
  await expect(page.getByRole("status", { name: "匯入狀態" })).toContainText("這一步不合法");
  await expect(page.getByLabel("貼上棋譜")).toBeEnabled();
  await openTab(page, "play");
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list code")).toHaveCount(2, { timeout: 10_000 });
});

async function expectedFenAfter(page: Page, startFen: string, moves: string[]): Promise<string> {
  return page.evaluate(async ({ fen, path }) => {
    const module = await import("/wasm/xq_wasm.js") as {
      default: () => Promise<void>;
      WebGame: { from_fen(startFen: string): { play(move: string): boolean; fen(): string } };
    };
    await module.default();
    const game = module.WebGame.from_fen(fen);
    for (const move of path) if (!game.play(move)) throw new Error(`illegal expected branch move ${move}`);
    return game.fen();
  }, { fen: startFen, path: moves });
}
