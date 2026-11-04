# 搬到 Cloudflare Pages：使用者要做的事

設定檔都已經寫好（`.github/workflows/cloudflare-pages.yml`、`web/public/_headers`），**還沒部署**。在你做完下面第 1、3、4 步之前，這個 workflow 會自己跳過（check job 成功、build 與 deploy 都是 skipped），CI 不會變紅。

**絕對不要把 API token 貼在對話、檔案、commit 或 issue 裡。** 只貼進 GitHub 的 Secrets 設定頁。

## 1. 申請帳號（免費方案）
到 dash.cloudflare.com 註冊。Pages 免費方案夠用，不需要綁信用卡。記下 **Account ID**（左側選單 Workers & Pages 的頁面右側，或網址 `dash.cloudflare.com/<帳號ID>/...`）。

## 2. Pages 專案：不用自己建
deploy job 第一次跑時，會用 API 查 `CLOUDFLARE_PAGES_PROJECT` 這個名稱的專案；不存在就自己建（Direct Upload，**Production branch 設為 `main`**），run 的 summary 會寫「Created Cloudflare Pages project」。查詢得到 200 或 404 以外的回應（例如 token 權限不對、Account ID 打錯）就直接失敗，不會部署。workflow 用分支名 `main` 來區分正式與預覽。
（2026-10-19 起。之前的版本要在網頁上手動建專案；已經手動建過的話，名稱一樣就會直接沿用。）

## 3. 建 API token（只給 Pages 權限）
My Profile → API Tokens → Create Token → Create Custom Token：
- Permissions：**Account → Cloudflare Pages → Edit**，只加這一條。
- Account Resources：只選你的這個帳號。
- 不要用 Global API Key。建好的 token 只會顯示一次。

## 4. 在 GitHub 設定名稱（repo → Settings → Secrets and variables → Actions）
| 種類 | 名稱 | 內容 |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | 第 3 步的 token |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | 第 1 步的 Account ID |
| Variable | `CLOUDFLARE_PAGES_PROJECT` | 自己決定的專案名稱（小寫英數與連字號，例如 `xiangqi-coach`），第 2 步會用這個名稱建專案 |

三個都有才會部署；缺任何一個，run 的 summary 會寫「not configured」並跳過。

## 5. 第一次部署
在 Actions 頁手動執行 `cloudflare-pages`（workflow_dispatch，選 main），或 push 到 main。
- main：正式網址 `https://<專案名>.pages.dev`。
- 其他分支：預覽網址 `https://<分支名>.<專案名>.pages.dev`（分支名中不是英數字的字元會變成 `-`）。
- 網站在根路徑 `/`（base 為 `/`），GitHub Pages 的 `/xiangqi-coach/` 版本不受影響。

## 6. 第一次部署後怎麼驗
1. 網址：用瀏覽器開正式網址與一個預覽網址，各下一盤棋（電腦會回步）。
2. 覆盤：貼上或載入一盤棋，跑覆盤到「分析完成」，wasm 要能載入（開發者工具 Network 看 `wasm/xq_wasm_bg.wasm` 回 200、`content-type: application/wasm`）。
3. 標頭：`curl -sI https://<網址>/assets/<任一 hash 檔>` 要有 `cache-control: public, max-age=31536000, immutable`；`/`、`/sw.js`、`/manifest.webmanifest` 要是 `no-cache`；`/_headers` 本身不會被提供（2026-10-19 實測：回 200，但內容和首頁一模一樣，是 Pages 的單頁 fallback，不是那個檔）。**不應該**出現 `cross-origin-opener-policy`／`cross-origin-embedder-policy`（等 P7）。
4. 離線：開過一次後，開發者工具 Application → Service Workers 看到已啟用，勾 Offline 重新整理，仍能下棋與看已存的覆盤。離線時也直接開一次 `/index.html`（Cloudflare 會把它轉到 `/`，要確認 service worker 不會回一個被瀏覽器拒收的轉址回應；如果打不開，把 `index.html` 從 Cloudflare 版的預快取清單拿掉）。
5. 更新提示：改一個無害的字，push 後再部署一次；已開著舊版的分頁要出現「新版本」提示，按下去後換到新版。
6. 既有 E2E 對預覽網址跑一次（只跑正式建置那組：下棋、離線、wasm；不啟動本機伺服器）：
   ```bash
   cd web
   E2E_PREVIEW=1 E2E_REMOTE_URL=https://<分支名>.<專案名>.pages.dev/ \
     systemd-run --user --scope -q -p MemoryMax=12G -p MemorySwapMax=0 npx playwright test
   ```
   結果與日期記在開發進度紀錄（未公開）。
7. 正式環境：在 Cloudflare 專案頁確認 main 的部署標成 Production（workflow 每次部署前也會檢查專案的 production branch 是 `main`，不是就失敗）。通過後 P5 才算完成；GitHub Pages 是否關閉，等 Cloudflare 穩定再決定。

## 設計說明
- `web/public/_headers` 會被 Vite 原樣複製到 `dist/` 根目錄。有雜湊的 `/assets/*` 長快取 immutable；`wasm/*` 檔名沒有雜湊所以 `no-cache`（每次用 ETag 驗證）；入口檔 no-cache。brotli 由 Cloudflare 自動處理，不要預壓。
- service worker 的預快取清單排除 `_headers`／`_redirects`（Cloudflare 讀它們但不提供，列進去 install 會因 404 失敗）；`precache.test.ts` 有測試。
- 同一份 `_headers` 在 GitHub Pages 上只是一個普通檔案，無害。
- 選做：自訂網域（有網域才做）在專案 Custom domains 設定。
