# 棋力紀錄

用途：記錄引擎版本對打結果。注意：本公開版不含開發紀錄與原始對打證據檔，文中提到「未公開」之處即指這些檔案；棋力數字與量測方法照原樣保留。此處列出已完成且可追溯的 M4 候選 A/B；候選去留待預註冊兩-look 決策完成。

## CheckExtensions search-v-search（首 look，2026-10-07）

固定執行檔 SHA-256 `38de162c2695893047fc2944c4adf040edc4333e5ead6a77d5a78856deaa09f9`；A 為候選 `CheckExtensions=true`，B 為基線 `false`。雙方同一執行檔，50 個凍結開局、global rounds 1–2、每步 10,000 nodes、master seed 1、max-ply 4096。200/200 局完成，未完成 0，協定錯誤 0；W/D/L（皆以 A 計）82/56/62，score mean 0.55，Elo 點估 +34.8601。有效 opening clusters n=50。

95% 報告區間分兩種方法標示：runner `summary.json` 的 ordinary Hoeffding score interval `[0.35793544, 0.74206456]`（Elo `[-101.5096, 183.5723]`）；另由獨立稽核計算的有限母體 95% Serfling score interval `[0.38271401, 0.71728599]`。預註冊去留只看每-look 97.5% 有限母體 Hoeffding–Serfling 決策區間 `[0.36767348, 0.73232652]`（Elo `[-94.19164, 174.83977]`），N=203、n=50、rho=1−49/203；該區間跨 0.5，依規則進入第二 look。不可把 runner 的普通 95% Hoeffding 欄位誤稱為有限母體 Serfling，也不可將第二批逐盤重現局算成更大的獨立樣本或縮窄區間。

獨立重播核對 200/200 局合法且終局一致，所有決策 seed、固定 opening/source/prefix 與設定匹配，round 1–2 的同開局／顏色結果完全一致。獨立審查者 稽核說明及逐盤重播工具輸出在 repo 外 `/tmp/xiangqi-coach-m4-formal-audit/README.md` 與 `result.json`；`result.json` SHA-256 `b4762e38b62c123766922e4cd06bc8f626e1dfaf7fb88876adb83d447c969f94`。首輪原始資料在 repo 外 `/tmp/xiangqi-coach-m4-check-extensions-rounds1-2/a-candidate-38de162c/`：`games.jsonl` SHA-256 `dc24f45113b5203a04dc2d6bbd195c52809a98ece3c29bc7dedd584f28e66b88`，`run-manifest.json` `6c61c36f00ef2d1ac55e668905c3a5b2a75184ec0cac21b02772b95949fccf75`，`summary.json` `19372732e81a67a5b07300de37b54b240c59659cadcb9f0c237efa3b59007dc9`，A raw `b8b5e98becf1dcb7365d5fdfa6e1b6e1617216571a49c35a486d85bc0f33b21b`，B raw `42a4b9661e2c56bf4ea4cb511a33b0b24799dbd23419d273b19588f758df1ddc`。

第二 look（若執行）固定為同一不可變執行檔、選項、50 開局、顏色、seed、節點與 max-ply，僅採 global rounds 3–4；其用途是確認決定性重現，opening cluster n 仍為 50。最終去留依 開發紀錄（未公開） 的事前規則，不能將其稱為新增獨立棋力證據。

## MoveHints search-v-search（預註冊）

候選 A=`MoveHints=true, CheckExtensions=false`；基線 B=`MoveHints=false, CheckExtensions=false`。兩側用同一個immutable binary，其他搜尋設定使用預設（KingSafety off），50個凍結開局、每步10,000 nodes、master seed1、max-ply4096、look1為rounds1–2共200局。決策統計沿用同一opening-cluster 95%報告與97.5%有限母體Hoeffding–Serfling兩-look protocol；如首look跨0.5才跑rounds3–4，第二look僅驗逐盤重現，n仍50。實際首look已完成但未達採納門檻；成績與稽核見下節，第二look須等新runner workers=4和auditor通過後再啟。

## CheckExtensions search-v-search（完整兩 look，2026-10-07）

