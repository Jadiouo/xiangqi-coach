#!/usr/bin/env bash
# 用外部 UCI 引擎（例如 Pikafish）覆盤一份棋譜，輸出覆盤 JSON 與筆記 Markdown。
# 用法：scripts/review-with-engine.sh <棋譜> <引擎執行檔> <輸出前綴> [xq-uci review 的其他參數]
# 例：  scripts/review-with-engine.sh game.pgn /path/to/pikafish out/game --nodes 2000 --deep-nodes 20000
# 產生 <輸出前綴>.json（xq-uci review 的輸出）與 <輸出前綴>.md（網頁同一份筆記產生器的輸出）。
# 引擎只透過 UCI 文字協定溝通，引擎與權重檔不會被複製進本專案。
set -euo pipefail
[ "$#" -ge 3 ] || { sed -n '2,6p' "$0" >&2; exit 2; }
record="$1"; engine="$2"; prefix="$3"; shift 3
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$(dirname "$prefix")"
prefix="$(cd "$(dirname "$prefix")" && pwd)/$(basename "$prefix")"
cargo run -q --release --manifest-path "$here/Cargo.toml" -p xq-uci -- \
  review --record "$record" --engine "$engine" "$@" > "$prefix.json"
[ -d "$here/web/node_modules" ] || (cd "$here/web" && npm ci --no-audit --no-fund)
(cd "$here/web" && node scripts/review-note-cli.mjs "$prefix.json" --out "$prefix.md") 2>&1 || {
  echo "筆記產生失敗；覆盤 JSON 仍保留在 $prefix.json" >&2; exit 1; }
echo "已輸出 $prefix.json 與 $prefix.md"
