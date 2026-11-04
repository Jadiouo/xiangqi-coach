import { expect, test } from "@playwright/test";

const labels = { play: "下棋", review: "覆盤", library: "棋譜庫" } as const;

test("P6 shell: nav, gear and hash routing", async ({ page }) => {
  await page.goto("/?review-workers=1");
  const nav = page.getByRole("navigation", { name: "主要畫面" });
  await expect(nav.getByRole("button")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "設定" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "象棋教練" })).toBeVisible();
  await expect(page.locator("#board")).toHaveCount(1);

  // empty hash means play
  await expect(nav.getByRole("button", { name: labels.play })).toHaveAttribute("aria-pressed", "true");
  await expect(nav.getByRole("button", { name: labels.review })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-route]").first()).toHaveAttribute("data-route", "play");

  await nav.getByRole("button", { name: labels.library }).click();
  expect(new URL(page.url()).hash).toBe("#/library");
  await expect(nav.getByRole("button", { name: labels.library })).toHaveAttribute("aria-pressed", "true");
  await expect(nav.getByRole("button", { name: labels.play })).toHaveAttribute("aria-pressed", "false");
  await expect(nav.getByRole("button", { name: labels.library })).toHaveAttribute("aria-current", "page");
  await expect(page.locator("[data-route]").first()).toHaveAttribute("data-route", "library");

  await page.reload();
  expect(new URL(page.url()).search).toBe("?review-workers=1");
  expect(new URL(page.url()).hash).toBe("#/library");
  await expect(nav.getByRole("button", { name: labels.library })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#board")).toHaveCount(1);

  await nav.getByRole("button", { name: labels.review }).click();
  expect(new URL(page.url()).hash).toBe("#/review");
  await expect(nav.getByRole("button", { name: labels.review })).toHaveAttribute("aria-pressed", "true");

  // the gear is a route, not a tab
  await page.getByRole("button", { name: "設定" }).click();
  expect(new URL(page.url()).hash).toBe("#/settings");
  await expect(page.locator("[data-route]").first()).toHaveAttribute("data-route", "settings");
  await expect(nav.getByRole("button", { name: labels.review })).toHaveAttribute("aria-pressed", "false");

  // back button / manual hash change follows too
  await page.evaluate(() => { location.hash = "#/play"; });
  await expect(nav.getByRole("button", { name: labels.play })).toHaveAttribute("aria-pressed", "true");

  // unknown hash falls back to play
  await page.evaluate(() => { location.hash = "#/whatever"; });
  await expect(page.locator("[data-route]").first()).toHaveAttribute("data-route", "play");
  await expect(page.locator("#board")).toHaveCount(1);
});

test("P6 shell: nav sits at the bottom on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主要畫面" });
  await expect(nav).toBeVisible();
  const box = await nav.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThan(844 / 2);
  // gear stays in the top bar
  const gear = await page.getByRole("button", { name: "設定" }).boundingBox();
  expect(gear!.y).toBeLessThan(844 / 2);
});

test("P6 shell: nav is in the top bar on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const box = await page.getByRole("navigation", { name: "主要畫面" }).boundingBox();
  expect(box!.y).toBeLessThan(120);
});
