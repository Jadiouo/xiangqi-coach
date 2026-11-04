import type { Page } from "@playwright/test";

export type AppRoute = "play" | "review" | "library" | "settings";

/** Switches the app to a screen by hash, keeping the query string and the page state. */
export async function openTab(page: Page, route: AppRoute): Promise<void> {
  await page.evaluate((hash) => { window.location.hash = hash; }, `#/${route}`);
  await page.locator(`.app-shell[data-route="${route}"]`).waitFor();
}

export async function openSettings(page: Page): Promise<void> {
  await openTab(page, "settings");
}

/** Turns developer mode on (settings, "advanced" category) and goes back to the play screen. */
export async function enableDevMode(page: Page): Promise<void> {
  await openSettingsCategory(page, "advanced");
  await page.locator("#dev-mode-toggle").check();
  await openTab(page, "play");
}

export type SettingsCategory = "play" | "review" | "level" | "data" | "advanced";

/** Opens settings and picks one of its five categories (the right side shows only the chosen one). */
export async function openSettingsCategory(page: Page, category: SettingsCategory): Promise<void> {
  await openSettings(page);
  await page.locator(`[data-settings-category="${category}"]`).click();
  await page.locator(`[data-settings-panel="${category}"]`).waitFor();
}

/** A record pasted in settings takes the player to the review page once it is loaded; wait for that before navigating on. */
export async function waitForImportJump(page: Page): Promise<void> {
  await page.locator('.app-shell[data-route="review"]').waitFor();
}
