import { expect, test, type Download } from "@playwright/test";
import { openTab } from "./helpers/nav";
import { openSettingsCategory, waitForImportJump } from "./helpers/nav";

async function downloadText(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("download stream is unavailable");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

test("a completed real review produces, copies, downloads, and restores a complete note", async ({ page, context }) => {
  test.setTimeout(240_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await openTab(page, "review");
  await openSettingsCategory(page, "data");
  await page.getByLabel("貼上棋譜").fill([
    '[Red "紅方 <script>alert(1)</script> & \\"棋手\\""]',
    '[Black "黑方 & <svg onload=alert(1)>"]',
    '[FEN "2R6/9/5k3/9/r8/2C6/9/6R2/9/2C1K4 w - - 0 1"]',
    "1. c0d0 *",
  ].join("\n"));
  await page.getByRole("button", { name: "辨識並載入" }).click();
  await expect(page.locator("#move-list code")).toHaveText("c0d0");
  await waitForImportJump(page);
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list button")).toHaveCount(1);
  await openSettingsCategory(page, "review");
  await page.locator("#review-budget").selectOption("100000");
  await openTab(page, "review");
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator("#review-panel")).toContainText("分析完成", { timeout: 150_000 });

  await page.getByRole("button", { name: "產生覆盤筆記" }).click();
  await expect(page.locator("#review-note-preview")).toBeVisible();
  const markdownDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "下載 Markdown" }).click();
  const markdown = await downloadText(await markdownDownload);
  for (const section of ["對局資訊", "勝率曲線", "對局摘要", "關鍵時刻", "推演分支", "毛病統計", "下次注意", "完整棋譜"]) {
    expect(markdown).toContain("## " + section);
  }
  expect(markdown).toContain("內建引擎");
  expect(markdown).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(markdown).toContain("&quot;棋手");
  expect(markdown).toContain("&amp; &lt;svg onload=alert(1)&gt;");
  expect(await page.locator("#review-note-preview script").count()).toBe(0);
  expect(markdown).toContain("對方可以在 3 步內將死你");
  expect(markdown).toContain("[FEN \"2R6/9/5k3/9/r8/2C6/9/6R2/9/2C1K4 w - - 0 1\"]");

  const pgn = markdown.match(/\x60{3}pgn\n([\s\S]*?)\n\x60{3}/)?.[1];
  expect(pgn).toBeTruthy();
  const replay = await page.evaluate(async (record) => {
    const module = await import("/wasm/xq_wasm.js") as {
      default: () => Promise<void>;
      import_record(text: string): string;
    };
    await module.default();
    return JSON.parse(module.import_record(record));
  }, pgn!);
  expect(replay.startFen).toBe("2R6/9/5k3/9/r8/2C6/9/6R2/9/2C1K4 w - - 0 1");
  expect(replay.moves).toEqual(["c0d0"]);
  expect(replay.errors).toEqual([]);

  await page.getByRole("button", { name: "複製純文字" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("勝率曲線圖");
  expect(copied).not.toContain("<svg");

  // 需求變更（使用者同意）：「下載 SVG 圖」換成「存成 PDF」，見 docs/DECISIONS.md。
  await expect(page.getByRole("button", { name: "下載 SVG 圖" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "存成 PDF" })).toBeVisible();

  await page.reload();
  await openTab(page, "library");
  await page.locator("#game-library-list button").first().click();
  await expect(page.getByRole("button", { name: "下載 Markdown" })).toBeVisible();
  const restoredDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "下載 Markdown" }).click();
  expect(await downloadText(await restoredDownload)).toBe(markdown);
});
