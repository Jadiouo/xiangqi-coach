# M4 開局候選批次 v2

本資料是 M4 開局選樣的可重現工作證據。203 筆合格母體已排序並以預定 seed 無放回抽取 50 局；獨立評分審查已通過，抽樣結果待另一位審查者重現後再合併。原始 checkpoint 逐列保存了 707 個唯一局面的評分；manifest 的 hash 可用來驗證檔案完整性。

## 來源與授權

來源為 Yu-Han Tseng、Bo-Nian Chen（2026），[Chinese Chess Practical Dataset（CCPD）](https://github.com/Yvonne761/Chinese-Chess-Practical-Dataset)，上游 README 標示 CC BY 4.0。來源 revision 為 `368a47a947773dd8692c026e286dd19b6277b993`。本次將 Big5 棋譜轉成 UTF-8、逐手以本專案 core 重播、截取合法第 4–8 ply 局面、以盤面與行棋方去重，並保存來源標籤及原始 PGN SHA-256。此目錄沒有複製完整 PGN 資料集。

## 候選解析

961 個來源檔得到 4,645 個 cutoff 列、707 個唯一盤面與行棋方組合、3,938 個重複列。拒絕事件共 74 列：非標準起始 FEN 24、無效來源 FEN 5、合法步數不足 40、合法前綴後解析錯誤 4、來源在終局後續走 1。前五個 cutoff 的唯一數分別是 80、107、132、175、213；這些數字不是互斥母體。

## 外部均衡評分

使用官方 Pikafish 2026-09-06 執行檔（SHA-256 `727828293830de8082a80b224bf47b32700c2d1a441908ea11b3c9197178c20c`）與 NNUE（SHA-256 `7d13d73569a9b571ba0eb20cf1596247bc2a42738967e61afef6482b231e900e`）。固定 Threads=1、Hash=64 MiB、MultiPV=1，每個局面 `ucinewgame` 並清空 hash，按真實行棋方 `go nodes 100000`。本次有 203 個最終完整迭代 exact cp 在 ±100 內，1 個超出門檻，503 個最終分數為 bound 而保留 unknown；沒有引擎拒絕根局面的情況。這是固定搜尋條件下的操作性篩選，不代表數學上的均勢。

批次於 2026-10-07 07:25:35–07:28:58（台北時間）完成，約 203.344 秒。Sol 在固定 HEAD `f184e93` 獨立重讀 707 份 UCI transcript，確認 hash、FEN、清 hash、節點設定、最終分數與 PV/bestmove 一致；203 個合格、1 個超門檻、503 個 unknown，均與檔案相符。每筆 raw transcript 的 hash 與評分保存在 `batch-v2/reference-scores.jsonl`；原始 transcript 合併保存在 `batch-v2/raw-logs.tar.gz`。評分檔封裝副本只把 tmp 絕對環境下的 raw log 路徑正規化為 archive 內相對路徑；原始 `/tmp` 評分檔 hash 記在 manifest。

按固定程序，eligible 先按 `position_key` 升序保存成 `eligible-population.jsonl`（203 筆，SHA-256 `5e5d3595f9f08ad9fc10fe791de31454e73c726501cdc0c33d2a7c31a777e86e`），再以 seed `1328726801112436425`、Python 3.12.3 `random.Random(seed).sample(population, 50)` 抽樣。選出的 50 筆 JSONL SHA-256 為 `09225f85a6b906aa66baa0aa095c4b4b88f7aa420e63cded286ab92988ddbcee`；match runner TSV SHA-256 為 `2052a3f47ad38b5b2d7dc72004ea21faccc62df8a3dfccb0ce0f86a2fdf4cf88`。樣本含 32 種 ECCO，cutoff ply 4–8 均有覆蓋，紅方行棋 30 局、黑方 20 局。seed 時序只由 protocol 自述記錄，沒有外部時間戳證明；抽樣前未跑本專案對打。

## 檔案

- `opening-selection-protocol.json`：抽樣前以 OS entropy 固定的 64-bit seed、排序方式與抽樣程序。只可使用一次既定 seed。
- `eligible-population.jsonl`：以分數最終值、PV/bestmove、根合法步與 ±100 cp gate 驗證後的排序母體。
- `selected-50.jsonl`：固定 seed 抽出的 50 局與完整來源/外部驗證資料。
- `selected-50.tsv`：交給對打 runner 的 ID、來源 URL 與 ICCS prefix。
- `batch-v2/candidates.jsonl`：全部候選列與來源、重播、去重資料。
- `batch-v2/reference-scores.jsonl`：707 個唯一局面的評分；unknown 保持空分數。
- `batch-v2/raw-logs.tar.gz`：707 個逐局 UCI transcript 與一份 engine session transcript。
- `batch-v2/manifest.json`：revision、工具條件、統計、原始結果摘要及封裝檔案 SHA-256。
