# 未來棋力試驗開局方案（審查稿）

狀態：僅提案，未抽樣、未預註冊、未啟動。範圍只適用於既有 eligible 母體中未正式用過的 153 局；不可改判舊 CE/MH/RA，Q/K 不屬於棋力結論。來源是本 repo 開局資料，不含外部引擎執行檔或權重。

## 舊／新設計

舊設計：固定 50 開局；每局雙色各打一盤、兩 round，共 200 盤。第二 look 重跑同一 50 個 opening/color 配對，只能查重現性，effective n 仍 50。新候選：從剩餘 153 局均勻不放回抽 ordered 100；look 1 用前 50 局、雙色、各兩 round（200 盤）；若正式 97.5%有限母體區間跨 0.5，再以同一配置跑後 50 局、雙色、各兩 round（再 200 盤）。第二 look 合併兩 look，獨立抽樣單位為 100 個 opening cluster，n=100；同一 opening 的換色及重複 round 不作獨立樣本。採納條件保持 Elo 下限 > 0；不調低信心水準。結論只外推至這 153 局有限母體。

## 抽樣鎖定流程（未執行）

1. 先凍結候選 A/B 整體設定與 runner/auditor；正確性修復須具反例、回歸且對打不退步，棋力增強門檻照舊。當前候選（可能 RA+CE 新 M4 整體方案）尚未固定，故不填 binary/source SHA，也不拼裝。
2. 在任何新 WDL 可見前，對本清單的 153 個 opening_id/position_key 排序，產生 OS 隨機 64-bit seed；記錄 seed 來源、Python 版本、抽樣工具 commit，按 `random.Random(seed).sample(ordered_population,100)` 不放回抽樣。保存 ordered100、seed、完整候選配置及輸入/輸出 SHA-256，形成 prereg hash，再由獨立 reviewer 重現；prereg 後不得換 seed、開局或設定。
3. 只在使用者批准 M4「一組50」口徑及整體候選方案後，按前述兩-look 條件啟動。此稿不含啟動命令。

## 區間寬度與成本

沿用 DECISIONS 中界限分數的 Hoeffding–Serfling 半寬：`r=sqrt((1-(n-1)/N)*ln(2/alpha)/(2n))`，score interval 為 `score±r`（截於[0,1]），Elo 用 `400 log10(p/(1-p))` 轉換。每-look alpha=.025（Bonferroni 兩次 look，整體至少95%）；另報普通 95% Hoeffding（alpha=.05）。在中性點 score=.5 的理論全寬：舊 N=203,n=50 決策 score .3647／約 ±132.8 Elo，ordinary score .3346／約 ±120.9；新 N=153,n=50 為 .3452／±125.1 Elo、ordinary .3167／±114.0；look2 合併 N=153,n=100 為 .1759／±61.7 Elo、ordinary .1614／±56.6。這是公式寬度與成本比較，不是未來 WDL 或預測結果。

待裁定：TEST_PLAN 第5.2「一組50」是否允許分兩批 50 個新 cluster 並以 look2 n=100 作同一有限母體結論；在裁定前本稿不得升格為規格或正式 prereg。公式依 `docs/DECISIONS.md` M4統計決策紀錄；來源資料 hash 見 `manifest.json`。

依據：`docs/TEST_PLAN.md:134–139`（50局與第二批200盤的文字；未明定是否可換新開局）；`docs/DECISIONS.md:22–25`（cluster與Serfling口徑）；`docs/research/m4-openings/README.md:7,19`（CCPD來源及檔案hash）。資料集上游：[CCPD](https://github.com/Yvonne761/Chinese-Chess-Practical-Dataset)，revision `368a47a947773dd8692c026e286dd19b6277b993`。本次僅引用本地資料集紀錄，未使用或複製引擎 binary/weights。
