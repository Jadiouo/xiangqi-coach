import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type BuildCommand = "build" | "serve";

/** Files whose content decides a review's results, relative to the web/ directory. */
export const REVIEW_HASHED_FILES = ["public/wasm/xq_wasm_bg.wasm", "public/wasm/xq_wasm.js", "src/review.worker.ts"];

/**
 * Hash of what decides a review's results; it goes into the analysis cache version, so a rebuilt
 * engine can never be served an older engine's cached results.
 *
 * - build: every file must exist, otherwise throw (a build without the engine must not ship a hash
 *   that would collide with a later, real engine).
 * - serve (dev): a missing file does not stop the server, but contributes the current time, so the
 *   hash is never a fixed string that two different engines could share.
 */
export function computeReviewBuildHash(
  root: string,
  files: readonly string[],
  command: BuildCommand,
  now: () => number = Date.now,
): string {
  const hash = createHash("sha256");
  for (const file of files) {
    const path = join(root, file);
    if (existsSync(path)) {
      hash.update(readFileSync(path));
    } else if (command === "build") {
      throw new Error(
        `Review cache hash: ${file} is missing, so the build would not know which engine it ships. ` +
          "Run `npm run wasm:build` first.",
      );
    } else {
      hash.update(`dev-missing:${file}:${now()}`);
    }
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

