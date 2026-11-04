// Produces the M8 stop-point samples: three engine-vs-engine games, each reviewed with the product
// review session (quick 100,000 nodes, deep 300,000 (3x quick) for losses above 5%) and written out at
// one explanation level. Run after building the wasm:
//   scripts/build-web-wasm.sh && cd web && npx vite-node scripts/make-samples.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { zhTW } from "../src/locale/zh-TW";
import type { ReviewReason } from "../src/review-client";

const root = resolve(import.meta.dirname, "../..");
const wasmDir = resolve(root, "web/public/wasm");
const wasm = await import(/* @vite-ignore */ resolve(wasmDir, "xq_wasm.js")) as any;
await wasm.default({ module_or_path: readFileSync(resolve(wasmDir, "xq_wasm_bg.wasm")) });

// Fixed in advance (see docs/DECISIONS.md): game index 0 of the frozen games at these difficulties,
// the user being Red, reviewed for the first 60 plies.
const SAMPLES = [
  { file: "sample-beginner.md", gameLevel: 4, skill: "beginner" },
  { file: "sample-intermediate.md", gameLevel: 6, skill: "intermediate" },
  { file: "sample-proficient.md", gameLevel: 8, skill: "expert" },
] as const;
const PLIES = 60;
const START = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";

const games = readFileSync(resolve(root, "crates/xq-review/tests/fixtures/level-games/games.tsv"), "utf8")
  .split("\n").filter(Boolean).map((line) => line.split("\t"));

mkdirSync(resolve(root, "docs/samples"), { recursive: true });
for (const sample of SAMPLES) {
  const row = games.find((cols) => Number(cols[1]) === sample.gameLevel && Number(cols[2]) === 0)!;
  const moves = row[7]!.split(" ").slice(0, PLIES);
  const game = new wasm.WebGame();
  for (const move of moves) if (!game.play(move)) throw new Error(`illegal ${move}`);
  const notation = game.history().split("\n").filter(Boolean).map((record: string) => record.split("|")[2]!);

  // The slow part (the review itself) is cached as small JSON next to the sample; delete the
  // file to redo it. Rendering the text from it is instant.
  const dataFile = resolve(root, "docs/samples/data", sample.file.replace(".md", ".json"));
  type Kept = { classification: string; lossPercent: number; bestMove: string; reason: ReviewReason | null | undefined };
  let finals: Kept[];
  if (existsSync(dataFile)) {
    finals = JSON.parse(readFileSync(dataFile, "utf8")).finals;
  } else {
    const session = new wasm.ReviewWorkerSession(START, moves.join(" "), 100_000);
    finals = [];
    for (;;) {
      const event = JSON.parse(session.step());
      if (event.done) break;
      const f = event.point.final;
      finals[event.index] = { classification: f.classification, lossPercent: f.lossPercent, bestMove: f.bestMove, reason: f.reason ?? null };
    }
    mkdirSync(resolve(root, "docs/samples/data"), { recursive: true });
    writeFileSync(dataFile, JSON.stringify({ gameLevel: sample.gameLevel, opening: row[3], moves, finals }, null, 1));
  }
  const voice = JSON.parse(wasm.level_view(JSON.stringify({ autoScore: null, gameCount: 0, manual: sample.skill }))).voice;
  const levelName = zhTW.review.levelNames[sample.skill]!;
  const lines = [
    `# 覆盤樣本：${levelName}程度`,
    "",
    `- 對局：內建引擎難度 ${sample.gameLevel} 對難度 ${sample.gameLevel}（自我對打），開局 ${row[3]}，使用者視角為紅方。`,
    `- 範圍：前 ${PLIES} 手；內建引擎快掃 100,000 節點，損失超過 5% 的步再深掃 300,000 節點。`,
    `- 程度：${levelName}（講解寫法：${voice}）。依 SPEC 8.5 只標出該程度會標記的步。`,
    "",
  ];
  let marked = 0;
  finals.forEach((result, index) => {
    if (index % 2 !== 0) return; // red plies only
    if (!wasm.level_shows(sample.skill, result.classification)) return;
    marked += 1;
    const reason: ReviewReason | null | undefined = result.reason;
    lines.push(`## 第 ${index + 1} 手　${notation[index]}（${moves[index]}）`, "",
      `- 分類：${zhTW.review.classification(result.classification)}，勝率損失 ${result.lossPercent.toFixed(1)}%`,
      `- 引擎最佳著：${result.bestMove}`,
      `- 原因：${reason ? zhTW.review.reason(reason, voice) : "（沒有能歸類的具體原因）"}`, "");
  });
  if (marked === 0) lines.push("這個範圍內沒有需要標記的步。", "");
  writeFileSync(resolve(root, "docs/samples", sample.file), lines.join("\n"));
  console.log(sample.file, "marked", marked);
}
