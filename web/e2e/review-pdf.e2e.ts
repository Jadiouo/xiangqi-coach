import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openTab, openSettingsCategory, waitForImportJump } from "./helpers/nav";

// Same real eight-ply game and review flow as p6-review.e2e.ts (red's plies 3, 5, 7 are marked at 2,000 nodes).
const GAME = ["a3a4", "h7h5", "a4a5", "h5h4", "a5a6", "b7b5", "a6b6", "f9e8"];

test("a completed review offers 存成 PDF instead of the SVG download, and printing hands over a player-facing page", async ({ page, browser }) => {
  test.setTimeout(300_000);
  // A real print dialog cannot be driven: every window (the hidden print frame included) records its page instead.
  await page.addInitScript(() => {
    (window as unknown as { __printed: string[] }).__printed = [];
    window.print = () => {
      const top = window.top as unknown as { __printed: string[] };
      top.__printed.push(document.documentElement.outerHTML);
    };
  });
  await page.goto("/?review-workers=2");
  await openTab(page, "review");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill(GAME.join(" "));
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await expect(page.locator("#move-list code")).toHaveCount(GAME.length);
  await waitForImportJump(page);
  await page.evaluate(() => {
    document.querySelector<HTMLSelectElement>("#review-budget")!.append(new Option("test 2000", "2000"));
  });
  await openSettingsCategory(page, "review");
  await page.locator("#review-budget").selectOption("2000");
  await openTab(page, "review");
  await expect(page.getByRole("button", { name: "存成 PDF" })).toHaveCount(0);
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator("#review-panel")).toContainText("分析完成", { timeout: 240_000 });

  await expect(page.getByRole("button", { name: "存成 PDF" })).toBeVisible();
  await expect(page.getByRole("button", { name: "下載 SVG 圖" })).toHaveCount(0);
  await page.getByRole("button", { name: "產生覆盤筆記" }).click();
  await expect(page.locator("#review-note-preview")).toBeVisible();
  await expect(page.getByRole("button", { name: "下載 SVG 圖" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "下載 Markdown" })).toBeVisible();
  await expect(page.getByRole("button", { name: "複製純文字" })).toBeVisible();

  // the key moves the page lists (chips, 0-based plies) are the same plies the PDF lists (1-based)
  const pageKeys = (await page.locator("[data-review-chip]").evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute("data-review-chip")) + 1))).sort((a, b) => a - b);
  expect(pageKeys.length).toBeGreaterThan(0);

  await page.getByRole("button", { name: "存成 PDF" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printed: string[] }).__printed.length)).toBe(1);
  const printed = await page.evaluate(() => (window as unknown as { __printed: string[] }).__printed[0]!);
  for (const heading of ["關鍵步", "每一步走法", "哪裡要改進"]) expect(printed).toContain(heading);
  expect(printed).toContain('data-print-section="curve"');
  expect(printed).toContain("data-key-move=");
  expect([...printed.matchAll(/data-key-move="(\d+)"/g)].map((m) => Number(m[1])).sort((a, b) => a - b)).toEqual(pageKeys);
  expect((printed.match(/data-ply-cell=/g) ?? []).length).toBe(GAME.length);
  expect(printed).not.toMatch(/\b[a-i][0-9][a-i][0-9]\b/);
  expect(printed).not.toMatch(/節點|深度|搜尋設定/);

  // A real A4 PDF of that exact page, for looking at the layout (only when asked for; never committed).
  const out = process.env.REVIEW_PDF_OUT;
  if (out) {
    const context = await browser.newContext();
    const printPage = await context.newPage();
    await printPage.setContent(printed);
    await printPage.emulateMedia({ media: "print" });
    writeFileSync(out, await printPage.pdf({ preferCSSPageSize: true, printBackground: true }));
    await context.close();
  }
});

test("the PDF is about the side the game was played from, not the review page's perspective menu", async ({ page }) => {
  test.setTimeout(300_000);
  await page.addInitScript(() => {
    (window as unknown as { __printed: string[] }).__printed = [];
    window.print = () => {
      (window.top as unknown as { __printed: string[] }).__printed.push(document.documentElement.outerHTML);
    };
  });
  await page.goto("/?review-workers=2");
  const archive = {
    format: "xiangqi-coach-backup", schemaVersion: 1, exportedAt: "2026-10-20",
    games: [{
      id: "black-game", savedAt: 1, moves: GAME, startFen: "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1", source: "played",
      importFormat: null, importMetadata: {}, importWarnings: [], variationTree: null, userSide: "black",
    }],
  };
  await openTab(page, "settings");
  await openSettingsCategory(page, "data");
  await page.locator("#archive-file").setInputFiles({ name: "black.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(archive)) });
  await openTab(page, "library");
  await page.locator("#game-library-list li").first().getByRole("button", { name: /看覆盤/ }).click();
  await expect(page.locator("#move-list code")).toHaveCount(GAME.length);
  await page.evaluate(() => {
    document.querySelector<HTMLSelectElement>("#review-budget")!.append(new Option("test 2000", "2000"));
  });
  await openSettingsCategory(page, "review");
  await page.locator("#review-budget").selectOption("2000");
  await openTab(page, "review");
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator("#review-panel")).toContainText("分析完成", { timeout: 240_000 });

  // look at the review from red's side; the report must still be black's
  await openSettingsCategory(page, "review");
  await page.locator("#review-perspective").selectOption("red");
  await openTab(page, "review");
  await page.getByRole("button", { name: "存成 PDF" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printed: string[] }).__printed.length)).toBe(1);
  const printed = await page.evaluate(() => (window as unknown as { __printed: string[] }).__printed[0]!);
  expect(printed).toContain("你執：黑方");
  const keys = [...printed.matchAll(/data-key-move="(\d+)"/g)].map((m) => Number(m[1]));
  expect(keys.length).toBeGreaterThan(0);
  for (const ply of keys) expect(ply % 2, `ply ${ply} is black's`).toBe(0);
  expect(printed).toMatch(/<th>黑方（你）<\/th>/);
});