第二 look rounds 3–4 在獨立輸出完成200/200；同首 look 共400盤、50個 opening clusters。獨立審查者獨立以 `xq-core::Game` 重播400/400合法且終局吻合，raw UCI decisions 62,648 筆零錯，同opening/color四輪逐著與結果完全重現。候選 A W/D/L 164/112/124，score .55，Elo點估 +34.8601。決策仍採每look預註冊97.5%有限母體Hoeffding–Serfling `[.36767348,.73232652]`；區間跨0.5，故依第二look規則**回退／不採納 CheckExtensions**。重跑只確認確定性，不增加有效樣本，n=50。普通runner 95% Hoeffding `[.35793544,.74206456]` 僅為報告欄位，不可與97.5%有限母體決策區間混稱。

首look稽核仍見 （原始證據檔未公開）。完整兩look套件與 aborted 原始65筆（僅供事故追溯，完全排除統計）、retry1五檔raw、凍結開局輸入及獨立審查者 auditor/readout封存於 `check-extensions-look2-artifacts.tar.gz`；SHA-256 `bfed66b8c491073e5a0a9b08cb411e42489e93f7ce1bc650e6ed20bf45d6a4bc`，成員hash清單 `check-extensions-look2-artifacts.sha256.json`。獨立審查者審計JSON SHA `0d8d81917e4e5158d4524b553ef730caa71d93e8be51d5eff5e37337eca046ed`。第一次rounds3–4的durable session曾exit143、只留65筆且沒有summary；成因未知，標記aborted，不與retry併盤。retry1的games JSONL SHA `954848db20e10d6c81f63884afb01d260ef8b3eb419078c048d96e09bfec4f0e`，exit status為0。所有archive均不含引擎binary/NNUE/cache。

## MoveHints search-v-search（look 1，2026-10-07）

固定A=`MoveHints=true, CheckExtensions=false`、B兩者皆false、同一immutable binary及凍結50開局、每步10,000 nodes、seed1、max-ply4096、rounds1–2。200/200完成，無unfinished或protocol errors。獨立審查者獨立重播200/200，31,242筆UCI decision與seed/position/bestmove一致，兩round同opening/color完全重現。A W/D/L 72/64/64，score .52；普通95% Hoeffding `[.32793544,.71206456]`，預註冊97.5%有限母體Serfling `[.33767348,.70232652]`跨0.5；因此依規則等待第二look，首輪尚不可採納。完整封存 `move-hints-look1-artifacts.tar.gz` SHA-256 `e6f0e95584a25342f9edf5353570c8a0e51fb4cf7bbfd58cde670b73e2bc74ca`，成員hash `move-hints-look1-artifacts.sha256.json`；獨立審查者 result JSON SHA `a773f4397e81f495e3911130f33d226da0d0b9f58d2286210aa2db5da00edc77`。

第二look固定上述binary/settings，僅使用workers4及rounds3–4；200/200正常完成。兩look共400/400 Game重播、每批31,242 raw UCI decisions零錯、四輪每個opening/color逐著相同。A W/D/L 144/128/128、score .52、有效cluster n=50；普通95% Hoeffding `[.32793544,.71206456]`，正式97.5%有限母體Hoeffding–Serfling `[.33767348,.70232652]`跨0.5。依預註冊回退MoveHints；最終main須排除搜尋路徑與UCI option，研究分支及raw可以保留。第二look raw/audit、錯誤exit路徑與prereg SHA erratum封存及各hash見（原始證據檔未公開）。M4固定30題產品gate目前仍未通過。

## RootAlpha diagnostics（非棋力採納結果）

固定凍結30題×100,000 nodes診斷為25/30；四組搜尋配置矩陣為25/30、25/30、30/30、30/30，但達30/30的組合含CheckExtensions，故不能作RootAlpha單項棋力證據。五題depth5/1,000,000 nodes診斷只有三題在該次搜尋中回預期著及mate3，另兩題在上限時仍為depth4 cp、無PV，屬未知。完整來源與hash見（原始證據檔未公開）及其封存包；以上不取代產品100k驗收，也不改門檻。

## RootAlpha search-v-search（look 1，2026-10-07）

