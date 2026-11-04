import { expect, test } from "@playwright/test";
import { openSettings } from "./helpers/nav";
import { openSettingsCategory } from "./helpers/nav";

// SPEC 8.5 / TEST_PLAN 6.4.3 and 6.4.5 through the real page and the real wasm level policy.
test("the level is the unlabeled default until estimated, a manual choice sticks across reloads, and re-estimating clears it", async ({ page }) => {
  await page.goto("/");
  await openSettings(page);
  await openSettingsCategory(page, "level");
  const status = page.locator("#user-level-status");
  await expect(status).toHaveAttribute("data-level", "beginner");
  await expect(status).toHaveAttribute("data-displayed", "false");
  await expect(status).toHaveAttribute("data-game-count", "0");
  await expect(status).toContainText("至少覆盤 3 盤");

  await page.locator("#user-level").selectOption("expert");
  await expect(status).toHaveAttribute("data-level", "expert");
  await expect(status).toHaveAttribute("data-manual", "true");
  await expect(status).toContainText("手動指定");

  await page.reload();
  await openSettingsCategory(page, "level");
  await expect(page.locator("#user-level-status")).toHaveAttribute("data-level", "expert");
  await expect(page.locator("#user-level")).toHaveValue("expert");

  await page.locator("#user-level-reestimate").click();
  await expect(page.locator("#user-level-status")).toHaveAttribute("data-manual", "false");
  await expect(page.locator("#user-level-status")).toHaveAttribute("data-level", "beginner");
});
