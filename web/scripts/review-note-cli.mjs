// Usage: node scripts/review-note-cli.mjs <review.json> [--date YYYY-MM-DD] [--out note.md]
// Reads the JSON printed by `xq-uci review` and writes the review note Markdown with the
// same TypeScript generator the web app uses (src/review-note.ts). No second copy of the logic.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const input = args.find((arg, i) => !arg.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
if (!input) {
  console.error("usage: node scripts/review-note-cli.mjs <review.json> [--date YYYY-MM-DD] [--out note.md]");
  process.exit(2);
}
const date = option("--date") ?? new Date().toISOString().slice(0, 10);
const out = option("--out");

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, logLevel: "silent", server: { middlewareMode: true }, appType: "custom" });
try {
  const { reviewNoteInputFromCli } = await vite.ssrLoadModule("/src/review-cli-note.ts");
  const { generateReviewNote } = await vite.ssrLoadModule("/src/review-note.ts");
  const report = JSON.parse(readFileSync(input, "utf8"));
  const { markdown } = generateReviewNote(reviewNoteInputFromCli(report, { reportDate: date }));
  if (out) writeFileSync(out, markdown);
  else process.stdout.write(markdown);
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
} finally {
  await vite.close();
}
