// Usage: node tools/p3/measure.mjs <base-url> <sample.json> <budget> <out.json> [workers=4] [maxMinutes=45]
// Reviews the same game twice in one browser context (so both pages share IndexedDB) through the real
// UI and times click -> "分析完成" for each. The first run computes (and fills the cache), the second
// should be served from the cache. Also records review workers started and the cached-ply count.
import { chromium } from "../../web/node_modules/@playwright/test/index.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";

const [base, sample, budget, out, workers = "4", maxMin = "45"] = process.argv.slice(2);
const moves = JSON.parse(readFileSync(sample, "utf8")).moves;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

async function review(label) {
  const page = await context.newPage();
  let reviewWorkers = 0;
  page.on("worker", (worker) => { if (worker.url().includes("review.worker")) reviewWorkers += 1; });
  await page.goto(`${base}${base.includes("?") ? "&" : "?"}review-workers=${workers}`);
  await page.locator("#record-import-text").fill(moves.join(" "));
  await page.locator("#record-import-submit").click();
  await page.waitForFunction((n) => document.querySelectorAll("#move-list code").length === n, moves.length, { timeout: 30000 });
  await page.locator("#review-budget").selectOption(budget);
  const load = loadavg().map((x) => +x.toFixed(2));
  const t0 = Date.now();
  await page.locator("#start-review").click();
  const deadline = t0 + Number(maxMin) * 60000;
  let finished = false;
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => document.querySelector("#review-panel [role=status]")?.textContent ?? "");
    if (s === "分析完成") { finished = true; break; }
    await page.waitForTimeout(250);
  }
  const sec = +((Date.now() - t0) / 1000).toFixed(2);
  const cachedPlies = await page.evaluate(() => document.getElementById("review-panel")?.dataset.reviewCachedPlies ?? "");
  await page.close();
  const result = { label, finished, sec, cachedPlies, reviewWorkersStarted: reviewWorkers, loadAvgAtStart: load, loadAvgAtEnd: loadavg().map((x) => +x.toFixed(2)) };
  console.log(JSON.stringify(result));
  return result;
}

const first = await review("first");
const second = await review("second");
// How big is a stored ply? (sum of the JSON length of every stored point, in a fresh page of the same origin)
const probe = await context.newPage();
await probe.goto(base);
const storage = await probe.evaluate(() => new Promise((resolve) => {
  const open = indexedDB.open("xiangqi-coach-review-cache");
  open.onsuccess = () => {
    const request = open.result.transaction("points").objectStore("points").getAll();
    request.onsuccess = () => {
      const rows = request.result;
      const bytes = rows.reduce((sum, row) => sum + JSON.stringify(row).length, 0);
      resolve({ entries: rows.length, jsonChars: bytes, avgJsonChars: rows.length ? Math.round(bytes / rows.length) : 0 });
    };
  };
  open.onerror = () => resolve(null);
}));
await probe.close();
const result = { storage, chrome: browser.version(), sample, plies: moves.length, budget: Number(budget), workers: Number(workers), first, second };
writeFileSync(out, JSON.stringify(result, null, 1));
await browser.close();
