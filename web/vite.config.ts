import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { pwaPlugin } from "./src/pwa/plugin";
import { REVIEW_HASHED_FILES, computeReviewBuildHash } from "./build/review-build-hash";

// GitHub Pages serves under /xiangqi-coach/; set VITE_BASE_PATH (or pass --base) for that build.
export default defineConfig(({ command }) => ({
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [pwaPlugin()],
  define: {
    __REVIEW_BUILD_HASH__: JSON.stringify(
      computeReviewBuildHash(fileURLToPath(new URL(".", import.meta.url)), REVIEW_HASHED_FILES, command),
    ),
  },
}));
