import { expect, test, type Download, type Page } from "@playwright/test";
import { openSettings } from "./helpers/nav";
import { openSettingsCategory } from "./helpers/nav";

const startFen = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";
const note = { reportDate: "2026-10-09", markdown: "# 覆盤筆記\n\n備份筆記", plainText: "覆盤筆記", curveSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' };
const emptyBoard = "rnbakabnr" + "........." + ".c.....c." + "p.p.p.p.p" + "........." + "........." + "P.P.P.P.P" + ".C.....C." + "........." + "RNBAKABNR";
const noteSnapshot = { startFen, moves: [], points: [], boards: [emptyBoard],
  analyzer: { name: "內建引擎", quickNodeLimit: 1, deepNodeLimit: 2, config: "c" }, result: "unknown", reportDate: "2026-10-09" };

function game(id: string, savedAt: number, red: string, withNote = false) {
  return {
    id, savedAt, moves: withNote ? [] : ["h2e2", "h9g7"], startFen, source: "imported", importFormat: "pgn",
    importMetadata: { Red: red, Black: "對方" }, importWarnings: [], variationTree: null,
    reviewSnapshot: withNote ? noteSnapshot : null, reviewNote: withNote ? note : null,
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
  await openSettings(page);
  await openSettingsCategory(page, "data");
}

async function downloadText(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("download stream is unavailable");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const importFile = (page: Page, content: string) =>
  page.locator("#archive-file").setInputFiles({ name: "backup.json", mimeType: "application/json", buffer: Buffer.from(content) });

test("the whole library exports to a versioned file and imports into an empty library, surviving a reload", async ({ browser }) => {
  const source = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await seedGames(source, [game("a", 2, "甲方", true), game("b", 1, "乙方")]);
  const download = source.waitForEvent("download");
  await source.locator("#archive-export").click();
  const text = await downloadText(await download);
  const archive = JSON.parse(text);
  expect(archive.schemaVersion).toBe(1);
  expect(archive.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(archive.games.map((row: { id: string }) => row.id).sort()).toEqual(["a", "b"]);
  expect(archive.games.find((row: { id: string }) => row.id === "a").reviewNote.markdown).toContain("備份筆記");

  const target = await (await browser.newContext()).newPage();
  await target.goto("/");
  await openSettings(target);
  await openSettingsCategory(target, "data");
  await expect(target.locator("#game-library-list button")).toHaveCount(0);
  await importFile(target, text);
  await expect(target.getByRole("status", { name: "棋局庫狀態" })).toContainText("新增 2 局");
  await expect(target.locator("#game-library-list button")).toHaveCount(2);
  await target.reload();
  await expect(target.locator("#game-library-list button")).toHaveCount(2);
});

test("importing the same backup again adds nothing and says how many were skipped", async ({ page }) => {
  await seedGames(page, [game("a", 2, "甲方"), game("b", 1, "乙方")]);
  await importFile(page, JSON.stringify({ format: "xiangqi-coach-backup", schemaVersion: 1, exportedAt: "2026-10-09", games: [game("a", 2, "甲方"), game("b", 1, "乙方")] }));
  await expect(page.getByRole("status", { name: "棋局庫狀態" })).toContainText("略過相同資料 2 局");
  await expect(page.locator("#game-library-list button")).toHaveCount(2);
});

test("a same-id record with different content is kept alongside the original, not overwritten", async ({ page }) => {
  await seedGames(page, [game("a", 2, "原本")]);
  await importFile(page, JSON.stringify({ format: "xiangqi-coach-backup", schemaVersion: 1, exportedAt: "2026-10-09", games: [game("a", 2, "備份裡的版本")] }));
  await expect(page.locator("#game-library-list button")).toHaveCount(2);
});

for (const [name, content] of [
  ["a newer version", JSON.stringify({ format: "xiangqi-coach-backup", schemaVersion: 999, exportedAt: "2026-10-09", games: [] })],
  ["a file that is not JSON", "這不是 JSON"],
  ["a bare list of games from an older build", JSON.stringify([game("z", 9, "舊版")])],
  ["a valid record followed by an illegal one", JSON.stringify({ format: "xiangqi-coach-backup", schemaVersion: 1, exportedAt: "2026-10-09",
    games: [game("new-ok", 9, "好的"), { ...game("new-bad", 8, "壞的"), moves: ["zz99"] }] })],
] as const) {
  test(`${name} is refused as a whole and leaves the library unchanged`, async ({ page }) => {
    await seedGames(page, [game("a", 2, "原本")]);
    await importFile(page, content);
    await expect(page.getByRole("status", { name: "棋局庫狀態" })).toContainText("棋局庫沒有變更");
    await expect(page.locator("#game-library-list button")).toHaveCount(1);
    await page.reload();
    await expect(page.locator("#game-library-list button")).toHaveCount(1);
  });
}
