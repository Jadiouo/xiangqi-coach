# M5 勝率 k 校準純工具

本目錄只提供可重現的純 Python 分組、去重、log-loss 與 k 搜尋函式。它不讀檔、不呼叫引擎、不產生亂數，也不驗證逐步棋規或 UCI raw；呼叫端須先完成真實對局與原始紀錄審核。這裡不產生「正式驗收收據」，合成測試不能替代 TEST_PLAN §6.1.5 的至少 2000 盤門檻。

## 規格依據與開局群組查核

- `docs/SPEC.md` §8.1：`p = 1 / (1 + exp(-cp/k))`，未校正基準 `k=300`，殺棋勝率另列 100%／0%。
- `docs/TEST_PLAN.md` §6.1.5：至少 2000 盤，校正後須以對數損失優於 k=300；此工具本身不宣稱通過。
- `docs/research/m4-openings/eligible-population.jsonl` SHA-256 `5e5d3595f9f08ad9fc10fe791de31454e73c726501cdc0c33d2a7c31a777e86e`；203 列、128 個不同 `source_pgn_sha256`。以列中的 `position_key`（盤面與行棋方）連接共享位置的來源 PGN 後為 128 個連通群，跨來源共享鍵 0 個。分組時仍先做連通分量 union，避免未來不同資料集出現洩漏。

分割以連通群為單位，對 `salt + 排序後來源 SHA` 做 SHA-256，依 digest 值與 `train_fraction` 分成 train／heldout。同一 salt 與輸入必定得到相同結果；資料與分割比例變動時必須重算並記錄，不可將此未凍結的 salt 當正式抽樣 seed。

## 呼叫資料形狀

- 開局列：`source_pgn_sha256`、`position_key`。
- 對局列：`starting_fen`（完整 FEN）、`iccs_moves`（完整走序）、可帶 `seed` 與 `split`。去重鍵不含 seed；相同走序若跨 train／heldout 即丟出錯誤。
- 分析樣本：`game_id`、`cp`、`perspective`（red/black）、`outcome`（red_win/black_win/draw）。cp 與結果都依 perspective 解讀；draw 的目標分數為 0.5。每局先平均自己的分析點 loss，再對棋局等權平均。mate 樣本拒絕進入 k 擬合；`separate_mate_summary` 將 mate 預測（`mate: win/loss`）另以二元標籤統計，實際勝為 1，和或負為 0。

預設搜尋網格為正 k 的 10 至 10000 對數間隔點，另明確包含 300。只以 train 的等權 log-loss 選 k；heldout 只比較已選 k 與 300，輸出改善或未改善及是否命中網格邊界。heldout 結果不會回頭改 k。

## 執行測試

在 repo 根目錄執行：

```sh
PYTHONPATH=scripts/m5/calibration python3 -m unittest discover -s scripts/m5/calibration/tests -v
```

這些測試只驗證數學、資料分割/去重與合成資料行為，不是 2000 盤驗收，也不涵蓋正式 source/raw/Game replay 審核。
