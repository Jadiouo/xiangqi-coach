# M4 未來開局抽樣工具

此工具依 `docs/TEST_PLAN.md` §5.2，從已固定的剩餘 153 局中一次抽出 ordered100，供未來兩-look 驗收使用。它只建立樣本檔與鎖定 manifest，不啟動棋局或 match runner。

先用唯讀入口核實目前 repo 的母體及來源雜湊：

```sh
python3 scripts/m4/future_openings.py verify-population --repo-root .
```

候選程式碼、tracked configuration 與執行檔都凍結後，由試驗負責人提供 candidate lock JSON，狀態必須是 `locked`。必填欄位為：`status`、`git_repo_path`、`git_head`、`binary_path`、`binary_sha256`、`config_path`、`config_sha256`。工具會重讀實際 Git HEAD、拒 dirty/untracked 檔、確認 config 已被 Git 追蹤，並重算 binary/config SHA-256。lock 只記錄真實候選，不應先建立或填入預測雜湊。

每個候選在本 source checkout 的 Git common-dir 只允許一次首次登記；登記以 exclusive create 寫入 `.git/future-opening-selection-locks/`，先固定候選、來源雜湊、seed 及唯一輸出路徑，再呼叫抽樣。這是防止操作失誤的本機登記，不是防竄改簽章，也不跨獨立 clone 保證唯一性；刪除或手改 Git 登記檔會破壞這項保障。已完成的候選拒絕換目錄重抽。

正式抽樣時使用新的、事先不存在的 output directory：

```sh
python3 scripts/m4/future_openings.py generate --repo-root . --candidate-lock <locked-candidate.json> --output-dir <new-output-directory>
```

工具先驗證固定來源和 candidate lock，然後才從 OS entropy 取得 64-bit seed。若需要重現既有樣本，可另加 `--reproduce-manifest <verified-selection-manifest.json>`；工具先驗證該 manifest 的全部檔案與候選，再沿用其 seed。若抽樣前準備中斷，registration 保留原 seed；只能用錯誤訊息所列的 `--resume-lock <registration.json>` 和原輸出路徑續做，續做前再次核實登記與 seed provenance。新輸出路徑已存在時會拒絕寫入。CLI 不提供手動 seed 參數。

唯一的 `selection-manifest.json` 是輸出路徑與雜湊的索引，包含候選 Git/binary/config refs、來源 refs、Python 版本、抽樣算法、seed、ordered100 hash、兩份 runner TSV hash，以及首場對局前鎖定的 preregistration hash。輸出固定為 `ordered-100.jsonl`、`look1.tsv`、`look2.tsv`：前 50 與後 50 互斥；每局 TSV 預備紅黑雙色各一盤、兩 round。manifest 不預填未來對局輸出 hash；完成後另行追加實際檔案雜湊。

唯讀驗收入口會拒絕來源雜湊或數量錯誤、樣本重複/越界、seed 無法依目前 Python 版本與固定演算法逐列重現、兩 look 內容不符、輸出缺檔/雜湊不符、登記缺失或不符、候選狀態或 Git/binary/config refs 不符：

```sh
python3 scripts/m4/future_openings.py verify --repo-root . --candidate-lock <locked-candidate.json> --manifest <selection-manifest.json>
```

目前程式碼與 binary 尚未凍結；現有真實 153 局只核驗來源，不執行抽樣。這項限制不影響合成資料的自動化測試。
