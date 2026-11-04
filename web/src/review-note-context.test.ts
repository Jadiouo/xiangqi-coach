import { describe, expect, it } from "vitest";
import { createReviewVariationTree } from "./review-variation-tree";
import { createReviewNoteInput, type ReviewNoteInput } from "./review-note";
import type { SavedGame } from "./game-library";

const root = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";
const moves = ["h2e2", "h9g7", "h2e2"];

function saved(id: string, red: string, annotation: string): SavedGame {
  const tree = createReviewVariationTree(moves, root);
  const branch = tree.append(tree.mainlineNodeId(1), "b9c7");
  tree.annotate(branch, annotation);
  return {
    id, savedAt: 1, moves, startFen: root, source: "imported", importFormat: "pgn",
    importMetadata: { Red: red, Black: "黑方" }, importWarnings: [], variationTree: tree.toJSON(),
  };
}

function artifact(): Omit<ReviewNoteInput, "metadata" | "notations" | "variationTree"> {
  return {
    reportDate: "2026-10-09", result: "unknown", startFen: root, moves,
    points: [], boards: [], analyzer: { name: "內建引擎", quickNodeLimit: 100_000, deepNodeLimit: 1_000_000, config: "SearchConfig::default()" },
  };
}

describe("review note context is bound to the active saved record and ply", () => {
  it("selects the open record by identity and takes repeated-move notation by index", () => {
    const first = saved("first", "甲方 <script>", "甲局註解");
    const second = saved("second", "乙方 & <svg>", "乙局註解");
    const history = moves.map((iccs, index) => ({ iccs, notation: ["炮二平五", "馬8進7", "炮二平五（再走）"][index]! }));
    const context = { savedGames: [second, first], activeSavedGameId: "first", currentMetadata: {}, history, currentTree: first.variationTree };
    const note = createReviewNoteInput(artifact(), context);
    expect(note.metadata.Red).toBe("甲方 <script>");
    expect(note.notations).toEqual(["炮二平五", "馬8進7", "炮二平五（再走）"]);
    expect(note.variationTree?.nodes.find((node) => node.id.startsWith("branch-"))?.annotation).toBe("甲局註解");
  });

  it("rejects a note context whose ordered history does not match its snapshot", () => {
    const game = saved("first", "甲方", "註解");
    expect(() => createReviewNoteInput(artifact(), {
      savedGames: [game], activeSavedGameId: "first", currentMetadata: {},
      history: [{ iccs: "h2e2", notation: "炮二平五" }], currentTree: game.variationTree,
    })).toThrow("review note history does not match the completed analysis");
  });
});