候選 A `RootAlpha=true`，基線 B=false；兩側 `MoveHints=false, CheckExtensions=false`，共用不可變binary SHA `d8d1a741548101e160156761a8b952b10604df5366e49be0b0fd7f31d600145d`。固定50個開局、每步10,000 nodes、seed1、max-ply4096、rounds1–2，共200局。獨立審查者獨立以Game重播200/200，30,114筆raw UCI決策/seed/config零錯，兩輪逐著與終局相同。A W/D/L 108/52/40，score .67、n=50；正式97.5%有限母體Hoeffding–Serfling區間`[.487673,.852327]`仍跨0.5，故依預註冊規則進行第二look；候選尚未採納。此數據與診斷30題25/30分開，兩者皆未通過M4產品gate。完整封存與原始資料hash見（原始證據檔未公開）。第二look已用workers=4的核准parallel runner啟動，僅排程workers與runner source改變，設定和n=50不變；當前狀態見開發進度紀錄（未公開）。

## RootAlpha search-v-search（完整兩 look，2026-10-07）

look1+look2共400/400 Game replay，兩批各30,114 raw UCI decisions零錯，四round每個opening/color逐著與終局完全重現。A W/D/L 216/104/80、score .67、有效cluster n=50；普通95% Hoeffding `[.47793544,.86206456]`，正式97.5%有限母體Hoeffding–Serfling `[.48767348,.85232652]`仍跨0.5，依預註冊規則回退RootAlpha。最終main須移除搜尋路徑與UCI option，研究分支與raw可保留；不以點估、30題25/30診斷或1M探測改變門檻。完整追溯見（原始證據檔未公開）；M4 frozen30產品gate仍未完成。

## 搜尋節點分類診斷（非 strength 結果）

兩個隔離 profile 在 CCPD17/54、1M nodes/max-depth 5 上記錄 root phase 與 q-node 分類；固定 source/binary、數值與有限的 獨立審查者 review 範圍見 （原始證據檔未公開）。分類加總在被核查的兩題上相符，但 q-node 數不證明逃將是瓶頸。QCaptureOrder 是獨立候選，需看下節單獨紀錄。這些診斷資料不是棋力改動、M4 gate 或 RootAlpha 採納證據；frozen30 每題 100k 的正式上限保持不變。

## QCaptureOrder 候選（正式 A/B 啟動前取消；棋力未判定）

引擎候選 `QCaptureOrder` 以預設關閉暴露非將軍 qsearch 捕獲排序。單一固定位置的真 UCI on/off 確會改排序與節點數（12,862/12,861），但 bestmove/score 相同；frozen30 每題100k兩側同為24/30且30題逐項結果一致。review在正式 search A/B 啟動前取消該實驗；因此棋力未測、未判定，不能描述成完成實驗後確認無提升。Q 僅留研究用途；凍結30題答案與門檻未變。來源、原始功能點驗與 SHA 更正見 （原始證據檔未公開）。


## QCaptureOrder（正式對打取消，未判定棋力）

QCaptureOrder binary 在單一合法局面確實改變 qsearch 捕獲排序，關閉/開啟節點數為 12,862/12,861，但 bestmove 與 score 相同；凍結30題100k診斷兩側均24/30且逐題輸出相同。依 review 在正式對打啟動前取消200局/兩-look計畫。故棋力狀態是未執行、未判定，不能寫成候選已證實無效或已通過。Q 僅供研究使用，不進最終產品搜尋設定；30題答案與100k門檻未變。原預註冊草案原 bytes 與取消通知位於 `/tmp/xiangqi-coach-m4-q-capture-preregistration/archive/`，hash與狀態見 （原始證據檔未公開）。

## QCaptureOrder 與 KillerMoves 封存結案（2026-10-07）

QCaptureOrder 的正式 A/B 在啟動前取消，棋力狀態為未執行／未判定；既有單題排序行為點驗與 frozen30 24/30 off/on 同結果都不能當作棋力否定或採納。KillerMoves screen off/on 都是24/30，原六個失敗仍全失敗，因此依預註冊 screen 停止並撤回候選；沒有正式棋力 A/B。獨立審查者 另以同 SHA 執行檔做獨立重現，確認60組逐題輸出一致，並核對負 mate score TT on/off 為 -29996；這是獨立重現，不是原 screen 的 stdout。原 screen harness 未保留逐引擎原始 stdout bytes，未補造或重跑。兩項候選皆不進最終搜尋配置，M4 frozen30 gate 仍未通過。封存檔、各成員 SHA 與來源 commit/patch 見 [`closed-candidates/README.md`](research/m4-validation/closed-candidates/README.md)；Q archive SHA-256 `c78514d643ce594008ef23c8512c7ce421255b93966a7a2db0c48a4982bca263`，K archive SHA-256 `161fa9cca337c160754f3dceaa7532730d1b14bbc981c1e939b7f7e8a6afa478`。封存不含任何 research executable、權重或 cache。

