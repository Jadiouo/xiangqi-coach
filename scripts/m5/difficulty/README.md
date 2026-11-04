# M5 十級難度對打工具

此工具只提供可重現的單一級距配對、UCI 原始紀錄檢查與棋局重播。SPEC §6.3 說明難度由搜尋節點上限、評估雜訊及候選著選擇組成；TEST_PLAN §5.3 第 3 項要求每個 `n+2` 對 `n` 級距的較高級勝率至少 65%。專案負責人另預先定義本工具的驗收分母為每組 50 個開局、各由兩種顏色下棋，共 100 局；和棋不算勝，故門檻為 `W / N >= 0.65`。這是本次驗收口徑，不是原規格已寫的局數或和棋算法。

`run` 一次只跑一組相差兩級的配對。pilot 可用事前固定的 1–50 個開局子集；`--pilot-count` 必須等於所提供 TSV/JSONL 的列數。即使 pilot 用滿 50 個開局，summary 與 audit 仍固定回報 `formal_gate_eligible=false`、`passed=false`。final 則必須恰為 50 局面、雙色共 100 局；1v3 到 8v10 各跑一次。final 另須提供 pilot 開局 JSONL，工具會拒絕重疊的來源 PGN SHA 群。每個引擎固定 Strategy=difficulty、MultiPV=1，並開啟 RootAlpha、CheckExtensions、KillerHistoryOrdering；兩側使用同一個引擎命令。這是目前產品已採納的唯一正式搜尋選項組合。`freeze-final` 會實際啟動候選執行檔完成 UCI handshake，核對必要選項與預設值，並拒絕仍宣告已撤回的 NullMove 或 LateMoveReductions。先前研究 profile 若要求這兩個選項，與目前產品不相容，不能直接套用。caller 固定每步 100,000 nodes、4096 ply 上限、4 workers、30 秒 UCI timeout。每局先由 master seed、含 run kind 的 game ID、引擎代號派生 game seed；每一步再由 game seed 和絕對 ply 派生 RandomSeed，因此 pilot 與 final 不會共用相同 game/seed identity，亂數輸入也不依賴 worker 排程。raw、逐局 manifest 與 summary 都綁定 run kind、級距、seed scheme、來源開局集 hash；audit 會核對三者一致。

`audit` 會檢查完整遊戲 ID、級距、來源、前綴、每步 seed、每次 `go` 當下生效的 UCI 設定與走法，並呼叫 `scripts/m5/audit.py` 的 pinned xq-core Game 重播器核對合法性與終局。只有 50 組開局各完成兩色的 100 局才具備正式門檻資格；不完整局、錯誤、終局未知或 raw 紀錄缺失都會拒絕。這些工具測試不代表難度級距已校準，也不代表 65% 門檻通過。

命令列入口：

```bash
PYTHONPATH=scripts/m5/difficulty python3 -m scripts.m5.difficulty.cli run \
  --engine /immutable/path/xq-uci --openings-tsv selected-50.tsv \
  --opening-jsonl selected-50.jsonl --lower-level 1 --run-kind pilot --pilot-count 2 \
  --output /new/run/path --master-seed 1

PYTHONPATH=scripts/m5/difficulty python3 -m scripts.m5.difficulty.cli audit \
  --run /completed/run/path --openings-tsv selected-subset.tsv \
  --opening-jsonl selected-subset.jsonl
```

TDD補強歷程：`24c3b9c` 的 red 只驗證原排程器沒有把 run kind 納入 raw identity，並未覆蓋「將完整 pilot rows/raw 改標 final」的 game-id/seed 洗白缺口。獨立審查反例後，新增測試 `5fe081e` 實際 red：pilot 與 final 對同局面產生相同 game ID；`7407925` 將 run kind 寫入 game ID，因而改變 game seed 與逐著 seed，並加入 50 開局重標負例。

