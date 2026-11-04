# 提案更正記錄

`protocol-proposal-v0.md` 保留原始錯誤版位元組不變（SHA-256 `a283629050b0afadb04a973077f0727a2456dbaa416cebcc1e497e6ebe3d8871`）。現行 `protocol-proposal.md` 更正如下：

1. ordinary 95% Hoeffding 不使用有限母體修正；採 `sqrt(ln(2/.05)/(2n))`。在 p=.5 時 n=50 score 全寬 .3841291165、Elo ±140.674773；n=100 score 全寬 .2716203031、Elo ±96.799849。決策區間仍是 alpha=.025 的有限母體 Hoeffding–Serfling。
2. prereg 只鎖定抽樣 seed、樣本輸出及試驗設定；對局輸出 hash 待試驗完成後追加。
3. 使用者待裁定項僅為 M4「一組50」口徑；候選整體由負責人依既有授權審核。

更正版由計算腳本產出數值，SHA-256 請以 `sha256sum protocol-proposal.md` 實際核對。