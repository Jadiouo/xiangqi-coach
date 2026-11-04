# M5 正式對打工具

`m5.py` 是入口：`verify-lock` 驗證凍結候選；`sample` 對該候選呼叫既有 M4 153 局 sampler 並寫 M5 sidecar；`audit` 重驗完成的 look；`combine` 重播兩個 audit 並套兩-look決策。`protocol.py` 提供嚴格凍結候選鎖、抽樣 sidecar 綁定、look 2 授權與兩-look統計。正式 UCI keys 為 `RootAlpha`、`CheckExtensions`、`KillerHistoryOrdering`、`NullMove`、`LateMoveReductions`；內部 profile alias `kh`、`nullmove`、`lmr` 分別映射至後三者。baseline 固定為已接受的 RootAlpha + CheckExtensions，KH、NullMove、LMR 皆為 false。每個 candidate lock 只允許其目標 UCI key 改為 true，並鎖定 common option `MultiPV=1`；此 common option 會明確 setoption 到 A/B 兩側。

流程：先在乾淨 source checkout 建 tracked config、immutable binary 和 candidate lock；`verify_lock()` 檢查 HEAD、工作樹、tracked config hash、binary hash 和 flags。然後由 `scripts/m4/future_openings.py generate` 對該 lock 抽樣；`bind_selection()` 將 sampler manifest 與 ordered-100 hash 再綁到 M5 candidate ID/lock，避免跨候選或對調 sample。look 1 用前 50 開局兩色各兩輪。look 2 必須有相同 candidate/sample 的完整 look 1 audit receipt，且 receipt 顯示 200 局完成、0 unfinished、0 error、Game/raw replay 成功，97.5%決策區間跨 .5。Game 重播器不接受呼叫端執行檔；每次由固定 main `324373fdf5645db622fd258b12a3fcb0af3cb4ff` 的乾淨 git archive 加入 SHA 固定的 replayer source 後以 `cargo --locked` 建置，再執行驗局。

統計單位為每個開局 cluster；兩色與兩輪先合為該開局單一分數。look 2 合併前後兩組不同的 50 cluster，n=100、N=153。每 look 決策區間使用 alpha=.025 Hoeffding–Serfling；另外報普通 95% Hoeffding，沒有有限母體修正。只有 0 error、0 unfinished 且逐局 Game/raw replay 有效才可形成棋力結論；look 2 合併區間下界大於 .5 留用、上界小於 .5 淘汰，跨 .5 淘汰為未證實。

M4 `match.py` 只增加具名 `--m5-profile kh|nullmove|lmr` 路由；舊 composite 路由的 flags、pins 與採納條件保持原樣。M5 auditor 透過共享 runner 啟動/逐局資料驗證、raw trace parser 與 `xq-core::Game` replay，不調用 M4 五批聚合器。此工作僅用臨時合成來源和 mock 引擎整合，沒有抽取真實正式樣本或啟動正式棋力賽。
