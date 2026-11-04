export interface ReviewVariationNode {
  id: string;
  parentId: string | null;
  move: string | null;
  children: string[];
  annotation: string;
}

export interface SerializedReviewVariationTree {
  version: 1;
  startFen?: string;
  selectedNodeId: string;
  nodes: ReviewVariationNode[];
  /** Optional: node id -> the node where that turn began (the board move whose engine reply produced the node). Absent in older saves. */
  turnStarts?: Record<string, string>;
}

export class ReviewVariationTree {
  private readonly nodes = new Map<string, ReviewVariationNode>();
  private nextBranchId = 1;
  private readonly turnStarts = new Map<string, string>();
  private selected = "main-0";
  readonly startFen: string;

  constructor(mainline: string[], startFen = STANDARD_START_FEN) {
    this.startFen = startFen;
    this.nodes.set("main-0", { id: "main-0", parentId: null, move: null, children: [], annotation: "" });
    let parentId = "main-0";
    mainline.forEach((move, index) => {
      assertMove(move);
      const id = `main-${index + 1}`;
      this.nodes.set(id, { id, parentId, move, children: [], annotation: "" });
      this.nodes.get(parentId)!.children.push(id);
      parentId = id;
    });
  }

  get selectedNodeId(): string {
    return this.selected;
  }

  mainlineNodeId(plies: number): string {
    if (!Number.isInteger(plies) || plies < 0) throw new RangeError("plies must be a non-negative integer");
    const id = `main-${plies}`;
    if (!this.nodes.has(id)) throw new RangeError("mainline position is outside the recorded game");
    return id;
  }

  append(parentId: string, move: string): string {
    assertMove(move);
    const parent = this.requireNode(parentId);
    const existing = parent.children.find((id) => this.nodes.get(id)?.move === move);
    if (existing) return existing;
    const id = `branch-${this.nextBranchId++}`;
    parent.children.push(id);
    this.nodes.set(id, { id, parentId, move, children: [], annotation: "" });
    return id;
  }

  select(id: string): void {
    this.requireNode(id);
    this.selected = id;
  }

  annotate(id: string, annotation: string): void {
    this.requireNode(id).annotation = annotation;
  }

  node(id: string): ReviewVariationNode | null {
    const node = this.nodes.get(id);
    return node ? { ...node, children: [...node.children] } : null;
  }

  childrenOf(id: string): string[] {
    return [...this.requireNode(id).children];
  }

  pathTo(id: string): string[] {
    let cursor: ReviewVariationNode | undefined = this.nodes.get(id);
    if (!cursor) throw new RangeError(`unknown variation node: ${id}`);
    const moves: string[] = [];
    // second line of defence: a healthy chain is shorter than the node count, so a longer walk means the parents loop
    for (let steps = 0; cursor.parentId !== null; steps++) {
      if (steps >= this.nodes.size) throw new TypeError(CYCLE_MESSAGE);
      if (cursor.move === null) throw new TypeError("non-root variation node must contain a move");
      moves.push(cursor.move);
      cursor = this.nodes.get(cursor.parentId);
      if (!cursor) throw new TypeError("variation tree contains a missing parent");
    }
    return moves.reverse();
  }

  /** Records that the turn ending at `nodeId` began at `startId`, which must be an earlier node on the same line. */
  markTurnStart(nodeId: string, startId: string): void {
    this.requireNode(nodeId);
    this.requireNode(startId);
    if (!this.isProperAncestor(startId, nodeId)) throw new RangeError("a turn must start at an ancestor of its last node");
    this.turnStarts.set(nodeId, startId);
  }

  turnStartOf(nodeId: string): string | null {
    return this.turnStarts.get(nodeId) ?? null;
  }

  toJSON(): SerializedReviewVariationTree {
    return {
      version: 1,
      startFen: this.startFen,
      selectedNodeId: this.selected,
      nodes: [...this.nodes.values()].map((node) => ({ ...node, children: [...node.children] })),
      ...(this.turnStarts.size ? { turnStarts: Object.fromEntries(this.turnStarts) } : {}),
    };
  }

  private isProperAncestor(ancestorId: string, nodeId: string): boolean {
    let cursor = this.nodes.get(nodeId)?.parentId ?? null;
    for (let steps = 0; cursor !== null; steps++) {
      if (steps >= this.nodes.size) throw new TypeError(CYCLE_MESSAGE);
      if (cursor === ancestorId) return true;
      cursor = this.nodes.get(cursor)?.parentId ?? null;
    }
    return false;
  }

