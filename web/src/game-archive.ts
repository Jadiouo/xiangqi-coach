import { normalizeSavedGameRecord, STANDARD_START_FEN } from "./game-library";
import type { SavedGame } from "./game-library";
import { parseReviewVariationTree, variationTreeMatchesMainline } from "./review-variation-tree";

export interface GameArchive {
  format: "xiangqi-coach-backup";
  schemaVersion: 1;
  exportedAt: string;
  games: SavedGame[];
}

export type ReplayValidator = (startFen: string, moves: string[]) => Promise<boolean>;

export function buildArchive(games: SavedGame[], exportedAt: string): GameArchive {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exportedAt)) throw new TypeError("匯出日期格式錯誤");
  const normalized = games.map((game, index) => {
    const row = normalizeSavedGameRecord(structuredClone(game));
    if (!row) throw new TypeError(`第 ${index + 1} 局資料格式錯誤，無法匯出。`);
    return row;
  });
  return { format: "xiangqi-coach-backup", schemaVersion: 1, exportedAt, games: normalized };
}

export async function parseArchive(serialized: string, replay: ReplayValidator): Promise<GameArchive> {
  let input: unknown;
  try { input = JSON.parse(serialized) as unknown; }
  catch { throw new TypeError("備份檔不是有效的 JSON。"); }
  if (!isObject(input) || input.format !== "xiangqi-coach-backup") throw new TypeError("這不是象棋教練備份檔。");
  if (input.schemaVersion === undefined) throw new TypeError("備份檔沒有版本號（可能是舊版格式），無法匯入。");
  if (input.schemaVersion !== 1) throw new TypeError(`不支援此備份版本（${String(input.schemaVersion)}），目前只支援版本 1。`);
  if (!isDate(input.exportedAt) || !Array.isArray(input.games)) throw new TypeError("備份檔結構不完整或格式錯誤。");

  const games: SavedGame[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < input.games.length; index++) {
    const raw = input.games[index];
    const game = normalizeSavedGameRecord(raw);
    if (!game || !game.id.trim() || !Number.isFinite(game.savedAt)) throw new TypeError(`第 ${index + 1} 局資料格式錯誤，整份備份未匯入。`);
    if (ids.has(game.id)) throw new TypeError(`第 ${index + 1} 局的識別碼重複，整份備份未匯入。`);
    ids.add(game.id);
    if (isObject(raw) && raw.reviewSnapshot != null && game.reviewSnapshot == null) throw new TypeError(`第 ${index + 1} 局的分析資料格式錯誤，整份備份未匯入。`);
    if (isObject(raw) && raw.reviewNote != null && game.reviewNote == null) throw new TypeError(`第 ${index + 1} 局的筆記資料格式錯誤，整份備份未匯入。`);
    const root = game.startFen || STANDARD_START_FEN;
    if (!await replay(root, game.moves)) throw new TypeError(`第 ${index + 1} 局的主線含有不合法局面或走法，整份備份未匯入。`);
    if (game.variationTree !== null) {
      let tree;
      try { tree = parseReviewVariationTree(JSON.stringify(game.variationTree)); }
      catch { throw new TypeError(`第 ${index + 1} 局的分支樹結構錯誤，整份備份未匯入。`); }
      if (tree.startFen !== root || !variationTreeMatchesMainline(tree, game.moves, root)) {
        throw new TypeError(`第 ${index + 1} 局的分支樹起點或主線不一致，整份備份未匯入。`);
      }
      for (const node of game.variationTree.nodes) {
        const path = tree.pathTo(node.id);
        if (!await replay(root, path)) throw new TypeError(`第 ${index + 1} 局的分支含有不合法走法，整份備份未匯入。`);
      }
    }
    games.push(game);
  }
  return { format: "xiangqi-coach-backup", schemaVersion: 1, exportedAt: input.exportedAt, games };
}

export function mergeArchiveGames(existing: SavedGame[], imported: SavedGame[]): { games: SavedGame[]; skipped: number; added: number } {
  const result = existing.map((game) => structuredClone(game));
  const byId = new Map(result.map((game) => [game.id, game]));
  let skipped = 0;
  let added = 0;
  for (const source of imported) {
    const original = structuredClone(source);
    const occupied = byId.get(original.id);
    if (!occupied) {
      result.push(original); byId.set(original.id, original); added++; continue;
    }
    if (sameContent(occupied, original)) { skipped++; continue; }
    const baseId = `${source.id}-import-${hash(stableJson(source))}`;
    let id = baseId;
    let suffix = 2;
    while (byId.has(id) && !sameContent(byId.get(id)!, { ...original, id })) id = `${baseId}-${suffix++}`;
    if (byId.has(id)) { skipped++; continue; }
    original.id = id;
    result.push(original); byId.set(id, original); added++;
  }
  return { games: result, skipped, added };
}

function sameContent(left: SavedGame, right: SavedGame): boolean {
  // difficulty and outcome only exist in newer saves: an older backup of the same game must not come in as a copy
  const canonical = (game: SavedGame) => {
    const { difficulty: _difficulty, outcome: _outcome, ...rest } = normalizeSavedGameRecord(game) ?? game;
    return { ...rest, id: "" };
  };
  return stableJson(canonical(left)) === stableJson(canonical(right));
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: string): string {
  let code = 2166136261;
  for (let index = 0; index < value.length; index++) code = Math.imul(code ^ value.charCodeAt(index), 16777619);
  return (code >>> 0).toString(36);
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isDate(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value); }
