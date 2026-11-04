import { describe, expect, it } from "vitest";
import { cycleTrees, parseInChildProcess } from "./test-helpers/variation-cycle";
import { createReviewVariationTree, parseReviewVariationTree, snapshotForMainline, variationTreeMatchesMainline } from "./review-variation-tree";

describe("review variation tree", () => {
  it("branches from any recorded ply, keeps sibling lines, and returns the selected path", () => {
    const tree = createReviewVariationTree(["h2e2", "h9g7", "h0g2"]);
    const root = tree.mainlineNodeId(1);
    const alternate = tree.append(root, "b9c7");
    const reply = tree.append(alternate, "b0c2");
    const secondAlternate = tree.append(root, "b7b3");

    expect(tree.pathTo(reply)).toEqual(["h2e2", "b9c7", "b0c2"]);
    expect(tree.childrenOf(root)).toEqual(["main-2", alternate, secondAlternate]);
    expect(tree.pathTo("main-3")).toEqual(["h2e2", "h9g7", "h0g2"]);
  });

  it("selects ancestors, stores annotations on nodes, and round-trips the branch tree", () => {
    const tree = createReviewVariationTree(["h2e2", "h9g7"]);
    const branch = tree.append(tree.mainlineNodeId(1), "b9c7");
    tree.annotate(branch, "這一步先保留中路控制");
    tree.select(tree.mainlineNodeId(1));
    expect(tree.selectedNodeId).toBe("main-1");

    const restored = parseReviewVariationTree(JSON.stringify(tree.toJSON()));
    expect(restored.pathTo(branch)).toEqual(["h2e2", "b9c7"]);
    expect(restored.node(branch)?.annotation).toBe("這一步先保留中路控制");
    expect(restored.selectedNodeId).toBe("main-1");
  });

  it("does not attach an old variation snapshot to a different saved mainline", () => {
    const tree = createReviewVariationTree(["h2e2", "h9g7"]);
    const branch = tree.append(tree.mainlineNodeId(1), "b2e2");
    tree.annotate(branch, "原棋局的分支筆記");

    expect(snapshotForMainline(tree, ["h2e2", "h9g7", "h0g2"])).toBeNull();
    expect(snapshotForMainline(tree, ["h2e2", "h9g7"])?.nodes.find((node) => node.id === branch)?.annotation)
      .toBe("原棋局的分支筆記");
  });

  it("binds a branch snapshot to its root FEN", () => {
    const tree = createReviewVariationTree(["h2e2"], "custom root");
    const saved = snapshotForMainline(tree, ["h2e2"], "custom root");
    const restored = parseReviewVariationTree(JSON.stringify(saved));

    expect(saved?.startFen).toBe("custom root");
    expect(variationTreeMatchesMainline(restored, ["h2e2"], "custom root")).toBe(true);
    expect(variationTreeMatchesMainline(restored, ["h2e2"], "other root")).toBe(false);
  });

  it("rejects a malformed branch move and leaves the tree unchanged", () => {
    const tree = createReviewVariationTree(["h2e2", "h9g7"]);
    const before = JSON.stringify(tree.toJSON());
    expect(() => tree.append(tree.mainlineNodeId(1), "zzzz")).toThrow();
    expect(() => tree.append("missing-node", "b9c7")).toThrow();
    expect(JSON.stringify(tree.toJSON())).toBe(before);
  });

  describe("turn starts (where each turn began, kept with the saved tree)", () => {
    it("remembers a turn start and round-trips it through the saved form", () => {
      const tree = createReviewVariationTree(["h2e2", "h9g7"]);
      const mine = tree.append(tree.mainlineNodeId(1), "b9c7");
      const reply = tree.append(mine, "b0c2");
      tree.markTurnStart(reply, tree.mainlineNodeId(1));
      expect(tree.turnStartOf(reply)).toBe("main-1");
      expect(tree.turnStartOf(mine)).toBeNull();

      const restored = parseReviewVariationTree(JSON.stringify(tree.toJSON()));
      expect(restored.turnStartOf(reply)).toBe("main-1");
    });

    it("an older saved tree without the field still loads and has no turn starts", () => {
      const saved = createReviewVariationTree(["h2e2"]).toJSON();
      expect("turnStarts" in saved).toBe(false);
      const restored = parseReviewVariationTree(JSON.stringify(saved));
      expect(restored.turnStartOf("main-1")).toBeNull();
    });

    it("drops saved turn starts that do not point at an ancestor instead of refusing the tree", () => {
      const tree = createReviewVariationTree(["h2e2", "h9g7"]);
      const mine = tree.append(tree.mainlineNodeId(1), "b9c7");
      const reply = tree.append(mine, "b0c2");
      tree.markTurnStart(reply, "main-1");
      const saved = { ...tree.toJSON(), turnStarts: { [reply]: "main-2", [mine]: "no-such-node", "no-such-node": "main-0" } };
      const restored = parseReviewVariationTree(JSON.stringify(saved));
      expect(restored.turnStartOf(reply)).toBeNull();
      expect(restored.turnStartOf(mine)).toBeNull();
      expect(restored.pathTo(reply)).toEqual(["h2e2", "b9c7", "b0c2"]);
    });

    it("reads the tree whatever shape a saved turnStarts has, and just has no turn starts then", () => {
      const tree = createReviewVariationTree(["h2e2", "h9g7"]);
      const reply = tree.append(tree.append(tree.mainlineNodeId(1), "b9c7"), "b0c2");
      for (const bad of [null, "main-1", 7, ["main-1"], { [reply]: 5 }, { [reply]: null }, { [reply]: ["main-1"] }]) {
        const restored = parseReviewVariationTree(JSON.stringify({ ...tree.toJSON(), turnStarts: bad }));
        expect(restored.turnStartOf(reply)).toBeNull();
        expect(restored.pathTo(reply)).toEqual(["h2e2", "b9c7", "b0c2"]);
      }
    });

    it("keeps the good entries when others in the same saved turnStarts are bad", () => {
      const tree = createReviewVariationTree(["h2e2", "h9g7"]);
      const mine = tree.append(tree.mainlineNodeId(1), "b9c7");
      const reply = tree.append(mine, "b0c2");
      const restored = parseReviewVariationTree(JSON.stringify({ ...tree.toJSON(), turnStarts: { [reply]: "main-1", [mine]: 3 } }));
      expect(restored.turnStartOf(reply)).toBe("main-1");
      expect(restored.turnStartOf(mine)).toBeNull();
    });

    it("refuses to mark a start that is not an ancestor of the node", () => {
      const tree = createReviewVariationTree(["h2e2", "h9g7"]);
      expect(() => tree.markTurnStart("main-1", "main-2")).toThrow();
      expect(() => tree.markTurnStart("main-1", "missing")).toThrow();
    });
  });
});

describe("a parent chain that loops and never reaches the root", () => {
  for (const [name, tree] of Object.entries(cycleTrees)) {
    it(`is refused as a structure error in finite time: ${name}`, () => {
      // run in a child process: before the fix this never returns, and must cost a timeout, not the whole test run
      expect(parseInChildProcess(tree)).toBe("rejected:TypeError:invalid variation tree: a parent chain never reaches the root");
    }, 15_000);
  }

  it("still accepts a healthy tree with branches and turn starts", () => {
    const tree = createReviewVariationTree(["h2e2", "h9g7", "h0g2"]);
    const branch = tree.append("main-1", "b9c7");
    tree.markTurnStart("main-2", "main-1");
    const restored = parseReviewVariationTree(JSON.stringify(tree.toJSON()));
    expect(restored.pathTo(branch)).toEqual(["h2e2", "b9c7"]);
    expect(restored.turnStartOf("main-2")).toBe("main-1");
  });
});