  private requireNode(id: string): ReviewVariationNode {
    const node = this.nodes.get(id);
    if (!node) throw new RangeError(`unknown variation node: ${id}`);
    return node;
  }
}

export function createReviewVariationTree(mainline: string[], startFen = STANDARD_START_FEN): ReviewVariationTree {
  return new ReviewVariationTree(mainline, startFen);
}

export function variationTreeMatchesMainline(
  tree: ReviewVariationTree,
  moves: string[],
  startFen = STANDARD_START_FEN,
): boolean {
  return tree.startFen === startFen
    && moves.every((move, index) => tree.node(`main-${index + 1}`)?.move === move)
    && tree.node(`main-${moves.length + 1}`) === null;
}

export function snapshotForMainline(
  tree: ReviewVariationTree,
  moves: string[],
  startFen = STANDARD_START_FEN,
): SerializedReviewVariationTree | null {
  return variationTreeMatchesMainline(tree, moves, startFen) ? tree.toJSON() : null;
}

export function parseReviewVariationTree(serialized: string): ReviewVariationTree {
  const value: unknown = JSON.parse(serialized);
  if (!isSerializedTree(value)) throw new TypeError("invalid review variation tree");
  const root = value.nodes.find((node) => node.id === "main-0");
  if (!root || root.parentId !== null || root.move !== null) throw new TypeError("invalid variation root");
  const tree = Object.create(ReviewVariationTree.prototype) as ReviewVariationTree;
  Object.defineProperty(tree, "startFen", { value: value.startFen ?? STANDARD_START_FEN });
  Object.defineProperty(tree, "nodes", { value: new Map(value.nodes.map((node) => [node.id, { ...node, children: [...node.children] }])) });
  Object.defineProperty(tree, "nextBranchId", {
    value: value.nodes.reduce((maximum, node) => {
      const match = /^branch-(\d+)$/.exec(node.id);
      return match ? Math.max(maximum, Number(match[1]) + 1) : maximum;
    }, 1),
    writable: true,
  });
  Object.defineProperty(tree, "selected", { value: value.selectedNodeId, writable: true });
  for (const node of value.nodes) {
    for (const childId of node.children) {
      const child = value.nodes.find((candidate) => candidate.id === childId);
      if (!child || child.parentId !== node.id) throw new TypeError("variation parent and child links disagree");
    }
    if (node.id !== "main-0" && (!node.parentId || !value.nodes.some((candidate) => candidate.id === node.parentId))) {
      throw new TypeError("variation node has a missing parent");
    }
  }
  // every node must reach the root within N steps (N = node count); a parent loop that never gets there is refused outright
  const parentOf = new Map(value.nodes.map((node) => [node.id, node.parentId]));
  for (const node of value.nodes) {
    let cursor: string | null = node.id;
    for (let steps = 0; cursor !== null; steps++) {
      if (steps > value.nodes.length) throw new TypeError(CYCLE_MESSAGE);
      cursor = parentOf.get(cursor) ?? null;
    }
  }
  Object.defineProperty(tree, "turnStarts", { value: new Map<string, string>() });
  tree.select(value.selectedNodeId);
  // saved turn starts are a convenience: one that does not fit the tree is dropped, it never makes the tree unreadable
  const saved: unknown = value.turnStarts;
  if (typeof saved === "object" && saved !== null && !Array.isArray(saved)) {
    for (const [nodeId, startId] of Object.entries(saved)) {
      if (typeof startId !== "string") continue;
      // only markTurnStart's own refusal (RangeError) is expected here; anything else is a bug and must show
      try { tree.markTurnStart(nodeId, startId); } catch (error) { if (!(error instanceof RangeError)) throw error; }
    }
  }
  return tree;
}

function assertMove(move: string): void {
  if (!/^[a-i][0-9][a-i][0-9]$/.test(move)) throw new TypeError("variation move must use ICCS coordinates");
}

function isSerializedTree(value: unknown): value is SerializedReviewVariationTree {
  if (typeof value !== "object" || value === null) return false;
  const tree = value as Partial<SerializedReviewVariationTree>;
  return tree.version === 1
    && typeof tree.selectedNodeId === "string"
    && (tree.startFen === undefined || typeof tree.startFen === "string")
    && Array.isArray(tree.nodes)
    && tree.nodes.every((node) => typeof node.id === "string"
      && (node.parentId === null || typeof node.parentId === "string")
      && (node.move === null || typeof node.move === "string")
      && Array.isArray(node.children)
      && node.children.every((id) => typeof id === "string")
      && typeof node.annotation === "string");
}

const CYCLE_MESSAGE = "invalid variation tree: a parent chain never reaches the root";
const STANDARD_START_FEN = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";
