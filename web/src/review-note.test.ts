import { describe, expect, it } from "vitest";
import { createReviewVariationTree } from "./review-variation-tree";
import { generateReviewNote, type ReviewNoteInput } from "./review-note";

const startFen = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";
const startBoard = [
  "rnbakabnr", ".........", ".c.....c.", "p.p.p.p.p", ".........",
  ".........", "P.P.P.P.P", ".C.....C.", ".........", "RNBAKABNR",
].join("");

function point(move: string, lossPercent: number, classification: "mistake" | "doubtful_move" | "good", reason?: { kind: "walked_into_mate" | "missed_mate"; moves: number }, probability = 0.5) {
  const candidate = {
    move: "h2e2",
    score: { centipawns: 120, mateIn: null },
    pv: ["h2e2", "h9g7", "h0g2", "i9h9", "i0h0", "b9c7"],
    depth: 8,
    nodes: 50_000,
    pvEnd: "depth_limit" as const,
    continuation: [{ move: "h0g2", depth: 8, nodes: 10_000, pvEnd: "depth_limit" as const }],
    continuationNodeLimit: 10_000,
    continuationTerminal: false,
    replayAudit: { failedIndex: null },
    continuationStatus: "complete" as const,
  };
  const result = {
    bestMove: "h2e2",
    playedMove: move,
    playedRank: 1,
    bestScore: { centipawns: 120, mateIn: null },
    playedScore: { centipawns: 0, mateIn: null },
    bestWinProbability: 0.7,
    playedWinProbability: probability,
    lossPercent,
    classification,
    ...(reason ? { reason } : {}),
    candidates: [candidate],
  };
  return { quick: result, final: result, deepened: true, continuationComplete: true };
}

function input(): ReviewNoteInput {
  const moves = ["h2e2", "h9g7", "h0g2", "i9h9", "i0h0", "b9c7"];
  const tree = createReviewVariationTree(moves, startFen);
  const branch = tree.append(tree.mainlineNodeId(1), "b9c7");
  tree.annotate(branch, "保留中路，避免 <svg onload=alert(1)>。");
  const unannotated = tree.append(tree.mainlineNodeId(2), "b7b3");
  tree.annotate(unannotated, "   ");
  return {
    reportDate: "2026-10-09",
    metadata: { Red: "紅方 <script>alert(1)</script>", Black: "黑方\n(Result \"1-0\")", Result: "1-0" },
    result: "red_win",
    startFen,
    moves,
    notations: ["炮二平五", "馬8進7", "馬二進三", "車9平8", "車一平二", "馬2進3"],
    points: [
      point(moves[0]!, 11, "mistake", { kind: "walked_into_mate", moves: 3 }),
      point(moves[1]!, 24, "mistake", { kind: "missed_mate", moves: 1 }),
      point(moves[2]!, 13, "doubtful_move"),
      point(moves[3]!, 16, "mistake", { kind: "walked_into_mate", moves: 2 }),
      point(moves[4]!, 7, "doubtful_move"),
      point(moves[5]!, 0.5, "good"),
    ],
    boards: Array.from({ length: moves.length + 1 }, () => startBoard),
    variationTree: tree.toJSON(),
    analyzer: { name: "內建引擎", quickNodeLimit: 100_000, deepNodeLimit: 1_000_000, config: "SearchConfig::default()" },
  };
}

