// TEST_PLAN §8 item 9: "離線（中斷網路）後重新整理，還能開、還能下。"
// Production build only (E2E_PREVIEW=1): the dev server does not register a service worker.
import { expect, test } from "@playwright/test";

test("after one online visit, going offline and reloading still opens the app and lets me play", async ({ page, context }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1, name: "象棋教練" })).toBeVisible();
  // wait until the service worker is active and controlling this page (precache finished)
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    }
  });

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "象棋教練" })).toBeVisible();
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");

  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list li")).toHaveCount(2, { timeout: 5_000 });
  await expect(page.locator("#move-list")).toContainText("炮二平五");
  await expect(page.locator("#turn-status")).toHaveText("輪到紅方");

  // a brand-new tab opened while offline works too
  const second = await context.newPage();
  await second.goto("./");
  await expect(second.getByRole("heading", { level: 1, name: "象棋教練" })).toBeVisible();
  await expect(second.locator("#turn-status")).toHaveText("輪到紅方");
});

test("the manifest is served and installable", async ({ page, request }) => {
  await page.goto("./");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBeTruthy();
  const res = await request.get(new URL(href!, page.url()).href);
  expect(res.ok()).toBe(true);
  const manifest = await res.json();
  expect(manifest.name).toBe("象棋教練");
  expect(manifest.display).toBe("standalone");
});

// Added at the main integration: M8/M9 added review.worker and record-import.worker after M11 was written.
// The precache list is generated from the build output, so it must list every worker chunk and the wasm,
// and those files must be served offline (review and import need them).
test("the precache covers every worker chunk and the wasm, and they are served offline", async ({ page, context }) => {
  await page.goto("./");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    }
  });
  const swText = await page.evaluate(async () => (await fetch("sw.js")).text());
  const urls = [...swText.matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]);
  const need = [/\/assets\/game\.worker-[^/]+\.js$/, /\/assets\/review\.worker-[^/]+\.js$/, /\/assets\/record-import\.worker-[^/]+\.js$/, /\/wasm\/xq_wasm\.js$/, /\/wasm\/xq_wasm_bg\.wasm$/];
  const required = need.map((re) => urls.find((u) => re.test(u)));
  need.forEach((re, i) => expect(required[i], `precache lists ${re}`).toBeTruthy());

  await context.setOffline(true);
  const statuses = await page.evaluate(async (list) => Promise.all(list.map(async (u) => (await fetch(u)).status)), required as string[]);
  expect(statuses).toEqual(required.map(() => 200));
});
