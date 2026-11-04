import { expect, test, type Page } from "@playwright/test";
import { openTab } from "./helpers/nav";

const startFen = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";
const board = "rnbakabnr" + "........." + ".c.....c." + "p.p.p.p.p" + "........." + "........." + "P.P.P.P.P" + ".C.....C." + "........." + "RNBAKABNR";
const candidate = {
  move: "h2e2", score: { centipawns: 20, mateIn: null }, pv: ["h2e2"], depth: 1, nodes: 100,
  pvEnd: "depth_limit", continuation: [], continuationNodeLimit: 100_000, continuationTerminal: false,
  replayAudit: { failedIndex: null }, continuationStatus: "minimum_reached",
};
const result = {
  bestMove: "h2e2", playedMove: "h2e2", playedRank: 1, bestScore: { centipawns: 20, mateIn: null },
  playedScore: { centipawns: 20, mateIn: null }, bestWinProbability: 0.5, playedWinProbability: 0.5,
  lossPercent: 0, classification: "good", candidates: [candidate],
};
const reviewSnapshot = {
  startFen, moves: ["h2e2"], points: [{ quick: result, final: result, deepened: false, continuationComplete: true }],
  boards: [board, board], analyzer: { name: "內建引擎", quickNodeLimit: 100_000, deepNodeLimit: 1_000_000, config: "SearchConfig::default()" },
  result: "unknown", reportDate: "2026-10-09",
};

function game(id: string, savedAt: number, red: string, annotation?: string) {
  const variationTree = annotation ? {
    version: 1, startFen, selectedNodeId: "main-1",
    nodes: [
      { id: "main-0", parentId: null, move: null, children: ["main-1"], annotation: "" },
      { id: "main-1", parentId: "main-0", move: "h2e2", children: ["branch-1"], annotation: "" },
      { id: "branch-1", parentId: "main-1", move: "h9g7", children: [], annotation },
    ],
  } : null;
  return {
    id, savedAt, moves: ["h2e2"], startFen, source: "imported", importFormat: "pgn",
    importMetadata: { Red: red, Black: "對方" }, importWarnings: [], variationTree,
    reviewSnapshot, reviewNote: null,
  };
}

async function seedGames(page: Page, rows: unknown[]): Promise<void> {
  await page.goto("/");
  await page.evaluate(async (values) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("xiangqi-coach-local", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("games", "readwrite");
      for (const value of values) transaction.objectStore("games").put(value);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, rows);
  await page.reload();
  await openTab(page, "library");
  await openTab(page, "review");
  await openTab(page, "library");
}

test("same root and moves keep metadata, notes, and annotations with the opened record", async ({ page }) => {
  await seedGames(page, [game("record-a", 1, "甲方"), game("record-b", 2, '乙方 <script>& "棋手"', '乙方註解 <svg onload="alert(1)">')]);
  await expect(page.locator("#game-library-list button")).toHaveCount(2);

  await page.locator("#game-library-list button").nth(1).click();
  await page.getByRole("button", { name: "產生覆盤筆記" }).click();
  const firstRecordNote = await page.locator("#review-note-preview").textContent();
  expect(firstRecordNote).toContain("甲方");
  expect(firstRecordNote).not.toContain("乙方註解");

  await openTab(page, "library");
  await page.locator("#game-library-list button").nth(0).click();
  await page.getByRole("button", { name: "產生覆盤筆記" }).click();
  const secondRecordNote = await page.locator("#review-note-preview").textContent();
  expect(secondRecordNote).toContain("乙方 &lt;script&gt;&amp;");
  expect(secondRecordNote).toContain("乙方註解 &lt;svg onload=&quot;alert(1)&quot;&gt;");
  expect(secondRecordNote).not.toContain("甲方");

  await page.reload();
  await openTab(page, "library");
  await page.locator("#game-library-list button").nth(1).click();
  const redownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "下載 Markdown" }).click();
  const download = await redownload;
  const stream = await download.createReadStream();
  if (!stream) throw new Error("download stream is unavailable");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString("utf8")).toBe(firstRecordNote);
});

test("corrupt analysis and SVG data do not discard or crash an otherwise valid IndexedDB game", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const invalid = game("corrupt-review", 10, "棋手");
  invalid.reviewSnapshot.points = [null];
  invalid.reviewNote = { reportDate: "2026-10-09", markdown: "<script>", plainText: "", curveSvg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' };
  await seedGames(page, [invalid]);
  await expect(page.locator("#game-library-list button")).toHaveCount(1);
  await page.locator("#game-library-list button").click();
  await expect(page.locator("#move-list code")).toHaveText("h2e2");
  expect(pageErrors).toEqual([]);
});
