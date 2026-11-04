import { expect, test } from "@playwright/test";
import { openTab } from "./helpers/nav";
import { openSettingsCategory } from "./helpers/nav";

test("the review area says external strong engines are command-line only", async ({ page }) => {
  await page.goto("/");
  await openTab(page, "review");
  await openSettingsCategory(page, "advanced");
  const notice = page.locator("#review-engine-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("內建引擎");
  await expect(notice).toContainText("外接強引擎");
  await expect(notice).toContainText("命令列");
  await expect(notice).toContainText("scripts/review-with-engine.sh");
});
