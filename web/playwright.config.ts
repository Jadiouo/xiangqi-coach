import { defineConfig } from "@playwright/test";

const productionPreview = process.env.E2E_PREVIEW === "1";
const port = productionPreview ? 4173 : 5173;
const previewBase = process.env.E2E_BASE_PATH ?? "/xiangqi-coach/";
const origin = `http://127.0.0.1:${port}`;
// E2E_REMOTE_URL (e.g. a Cloudflare Pages preview, root path) runs the production-preview specs against
// that already-deployed site instead of starting a local server.
const remoteURL = process.env.E2E_REMOTE_URL;
const baseURL = remoteURL ?? (productionPreview ? `${origin}${previewBase}` : origin);

export default defineConfig({
  testDir: "./e2e",
  testMatch: productionPreview ? ["**/game-preview.e2e.ts", "**/m11-offline.e2e.ts", "**/subpath-wasm.e2e.ts"] : "**/*.e2e.ts",
  // the dev server registers no service worker, so the offline test only makes sense on the production build
  testIgnore: productionPreview ? undefined : ["**/m11-offline.e2e.ts", "**/subpath-wasm.e2e.ts"],
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL,
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: remoteURL ? undefined : {
    command: productionPreview
      ? `node e2e/serve-subpath.mjs dist ${previewBase} ${port}`
      : "npm run dev -- --host 127.0.0.1",
    url: baseURL,
    reuseExistingServer: productionPreview || !process.env.CI,
    timeout: 60_000,
  },
});
