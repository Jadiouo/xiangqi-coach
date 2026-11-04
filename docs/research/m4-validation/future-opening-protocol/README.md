# 未來開局驗收規則與母體證據

本目錄記錄已批准的未來棋力增強候選（包括新的 M4 組合及 M5）兩-look抽樣規則與其有限母體，不是本次試驗的正式 preregistration。母體只代表 203 個合格開局扣除舊正式選樣50個後剩餘的153個；不是所有常見開局。候選 source/config 凍結後，才可生成 seed 並抽出 ordered100；目前沒有抽樣、candidate SHA 或對局資料。

`remaining-153.jsonl` 只含差集開局標識、盤面鍵與 FEN。`manifest.json` 含來源檔案 SHA-256 與差集 SHA-256。`protocol-proposal.md` 是核准後的規則版本。原 `erratum.md` 中等待裁定的範圍描述屬先前歷史；使用者後續同意將第二組新50局規則適用於未來所有新棋力候選，現行範圍以更正後的 proposal 為準；`protocol-proposal-v0.md` 和 `erratum.md` 保留更正前稿件與修正記錄。上游來源、revision、授權及建置程序見 `docs/research/m4-openings/README.md`。
