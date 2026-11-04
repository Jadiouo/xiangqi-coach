# xiangqi-coach

象棋練習與覆盤教練。引擎以 Rust 寫成，編成 WebAssembly（wasm），整個在瀏覽器裡執行，不需要伺服器。

線上試玩：<https://jadiouo.github.io/xiangqi-coach/>

## 功能

依 `docs/SPEC.md` 與 `docs/TASKS.md`，已實作的範圍如下（棋力數字見 `docs/STRENGTH.md`，以實際量測為準）：

- 對弈：內建 Rust 引擎，可選難度、悔棋。
- 覆盤：勝率曲線、標出失誤的步、前幾名候選走法與簡短原因說明。
- 推演：覆盤時可以走「如果我下這裡」的分支，引擎接著回應。
- 棋譜匯入：ICCS、中文記譜、PGN 樣式、東萍格式，並可自動判斷。
- 程度估計：依對局估計棋力，講解深度跟著調整。
- 筆記：覆盤後產生 Markdown 筆記，可下載。
- 可安裝為 PWA（離線可用）。
- 可選：命令列工具可透過 UCI 協定連接外部引擎。

## 目錄

| 路徑 | 內容 |
|---|---|
| `crates/` | Rust 工作區：`xq-core`（規則）、`xq-engine`（搜尋）、`xq-review`（覆盤）、`xq-uci`（UCI 程式）、`xq-wasm`（瀏覽器綁定） |
| `web/` | 網頁前端（Vite + TypeScript） |
| `scripts/`、`tools/` | 對打、資料處理與部署輔助腳本 |
| `docs/` | 規格（`SPEC.md`）、測試計畫、里程碑、棋力紀錄、覆盤範例（`docs/samples/`） |

本公開版只含程式、規格與範例，不含開發紀錄。

## 建置與測試

需要 Rust（含 `wasm32-unknown-unknown` target）、Node.js 與 npm、Python 3。

```bash
make check        # 完整檢查：cargo fmt、clippy、cargo test、wasm 建置、web 型別檢查／單元測試／建置、Python 測試
make slow-check   # 慢速測試（深層 perft），較耗時
```

網頁：

```bash
cd web
npm ci
npm run dev       # 本機開發（先建 wasm）
npm run build     # 正式建置
npm run typecheck
npm test          # Vitest
npm run test:e2e  # Playwright 端到端測試
```

## 外部引擎（可選）

Pikafish 只是可選的外部 UCI 引擎，本程式只透過 UCI 協定與它的執行檔溝通。本 repo 不含 Pikafish 的任何原始碼或權重檔（Pikafish 為 GPL-3.0）。

## 授權

MIT，見 `LICENSE`。