describe("review note", () => {
  it("writes all eight sections with analysis provenance, deterministic date, and a full Chinese replay", () => {
    const document = generateReviewNote(input());

    for (const heading of ["對局資訊", "勝率曲線", "對局摘要", "關鍵時刻", "推演分支", "毛病統計", "下次注意", "完整棋譜"]) {
      expect(document.markdown).toContain("## " + heading);
    }
    expect(document.markdown).toContain("2026-10-09");
    expect(document.markdown).toContain("內建引擎");
    expect(document.markdown).toContain("100,000");
    expect(document.markdown).toContain("1,000,000");
    expect(document.markdown).toContain("[FEN \"rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1\"]");
    expect(document.markdown).toContain("1. 炮二平五 馬8進7 2. 馬二進三 車9平8 3. 車一平二 馬2進3");
    expect(generateReviewNote(input()).markdown).toBe(document.markdown);
  });

  it("includes no more than five evidence-backed moments with the originating candidate PV and local board SVG", () => {
    const markdown = generateReviewNote(input()).markdown;
    const moments = [...markdown.matchAll(/^### 第 \d+ 手/gm)];

    expect(moments).toHaveLength(5);
    expect(markdown).toContain("第 2 手");
    expect(markdown).toContain("最佳候選・深度 8・50,000 節點");
    expect(markdown).toContain("對方可以在 3 步內將死你");
    expect(markdown).toContain("<svg xmlns=\"http://www.w3.org/2000/svg\"");
  });

  it("filters unannotated branches and escapes imported names and branch comments", () => {
    const markdown = generateReviewNote(input()).markdown;

    expect(markdown).toContain("保留中路，避免 &lt;svg onload=alert(1)&gt;。");
    expect(markdown).not.toContain("alert(1)</script>");
    expect(markdown).not.toContain("(Result \"1-0\")");
    expect(markdown).not.toContain("b7b3");
  });

  it("counts only typed causes, tracks unknown separately, and chooses next focus only with a unique known maximum", () => {
    const markdown = generateReviewNote(input()).markdown;

    expect(markdown).toContain("走進被殺：2 次");
    expect(markdown).toContain("錯過殺棋：1 次");
    expect(markdown).toContain("原因尚未判定：2 次");
    expect(markdown).toContain("引擎可證明最多的是：走進被殺");

    const tied = input();
    tied.points = [
      point("h2e2", 12, "mistake", { kind: "walked_into_mate", moves: 2 }),
      point("h9g7", 14, "mistake", { kind: "missed_mate", moves: 1 }),
    ];
    tied.moves = ["h2e2", "h9g7"];
    tied.notations = ["炮二平五", "馬8進7"];
    tied.boards = [startBoard, startBoard, startBoard];
    expect(generateReviewNote(tied).markdown).toContain("下次注意：待分析");
  });

  it("states a non-mate engine reason in its own words instead of the mate sentence", () => {
    const sent = input();
    sent.moves = ["h2e2"];
    sent.notations = ["炮二平五"];
    sent.boards = [startBoard, startBoard];
    sent.points = [point("h2e2", 18, "mistake", {
      kind: "sent_piece", moves: 0,
      protection: { piece: { side: "red", kind: "horse" }, from: "b2", to: "c4", capturedAt: "c4", capturer: "black",
        attacker: { side: "black", kind: "pawn" }, net: -300, protectedPiece: null, protectedSquare: null },
    } as never)];
    const markdown = generateReviewNote(sent).markdown;

    expect(markdown).toContain("c4");
    expect(markdown).toContain("馬");
    expect(markdown).not.toContain("將死");
    expect(markdown).not.toContain("原因尚未判定：0 次，");
  });

  it("counts the M8 engine reasons (dropped material, sent piece, ...) from real reason data, not only the two mate kinds", () => {
    const protection = { piece: { side: "red", kind: "horse" }, from: "b2", to: "c4", capturedAt: "c4", capturer: "black",
      attacker: { side: "black", kind: "pawn" }, net: -300, protectedPiece: null, protectedSquare: null };
    const material = { mover: "red", bestNet: 0, playedNet: -300, plies: 3, bestCaptures: [], playedCaptures: [{ piece: { side: "red", kind: "horse" }, square: "c4", capturer: "black", ply: 2 }] };
    const reasons = [
      { kind: "dropped_material", moves: 2, material },
      { kind: "dropped_material", moves: 3, material },
      { kind: "sent_piece", moves: 0, protection },
      { kind: "abandoned_protection", moves: 0, protection },
      { kind: "check_capture", moves: 1, checkCapture: { victim: { side: "red", kind: "rook" }, victimSquare: "a0", attacker: { side: "black", kind: "cannon" }, attackerFrom: "b2", net: -500 } },
      { kind: "missed_material", moves: 2, material },
    ] as never[];
    const counted = input();
    counted.moves = ["h2e2", "h9g7", "h0g2", "i9h9", "i0h0", "b9c7"];
    counted.points = counted.moves.map((move, index) => point(move, 12 + index, "mistake", reasons[index] as never));
    counted.points.push(point("h2e2", 15, "mistake", { kind: "dropped_material", moves: 1, material } as never));
    counted.moves.push("h2e2");
    counted.notations.push("炮二平五");
    counted.boards.push(startBoard);
    const markdown = generateReviewNote(counted).markdown;

    expect(markdown).toContain("丟子：3 次");
    expect(markdown).toContain("送吃：1 次");
    expect(markdown).toContain("放掉保護：1 次");
    expect(markdown).toContain("被抽將：1 次");
    expect(markdown).toContain("錯過得子：1 次");
    expect(markdown).toContain("走進被殺：0 次");
    expect(markdown).toContain("原因尚未判定：0 次");
    expect(markdown).toContain("引擎可證明最多的是：丟子");
  });

  it("says there are no obvious mistakes without fabricating moments or diagnoses", () => {
    const clean = input();
    clean.points = clean.moves.map((move) => point(move, 0.5, "good"));
    const markdown = generateReviewNote(clean).markdown;

    expect(markdown).toContain("這盤沒有明顯的失誤。");
    expect(markdown).toContain("下次注意：待分析");
    expect(markdown).not.toMatch(/^### 第 \d+ 手/gm);
    expect(markdown).not.toContain("送吃：0 次");
  });

  it("exports pure text without embedded SVG and escapes XML-sensitive values", () => {
    const document = generateReviewNote(input());

    expect(document.plainText).not.toContain("<svg");
    expect(document.plainText).toContain("勝率曲線圖");
    expect(document.curveSvg).toContain("<svg xmlns=\"http://www.w3.org/2000/svg\"");
    expect(document.curveSvg).toContain("&amp;");
  });

  it("keeps a custom black-to-move root and its fullmove numbering in the export", () => {
    const custom = input();
    custom.startFen = "2R6/9/5k3/9/r8/2C6/9/6R2/9/2C1K4 b - - 7 4";
    custom.moves = ["a4a5", "c5c4"];
    custom.notations = ["車1進1", "炮五平六"];
    custom.points = custom.points.slice(0, 2);
    custom.boards = custom.boards.slice(0, 3);
    const markdown = generateReviewNote(custom).markdown;
    expect(markdown).toContain("- 開局：自訂起局");
    expect(markdown).toContain("[FEN \"2R6/9/5k3/9/r8/2C6/9/6R2/9/2C1K4 b - - 7 4\"]");
    expect(markdown).toContain("4... 車1進1 5. 炮五平六");
  });

  it("converts each alternating mover-view probability to red view for the curve", () => {
    const game = input();
    game.startFen = "2R6/9/5k3/9/r8/2C6/9/6R2/9/2C1K4 b - - 0 1";
    game.moves = ["a4a5", "c5c4"];
    game.points = [point("a4a5", 0, "good", undefined, 0.8), point("c5c4", 0, "good", undefined, 0.3)];
    game.notations = ["車1進1", "炮五平六"];
    game.boards = [startBoard, startBoard, startBoard];
    const document = generateReviewNote(game);
    expect(document.curveSvg).toContain("polyline points=\"20,164 700,146\"");
    expect(document.curveSvg).toContain("紅方勝率");
  });

  // TEST_PLAN 7.2: embedded SVG is valid XML. No DOM/XML parser is installed (and no new package is allowed), so this is a strict
  // well-formedness check: balanced and correctly nested tags, quoted unique attributes, only the five predefined entities
  // or numeric references, no raw "<" / "&" in text or values, one root. It does not validate against the SVG schema.
  function wellFormedXmlProblems(xml: string): string[] {
    const problems: string[] = [];
    const entity = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/y;
    const checkText = (text: string, where: string) => {
      for (let i = 0; i < text.length; i += 1) {
        if (text[i] === "<") problems.push(`raw < in ${where}`);
        if (text[i] === "&") { entity.lastIndex = i; if (!entity.test(text)) problems.push(`bad entity in ${where}`); }
      }
    };
    const stack: string[] = [];
    let roots = 0;
    let pos = 0;
    const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
    while (pos < xml.length) {
      const next = xml.indexOf("<", pos);
      const text = xml.slice(pos, next === -1 ? xml.length : next);
      checkText(text, "text");
      if (stack.length === 0 && text.trim()) problems.push("text outside root");
      if (next === -1) break;
      tag.lastIndex = next;
      const m = tag.exec(xml);
      if (!m) { problems.push(`malformed tag at ${next}: ${xml.slice(next, next + 40)}`); break; }
      const [whole, closing, name, attrs, selfClose] = m as unknown as [string, string, string, string, string];
      if (closing) {
        if (attrs.trim() || selfClose) problems.push(`closing tag with attributes: ${name}`);
        if (stack.pop() !== name) problems.push(`mismatched closing tag: ${name}`);
      } else {
        if (stack.length === 0) roots += 1;
        const seen = new Set<string>();
        for (const a of attrs.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
          if (seen.has(a[1]!)) problems.push(`duplicate attribute ${a[1]}`);
          seen.add(a[1]!);
          checkText(a[3] ?? a[4] ?? "", `attribute ${a[1]}`);
        }
        if (!selfClose) stack.push(name);
      }
      pos = next + whole.length;
    }
    if (stack.length) problems.push(`unclosed tags: ${stack.join(",")}`);
    if (roots !== 1) problems.push(`expected one root element, got ${roots}`);
    return problems;
  }

  it("the checker itself rejects broken XML", () => {
    expect(wellFormedXmlProblems("<svg><g></svg>")).not.toEqual([]);
    expect(wellFormedXmlProblems("<svg><text>a & b</text></svg>")).not.toEqual([]);
    expect(wellFormedXmlProblems("<svg a=1></svg>")).not.toEqual([]);
    expect(wellFormedXmlProblems("<svg><title>a<b</title></svg>")).not.toEqual([]);
    expect(wellFormedXmlProblems("<svg a=\"1\" a=\"2\"/>")).not.toEqual([]);
    expect(wellFormedXmlProblems("<svg><g/><title>x &amp; y &#26834;</title></svg>")).toEqual([]);
  });

  it("every embedded SVG in the note (board diagrams and the curve) is well-formed XML", () => {
    const document = generateReviewNote(input());
    const svgs = document.markdown.match(/<svg[\s\S]*?<\/svg>/g) ?? [];
    // five moment boards plus the win-rate curve
    expect(svgs.length).toBeGreaterThanOrEqual(6);
    for (const svg of svgs) expect(wellFormedXmlProblems(svg), svg.slice(0, 80)).toEqual([]);
    expect(wellFormedXmlProblems(document.curveSvg)).toEqual([]);
    expect(svgs).toContain(document.curveSvg);
  });
});