## Random / greedy 凍結基準 gate（不是 strength A/B；2026-10-07）

固定 source HEAD `9b9f5e34d36aca7fd6f321f1bad8694d283f6fab`，唯一 immutable binary SHA-256 `f5a8df0fdd622566562f8a34f86105d1d2dd6cd960022dc9cb2a9fb75a439c71`，兩側 `QCaptureOrder=false` 且不送已移除候選選項；50個凍結開局、每步10,000 nodes、seed1、max-ply4096，五批各200局覆蓋rounds1–10。獨立審查者 final audit重播2,000/2,000局與raw通訊、seed、input、唯一ID及設定，錯誤0。Random W/D/L=1000/0/0，達「1000局全勝」gate；greedy W/D/L=1000/0/0，達「至少980勝」gate。Greedy同opening/color十輪moves與結果完全重複，不能把重播局當作獨立棋力樣本；本基準gate不計新strength CI，也沒有候選對打採納決策。只對上述immutable配置有效，後續產品碼變更須重跑。完整原始證據與審核包見 [`closed-candidates/baseline-gates-artifacts.tar.gz`](research/m4-validation/closed-candidates/baseline-gates-artifacts.tar.gz)，SHA-256 `a076011eb9440857e45e9ae5dbe38c68096f7e0cf2dcddba361047914cc89b33`，241成員逐檔sha見同目錄 sidecar。雖基準兩項通過，frozen30仍24/30，M4整體尚未完成；TT修復仍待使用者驗收規則回覆。

## 2026-10-07：TT fail-low 正確性修復

這不是搜尋棋力候選。私人合法局面的窄窗 fail-low `-75` 被錯當 exact，造成後續全窗查表結果不同於無 TT 的 `-76`；僅修正 exact-only TT 的寫入條件。固定 binary 的 200 局 correctness non-regression 結果 score 0.5（A 68 勝、64 和、68 負），高於事前 0.45 correctness 門檻；不代表棋力改善。TT 版凍結 30 題仍 24/30，M4 tactic gate 未通過。沒有已驗證公開實戰錯著；此項是私有 runtime correctness 反例，不將其宣稱為公開棋力 bug。

## RootAlpha + CheckExtensions 組合 search-v-search（look1，2026-10-07）

Root 已採納本組合 A（RootAlpha、CheckExtensions皆開）相對於兩者皆關的 B。單獨的 CE/MH/RA 舊實驗仍維持各自原結論；此實驗只支持此一組合。使用同一 immutable binary SHA `2ee963e53eae374c93725021873949f338df6cc2d229325e3846c62ccf08b426`、50個預先選定 opening、兩色配對、200局完整，A W/D/L=126/46/28，opening-cluster mean=.745、n=50（有限母體 N=153）。普通95% Hoeffding `[.5529354417360158,.9370645582639842]`；事前決策97.5% finite-population Hoeffding–Serfling `[.5724128485749912,.9175871514250088]`，下界高於.5，依規則停止於look1且不跑look2。seed `14702840600016189386` 對ordered100無放回樣本固定；只執行首50組，後50未跑。採納不代表M4整體驗收：M4 final defaults/integration、更新固定測試、完整 `make check` 與遠端CI尚未完成。完整資料與限制見（原始證據檔未公開）。

## M4 最終配置 gate（2026-10-07，c96 immutable）

最終產品預設採 RootAlpha+CheckExtensions 組合。其棋力採納證據只有固定 N=153 母體抽出的 n=50 look1：A（兩者皆開）對 B（兩者皆關）W/D/L=126/46/28，score .745，預註冊 97.5% 有限母體 Hoeffding–Serfling `[.5724128485749912,.9175871514250088]` 下界高於 .5；依規則不跑 look2。此結果僅支持組合，CE／RA 單項已否決的歷史結論不變。

在產品來源 HEAD `2c2bda2b267e066d3872628b26f4e433ca5c8554`、immutable xq-uci SHA-256 `c96ecda8daacaf7f863b6dacb9e06e654fd6bd1ab65e8b330d68727261d4313b` 上，凍結30題、每題100k的最終預設測試30/30通過。新配置 random 對局1000/1000全勝；greedy對局1000/1000全勝，達至少980勝門檻。兩者是基準 gate，不是 search-v-search 棋力證據或可外推的勝率/Elo；摘要的通用Elo/CI欄不作 gate 判定。這兩項只適用 c96 最終設定；f5 歷史基準不代替它們。

