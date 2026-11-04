# 未來棋力試驗開局規則

狀態：使用者已批准此未來驗收口徑；尚未抽樣、建立正式 prereg 或啟動對打。適用所有尚未開始的未來棋力增強候選，包括新的 M4 組合與 M5 候選；M4 random/greedy 基準及 §5.3.5 正確性修復仍依原 50 局口徑。有限母體是既有合格資料扣除舊正式使用的 50 局後之 153 局，結論只外推到這 153 局。這不改判既有 CE、MH、RA 否決，也不新增 Q/K 棋力結論。

## 抽樣與兩輪

候選 source/config 凍結後，且任何新 WDL 可見前，將 `remaining-153.jsonl` 按 opening ID 排序，以 OS 隨機 64-bit seed 和固定版本抽取 100 局、不放回；保留抽樣順序。記錄 seed 來源、工具/Python 版本、輸入和 ordered100 的 SHA-256，由獨立 reviewer 重現，並在首場對打前鎖定 prereg hash。對局輸出此時尚不存在，完賽後再計算其 hash。

Look 1 用 ordered100 前 50 局；每局紅黑雙色各一盤、兩 round，共 200 盤。若正式決策區間跨過 score 0.5，才用後 50 局按完全相同設定跑 look 2，再 200 盤。每 look n=50；第二 look 合併 n=100。有效單位是 opening cluster，同局換色及重複 round 不增加 n。採納門檻維持正式 Elo 區間下限 > 0；look 2 後仍跨 0.5 即未證實增強，還原。每 look 200 盤，固定節點數、棋力候選門檻及其餘 TEST_PLAN 要求不變。

## 統計口徑與成本

決策區間使用有限母體 Hoeffding–Serfling 半寬 `r=sqrt((1-(n-1)/N)*ln(2/alpha)/(2n))`，每-look alpha=.025，Bonferroni 控制兩次 look、整體至少95%； score 區間為 `score±r`（截於[0,1]），Elo 以 `400 log10(p/(1-p))` 轉換。普通95% Hoeffding另報，不使用有限母體修正，`r=sqrt(ln(2/.05)/(2n))`。

在 score=.5 的工具計算比較：舊 N=203,n=50 的決策 score 全寬 .3646530443、Elo ±132.804518；新 look 1 N=153,n=50 為 .3451743029、±125.061139；look 2 合併 N=153,n=100 為 .1758748212、±61.747163。普通95% Hoeffding n=50（不論 N）全寬 .3841291165、Elo ±140.674773；n=100 為 .2716203031、±96.799849。這些是公式區間寬度，不是未來 WDL 或結果預測。

資料與 SHA：`manifest.json` 記錄 eligible、selected、runner TSV、選樣 protocol 的原始 SHA-256；`remaining-153.jsonl` 是僅供本規則的差集，SHA-256 `2e429c377eebd47abad175d2ae726130cf2f2060b5fe0ce02bb458d7d46848ce`。驗證來源及上游 CCPD revision 見 `docs/research/m4-openings/README.md`。舊提案與公式修正歷史保留於 `protocol-proposal-v0.md`、`erratum.md`。