另一個 manifest 升格反例由 `9f06b4a` 的 100 局合成測試實際重現為紅：只把 pilot 的逐局 `run_kind` 留在原值、將 manifest/summary 改成 final，舊 audit 仍回報正式資格。`4c7c47f` 修正後，audit 以 manifest 的 run kind 驗證每列、seed 身分及 raw batch context；同一個外部重現腳本現於 `audit_run_directory` 因模式不一致而拒絕（exit 1）。審查腳本執行記錄見 `/tmp/m5-pilot-run-kind-audit-repro-4c7/`。

本次只執行合成兩局測試並以 pinned xq-core Game 重播，沒有抽取正式開局、啟動 UCI 對局、調整 profile 或宣稱任何級距通過。正式驗收仍須事前凍結八個級距共用的 10 級 profile、來源、binary、設定與時間順序；pilot/final 開局及來源 PGN 群須隔離，正式執行計畫仍待建立與審查。


正式凍結流程分成兩步：`freeze-final` 只核對候選來源與工作樹、十級產品 profile、固定的 203/50 開局 bytes、目前產品 UCI 選項，以及執行檔實際回覆的 handshake，並建立凍結檔；這一步不抽樣、不取 OS entropy。只有之後的 `select-final` 才讀取 256-bit OS entropy，並在共用 Git metadata 以排除時間戳與輸出路徑的候選身分執行唯一登記。選樣會排除與 pilot 共用來源 PGN 或位置 component 的列；凍結來源預期剩 124 列、83 個 component，再抽固定順序 50 列。輸出存在時拒絕覆寫。

`binary_build_source_head` 是呼叫者提供的來源宣告，工具不把它當作 binary 來源的獨立證明。正式使用前仍須獨立重建或用已審 build receipt 核對執行檔與來源。每個正式 pair 的 manifest 和 worker raw context 都綁定同一 freeze/selection；`audit-series` 會重播 1v3 至 8v10 八組，檢查共用選樣、每組 100 局、完整合法終局與 raw 設定，再以較高級勝局數除以 100 檢查 65% 門檻。工具測試與 preflight 不代表對局完成或級距通過。

正式前置命令範例：

```bash
PYTHONPATH=scripts/m5/difficulty:scripts python3 -m scripts.m5.difficulty.cli freeze-final \
  --source-repo /candidate/checkout --binary /immutable/xq-uci \
  --profile /candidate/checkout/crates/xq-engine/src/difficulty.rs \
  --eligible /candidate/checkout/docs/research/m4-openings/eligible-population.jsonl \
  --pilot /candidate/checkout/docs/research/m4-openings/selected-50.jsonl \
  --master-seed 1 --freeze-time 2026-10-07T00:00:00Z \
  --binary-build-source-head <declared-source-head> --output /new/final-freeze.json

PYTHONPATH=scripts/m5/difficulty:scripts python3 -m scripts.m5.difficulty.cli select-final \
  --freeze /frozen/final-freeze.json --output-dir /new/selection-dir

PYTHONPATH=scripts/m5/difficulty python3 -m scripts.m5.difficulty.cli audit-series \
  --final-freeze /frozen/final-freeze.json --final-selection /frozen/selection.json \
  --batch-root /completed/eight-pairs
```

## 實際 difficulty pipeline 來源釘選

`freeze-final` 產生的 freeze v2 除了產品 source/build identity 外，還記錄實際載入的 `final_contract.py` 所在 checkout、該 checkout 的 HEAD 與 HEAD tree SHA、工作樹狀態／diff SHA、未追蹤檔案 SHA，以及 runner、CLI、UCI helper、population selector 與可信 Game/raw auditor 的直接來源檔 SHA。這個 pipeline identity 與產品 source identity 分開保存，因為兩者可以來自不同 checkout。`select-final`、final `run`、`audit` 及 `audit-series` 會在使用 freeze 時重新讀取實際 caller checkout 和 pinned files；缺少 pipeline pin 的 v1 freeze 不接受升格。Run manifest 綁定 freeze/selection identity，raw context 綁定 run identity。這是來源對照，不是簽章或對任意竄改的防護系統；`binary_build_source_head` 仍須以獨立 build 或已審 build receipt核實。