固定最終交付 HEAD `7aeac1165378e161a843de92ca1d375ec4f66f77` 執行 `CARGO_BUILD_JOBS=2 make check`，exit 0。workspace 中 frozen30 測試1/1（458.08秒）、UCI protocol 15/15、performance equivalence 1/1；fmt、clippy、release perft4、WASM、web Vitest/build、M0 Python 9項均通過。另有同 HEAD 的 M4 Python 121項與 openings CLI 8項獨立綠測，這些不是 `make check` 子步驟。外接 Cute Chess TP5.5.6 實盤1局以30個合法 ply 終於黑方將死，與 xq-core outcome 重播相符；此為 UCI 互通檢查，不計棋力。完整來源和逐檔證據封存見 [`final-gates-v1`](research/m4-validation/final-gates-v1/README.md)，archive SHA-256 `e68a087cbdf70ab81ee27fb0a2ee5444245dea559c6d098c96a6734906cff15a`。遠端 CI 未執行；此處記錄 M4 本機驗收 gate，不代表整個專案完成。

## 2026-10-08：M5 勝率 k 校正（唯一 heldout 比較，未採納）

依 `docs/TEST_PLAN.md` §6.1(5)，唯一固定 heldout 比較共 600 局。fitted k=`280.2205621666746`，log loss=`0.6087998267946423`；baseline k=`300`，log loss=`0.6079080700127212`，差值 fitted−baseline=`+0.0008917567819211`。compare receipt 正式狀態為 `not_improved`，runner、audit、compare 真實 exit code 均為 0、compare stderr 空；資料與收據細節見 `.codex/evidence/m5-heldout-audit/REPORT.md`、`COMPARE-REPORT.md` 及同目錄 receipts。比較唯一性已消耗，禁止再比、fit、調參或重跑；本次校正不採納，產品預設仍為 k=300。此為校正負結果，不是棋力 A/B 結論。

## M5 LMR 兩-look結果與產品撤回（2026-10-07）

固定候選兩輪合計400局，獨立 Game/raw 審查結果 W/D/L=158/86/156，平均得分.5025，N=153、n=100的97.5%有限母體 Hoeffding–Serfling 區間`[.414562589423862,.5904374105761379]`跨.5，依預註冊規則不進第三輪，判為 `discard_inconclusive`。這不能證明一般 LMR 無效；因未通過採納門檻，最終產品已移除 LMR 搜尋分支與 UCI 選項，歷史 branch、protocol與原始實驗記錄保留。審查JSON `/tmp/xiangqi-m5-lmr-v2-two-look-independent-review.json` SHA-256 `9346d1187a8476c8ef26477c34eee7142fabeb70f7d4094216a6f266adc50380`。移除後仍以新產品設定重跑 frozen30 @100k 為30/30；此功能gate不是棋力採納證據。M5整體尚未完成。

## 2026-10-15：M5 整合不退步閘門正式通過

對象為整合分支 `integration/m5-product-main` 的產品設定（KH+RootAlpha+CheckExtensions），對上一保留版本，TEST_PLAN §5.3.4 不退步門檻 0.45。

- 結果：200 局，A W/D/L=88/54/58，score 0.575（門檻 0.45），稽核 verdict accepted、status complete；replayed_games 200、raw_decisions 31072、replay_binary_sha256 `d0cac8fb…2c22`。收據 `.scratch/m5-main-gates/v4-launchers/integration-nonregression/audit-result.json`。
- 過程：10-09 的 v2 稽核兩次被拒，原因都是稽核工具缺陷（replay 檔 chmod 0444 缺執行位元；`_verify_summary` 在錯的檔案找 strategy 欄位），非引擎問題。工具修正在 `tools/m5-integration-audit` 分支，不在產品樹（`7b9d3a5`、`9e408e6`、`8ca76e5`）。因收據綁定 plan-v2，改立 plan-v3（從未啟動）與 plan-v4（sha256 `067208891a9d620fae8b8aad750658c47904707b7d28b56c9ab8e14e446fce76`，frozen_utc 2026-10-15T07:51:00Z），只換工具身分與路徑，門檻與對局設定不變。
- 重現性：plan-v4 下重下同一組 200 局（look 1 的重現，非新 look），nice 19 約 21 分鐘；事後與 v2 逐局比對（排除時間／worker／pid 欄位）200/200 相同。controller 對局後自動稽核，故比對在稽核之後完成。
- 解讀限制：這是不退步證據，不是棋力提升；不借用其他 A/B 的結果。十級難度正式驗證尚未完成。

