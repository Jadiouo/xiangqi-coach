import { expect, test } from "@playwright/test";
import { openSettings, openTab } from "./helpers/nav";

test("player move receives a legal AI reply and one undo restores the whole turn", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "象棋教練" })).toBeVisible();
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  const startingFen = await page.locator("#board").getAttribute("data-fen");
  expect(startingFen).toBeTruthy();

  await page.locator('[data-square="h2"]').click();
  const turnStartedAt = Date.now();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list li")).toHaveCount(2, { timeout: 5_000 });
  await expect(page.locator("#move-list")).toContainText("炮二平五");
  expect(Date.now() - turnStartedAt).toBeLessThan(5_000);
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方", { timeout: 1_000 });
  expect(await page.locator("#board").getAttribute("data-fen")).not.toBe(startingFen);
  await expect(page.locator("#board")).not.toHaveAttribute("aria-disabled", "true");

  await page.getByRole("button", { name: "悔棋" }).click();
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  await expect(page.locator("#move-list")).toContainText("尚未走棋");
  expect(await page.locator("#board").getAttribute("data-fen")).toBe(startingFen);
  await expect(page.locator('[data-square="h2"] .piece-label')).toHaveText("炮");
  await expect(page.locator('[data-square="e2"] .piece-label')).toHaveCount(0);
});

// The page also owns import/review workers, so the game worker is picked by URL, not by index.
test("restarting during AI search terminates the old worker and ignores its late reply", async ({ page }) => {
  await page.addInitScript(() => {
    const workers: Array<Worker & { __terminated?: boolean; __lastRequest?: { id?: number }; __url?: string }> = [];
    (window as Window & { __m6Workers?: typeof workers }).__m6Workers = workers;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      __terminated = false;
      __lastRequest?: { id?: number };
      __url = "";
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        const workerUrl = new URL(scriptURL.toString(), window.location.href);
        if (window.location.search.includes("test-long-search=1")) {
          workerUrl.searchParams.set("test-long-search", "1");
        }
        super(workerUrl, options);
        this.__url = workerUrl.pathname;
        workers.push(this);
      }
      postMessage(message: unknown, options?: StructuredSerializeOptions): void {
        if (typeof message === "object" && message !== null && "id" in message) {
          this.__lastRequest = message as { id?: number };
        }
        super.postMessage(message, options);
      }
      terminate(): void {
        this.__terminated = true;
        super.terminate();
      }
    };
  });

  await page.goto("/?test-long-search=1");
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");
  await openSettings(page);
  await page.locator("#difficulty-level").selectOption("10"); // low levels cap their own nodes and answer instantly
  await openTab(page, "play");
  const startingFen = await page.locator("#board").getAttribute("data-fen");
  expect(startingFen).toBeTruthy();
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#game-message")).toContainText("電腦思考中", { timeout: 2_000 });
  await page.getByRole("button", { name: "重新開始" }).click();
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");

  const oldWorker = await page.evaluate(() => {
    const worker = (window as Window & { __m6Workers?: Array<Worker & {
      __terminated?: boolean;
      __lastRequest?: { id?: number };
    }> }).__m6Workers?.find((w) => (w as Worker & { __url?: string }).__url?.includes("game.worker"));
    return worker ? { terminated: worker.__terminated, requestId: worker.__lastRequest?.id } : null;
  });
  expect(oldWorker).not.toBeNull();
  const oldState = { fen: "stale", board: ".".repeat(90), side: "black", legalMoves: [],
    history: [{ ply: 1, side: "red", notation: "炮二平五", iccs: "h2e2" }], lastMove: "h2e2", outcome: "ongoing" };
  await page.evaluate(({ id, state }) => {
    const worker = (window as Window & { __m6Workers?: Array<Worker> }).__m6Workers?.find((w) => (w as Worker & { __url?: string }).__url?.includes("game.worker"));
    worker?.dispatchEvent(new MessageEvent("message", { data: { id, ok: true, state } }));
  }, { id: oldWorker?.requestId ?? -1, state: oldState });

  await expect(page.locator("#board")).toHaveAttribute("data-fen", startingFen!);
  await expect(page.locator("#move-list")).toContainText("尚未走棋");
  const wasTerminated = await page.evaluate(() => Boolean(
    (window as Window & { __m6Workers?: Array<Worker & { __terminated?: boolean }> }).__m6Workers?.find((w) => (w as Worker & { __url?: string }).__url?.includes("game.worker"))?.__terminated,
  ));
  expect(wasTerminated).toBe(true);
  const workerCount = await page.evaluate(() => (window as Window & { __m6Workers?: Worker[] }).__m6Workers?.length ?? 0);
  expect(workerCount).toBeGreaterThanOrEqual(2);
});
