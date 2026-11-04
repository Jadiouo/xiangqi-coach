import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SerializedReviewVariationTree } from "./../review-variation-tree";

const node = (id: string, parentId: string | null, children: string[], move: string | null = "a0a1") => ({ id, parentId, move, children, annotation: "" });
const root = node("main-0", null, [], null);

/** Every cycle below passes the "links agree" and "parent exists" checks; only the walk up to the root never ends. */
export const cycleTrees: Record<string, SerializedReviewVariationTree> = {
  "two nodes pointing at each other": {
    version: 1, selectedNodeId: "main-0",
    nodes: [root, node("loop-a", "loop-b", ["loop-b"]), node("loop-b", "loop-a", ["loop-a"])],
  },
  "a node that is its own parent": {
    version: 1, selectedNodeId: "main-0",
    nodes: [root, node("loop-s", "loop-s", ["loop-s"])],
  },
  "a cycle that is also named by turnStarts": {
    version: 1, selectedNodeId: "main-0",
    nodes: [root, node("loop-a", "loop-b", ["loop-b"]), node("loop-b", "loop-a", ["loop-a"])],
    turnStarts: { "loop-a": "main-0", "loop-b": "loop-a" },
  },
};

/**
 * Parses `tree` in a separate node process so a non-terminating parse costs a timeout instead of freezing the test run.
 * Returns "rejected:<message>" when parse throws, "accepted" when it returns, "timeout" when it never ends.
 */
export function parseInChildProcess(tree: unknown, millis = 10_000): string {
  const modulePath = fileURLToPath(new URL("./../review-variation-tree.ts", import.meta.url));
  const script = `
    const { parseReviewVariationTree } = await import(${JSON.stringify(modulePath)});
    try { const t = parseReviewVariationTree(process.argv[1]); for (const n of JSON.parse(process.argv[1]).nodes) t.pathTo(n.id); console.log("accepted"); }
    catch (e) { console.log("rejected:" + e.name + ":" + e.message); }
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script, JSON.stringify(tree)],
    { timeout: millis, killSignal: "SIGKILL", encoding: "utf8" });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") return "timeout";
  if (result.status !== 0) return `child failed: ${result.stderr}`;
  return result.stdout.trim();
}