## M5 KillerHistoryOrdering 採納紀錄（2026-10-07，補記於 2026-10-15）

固定兩-look 獨立審查：400 局 Game/raw 重播無錯，W/D/L=184/114/102，平均得分 0.6025，N=153、n=100 的 97.5% 有限母體區間 `[0.5146, 0.6904]`（完整值 `[0.5145625894238621,0.6904374105761379]`），下界高於 0.5，採納為產品預設。證據限制：原始審查 JSON `/tmp/xiangqi-m5-kh-final-review.json`（SHA256 `79d265e70cfffdfc0ae4a111b4e7f2a7852c3b2732a31fbae9e41e3991b01a22`）已隨機器重開遺失，repo 內找不到對局或稽核原檔，數字僅有 開發紀錄（未公開） 2026-10-07 條目與 `.codex/build-proofs/m5-product-bae7337/source/開發紀錄（未公開） 副本的文字紀錄（兩者一致）；搜尋範圍見 （原始證據檔未公開）。

## 2026-10-15：M5 十級難度正式驗證通過

依 `docs/TEST_PLAN.md` §5.3 第 3 條：等級 n+2 對等級 n，勝率 >= 65%，n=1..8 每組都要成立。操作口徑（專案負責人事前定義）：每組 50 個開局 × 雙色 = 100 局，和棋不算勝，通過條件 `W/N >= 0.65`；每步 caller 100,000 nodes、4096 ply 上限、4 workers。

固定身分：commit `2ade2a9`、binary sha256 `6f48b114…70b`、freeze_sha256 `8730cc73…132c`（2026-10-15T08:38:07Z）、selection_sha256 `6ff0d21d…d85e`（熵 08:38:13Z，晚於 freeze，早於所有對局）、master_seed 314159265。50 個局面是 freeze 後才用 OS 熵從排除 pilot 來源群後的 124 列抽出，一次性登記。

| 組 | 較高 W | D | 較高 L | 勝率 | >= 65% |
|---|---|---|---|---|---|
| 1v3 | 88 | 6 | 6 | 0.88 | 是 |
| 2v4 | 94 | 2 | 4 | 0.94 | 是 |
| 3v5 | 95 | 1 | 4 | 0.95 | 是 |
| 4v6 | 93 | 2 | 5 | 0.93 | 是 |
| 5v7 | 97 | 0 | 3 | 0.97 | 是 |
| 6v8 | 99 | 0 | 1 | 0.99 | 是 |
| 7v9 | 98 | 0 | 2 | 0.98 | 是 |
| 8v10 | 99 | 1 | 0 | 0.99 | 是 |

本機獨立稽核（pinned xq-core Game 逐局重播 + raw UCI 核對）：`audit-series` `complete=true`、`formal_gate_eligible=true`、`passed=true`；八組逐組 `audit_status=complete`、`game_replay_valid`、`raw_replay_valid` 皆 true。對局在 Modal cpu=5 執行，先經 32 局／3840 手與本機逐步一致的 smoke（0 不一致）。這是勝率門檻證據，不是 Elo 校準；十級節點上限與雜訊表在原始碼中仍標「候選值」，通過本驗證不改變該標註的事實，只代表這一組參數滿足 §5.3.3。證據、雜湊與重新稽核方式見 （原始證據檔未公開）。

## 2026-10-15：M10 對外部引擎（Pikafish）對打紀錄（TEST_PLAN §5.4，記錄而非門檻）

對手是官方 Pikafish 2026-09-06 的 `Pikafish-Linux-x86-64-universal` 與 `pikafish.nnue`（SHA-256 727828293830de8082a80b224bf47b32700c2d1a441908ea11b3c9197178c20c、7d13d73569a9b571ba0eb20cf1596247bc2a42738967e61afef6482b231e900e，皆與查證報告相符），經 UCI 文字協定當外部執行檔使用，Threads 1、Hash 16 MB（預設），每步 `go nodes N`。內建引擎為 `xq-uci spar` 的行程內搜尋（產品預設設定，節點上限見下表），來源 commit `14e2869`、release binary SHA-256 `1dad0c85b7b1a15ffe10992ee82c987152fbbd25b0c18e41bc7e9c5c45ec6811`，本機桌上型 CPU、nice 19。開局 8 個（`docs/samples/m10-pikafish/openings.txt`）× 內建執紅黑各一 = 每格 16 盤，單盤上限 300 步，超過記 unfinished。逐盤著法在 `docs/samples/m10-pikafish/spar-builtin<內建節點>-pikafish<Pikafish 節點>.json`。

| 內建每步節點 | Pikafish 每步節點 | 內建 勝 | 和 | 負 | unfinished | 內建得分率（勝+0.5和）/完整盤 | 耗時 |
|---|---|---|---|---|---|---|---|
| 1,000 | 100 | 1 | 1 | 14 | 0 | 0.094 | 10 秒 |
| 10,000 | 100 | 3 | 0 | 13 | 0 | 0.188 | 63 秒 |
| 100,000 | 100 | 4 | 3 | 7 | 2 | 0.393（14 盤完整） | 867 秒 |
| 1,000 | 1,000 | 0 | 0 | 16 | 0 | 0.000 | 9 秒 |
| 10,000 | 1,000 | 0 | 1 | 15 | 0 | 0.031 | 55 秒 |
| 100,000 | 1,000 | 1 | 0 | 15 | 0 | 0.062 | 455 秒 |

解讀限制：這是紀錄，不是門檻，也沒有要求通過。每格只有 16 盤（8 開局 × 2 色，開局是自選的四步常見開局，不是凍結抽樣），沒有信賴區間；內外兩邊的「節點」定義不同（Pikafish 的節點含 NNUE 評估，內建引擎節點是自己的搜尋節點），所以橫向比較只看趨勢：內建引擎節點越多得分越高，在 Pikafish 100 節點時，100,000 節點的內建引擎約在 0.39。Pikafish 在每步 1,000 節點時內建引擎幾乎全敗。不拿這些數字當作棋力改進或退步的證據。

## M7 期間試過但未採用的候選（2026-10-08，補記於 2026-10-15）

以下三個候選都是為了讓固定典型中局在 `node_limit=100000` 下，同根最佳線達到至少六個合法 ply（M7 主變化要求）而試的搜尋技術。三者都停在功能 gate，**沒有進入 search-v-search A/B**，沒有讀取或消耗 heldout／look 樣本，也沒有改預算、fixture 或門檻；所以它們是「功能 gate 失敗的候選拒絕」，不是棋力退步或改善的結論，也不推論該技術一般的棋力。三者共同的固定基底是 `ec697e5bdc6b8ead13c2d2d29769b4d91ebf5c26`（`milestone/m7-principal-variation` 的 PV 保留修改，尚未併入 main）；候選實作皆已在各分支還原至該基底，不進產品。M7 六步主變化 gate 仍未達成。以下數字照各分支原文抄錄。

- **alpha-beta + TT bound 候選**（判定：拒絕，未進 A/B）。基線 depth 3、PV 長度 3/3/4；候選達 depth 4、90,812 nodes、PV 長度 4/5/4，仍未達六 ply。依預定門檻停止並撤回。紅測契約只保留在隔離分支 `evidence/m7-alpha-beta-contracts`（commit `71045bc4a3447d96c97b1700316135b1b596bdc7`），不應合併。出處：分支 `milestone/m7-alpha-beta-candidate`，commit `7492c03084aa89f41e51eb51e5b4ba0aaf2e98f8`（`docs: record rejected M7 alpha-beta candidate`），檔案 `docs/STRENGTH.md`；原始 log 在 repo 外的 `.codex/evidence/m7-ui/alpha-beta-candidate-red.log`（SHA-256 `26389c07cc28de7538eb165890b1f397ada5db4030ed35289dc1bbe64d455649`）與 `alpha-beta-candidate-100k-attempt.log`（SHA-256 `70c9d56b56ff216298511d03e3e284bdec905e02362be94fa4a7eaba3e99f1b0`）。

- **前一輪 PV 走法排序候選**（判定：拒絕，未進 A/B）。固定六手歷史、100,000 nodes；基線 depth 3、30,680 nodes、best PV 3 ply（`DepthLimit`）。唯一改動是依前一完整 iteration 的主變化調整下一輪排序，結果仍 depth 3、PV 3 ply、29,763 nodes，gate 失敗（exit 101）。現存證據未顯示有跑 A/B 或讀 heldout／look。紅測保留在 `evidence/m7-pv-order-contracts`（commit `f09a74d7c3fe204a4a517add8073c6d14b75925c`），不應合併。出處：分支 `milestone/m7-pv-order-candidate`，commit `3b26d07d3452db86faa053e8506acc94d4cafc91`（另有 `7557d72829c12f06e8deccc21d8a163dd7b59329` 補充說明），檔案 `docs/STRENGTH.md`；候選 patch SHA-256 `7692e6d6cf16954c37f0eb46328778655540fbba9562b1e91eabc0f4d34c9da8`，baseline red log SHA-256 `2da72f8cfe2b690c52725d825a9f534d421dd1936be79a1c2662604639ca0acc`，candidate attempt log SHA-256 `bf7fb25bca00d04feae40b130e4784964edf3f2b2c0ee503de627172cc8135a7`（均在版本控制外的 `.codex/evidence/m7-ui/`）。

- **受限 LMR 候選（M7）**（判定：拒絕，未進 A/B）。僅 interior 節點、depth≥3、非被將軍、排序後 index≥3 的 quiet 著手減一 ply，縮減分數高於 alpha 時重搜。基準與候選在固定 gate 都是 PV 3 ply、30,680 nodes、depth 3（`cargo test -p xq-engine --test lmr_candidate --release -- --nocapture`，exit 101）；此為事後新鮮重現，先前未封存的執行不算。出處：分支 `milestone/m7-lmr-candidate`，拒絕 commit `754345f9efbfc8aad33265e5f8b76d4a5a84b4d3`，封存收尾 `5ab7959aca750d4a317af87553859bdbae1ffb69`；檔案 `docs/STRENGTH.md` 與 （原始證據檔未公開）（README、`candidate.patch`、`gate.stdout`／`gate.stderr`／`gate.exit`、`SHA256SUMS`）。`candidate.patch` SHA-256 `ac01199155793cc52e01dee78ce5b6eb651bec415a3eea38400a3eef93e4dba2`。與上方「M5 LMR 兩-look結果與產品撤回」是不同實驗：M5 那次是 400 局 search-v-search（`discard_inconclusive`），本條只是 M7 PV gate。

限制：這些分支的 `docs/` 封存與 `.codex/evidence/` 原始 log 多半不在 main；本節數字僅依各分支 `docs/STRENGTH.md` 與 LMR 封存檔的文字，本次未重跑任何測試。

## 2026-10-16：NoAnalysisLines 轉接層修復的 §5.3.5 非退步 A/B

這不是棋力改動。修復只在 `xq-review` 的 `BuiltinAnalyzer`（搜尋回空時重試較大節點預算），`xq-engine` 與 `xq-uci` 的對打路徑沒有改（`git diff 673754a 77a3c60 -- crates ':!crates/xq-review'` 為空）。依 TEST_PLAN §5.3.5 仍用原凍結 50 局開局、200 盤、固定節點設定驗證不退步，設定照抄 TT fail-low 修復那次（`--experiment correctness-repair`、10000 nodes、seed 1、max-ply 4096、workers 4、look 1、engine-timeout 30）。

A＝修後 `77a3c60` 的 xq-uci，B＝修前 `673754a` 的 xq-uci。在 Modal（cpu=8，1001 秒）完成：200/200 局完整、unfinished 0；A 的 W/D/L = 76/48/76，score 0.5，高於事前 0.45 門檻，`correctness_repair_gate.passed = true`。50 個開局每個的 4 盤（兩輪 × 換色）走法逐步完全相同（50/50），也就是兩個版本在這些局面上走出相同的棋，勝負只是顏色對稱的結果。這與「修復不碰對打路徑」相符。這不代表棋力提升。另外要注意：對打路徑不經過 `BuiltinAnalyzer`，所以這次 A/B 對 xq-review 的改動近乎恆真，只能證明對打路徑沒變，不能證明轉接層的修復本身沒有副作用。資料、SHA、Modal 腳本與環境說明在 （原始證據檔未公開）。
