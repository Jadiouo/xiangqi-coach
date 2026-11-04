# 覆盤筆記

## 對局資訊

- 日期：2026-10-09
- 雙方：示範紅方（紅）對 示範黑方（黑）
- 結果：紅勝
- 開局：中炮對屏風馬（開局辨識）
- 分析器：內建引擎；快掃 100,000 節點、深入 1,000,000 節點
- 搜尋設定：SearchConfig::default()

## 勝率曲線

紅方勝率變化：

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 220" role="img"><title>紅方勝率 &amp; 曲線</title><path d="M20 20V200H700" fill="none" stroke="#777"/><polyline points="20,110 156,110 292,110 428,110 564,110 700,110" fill="none" stroke="#a22" stroke-width="3"/><text x="20" y="15">紅方勝率</text></svg>

## 對局摘要

全局共 6 手；最大轉折在第 4 手，勝率損失 18.0%。

## 關鍵時刻

### 第 4 手・車9平8

- 實著：車9平8（i9h9）
- 最佳候選・深度 8・50,000 節點：h2e2
- 主要變化：h2e2 h9g7 h0g2 i9h9 i0h0 b9c7
- 勝率損失：18.0%
- 原因：引擎算到這一步之後，對方可以在 2 步內將死你。

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 426" role="img"><title>第 4 手前</title><rect width="384" height="426" fill="#f3dfb8"/><path d="M24 24H360" stroke="#543"/><path d="M24 66H360" stroke="#543"/><path d="M24 108H360" stroke="#543"/><path d="M24 150H360" stroke="#543"/><path d="M24 192H360" stroke="#543"/><path d="M24 234H360" stroke="#543"/><path d="M24 276H360" stroke="#543"/><path d="M24 318H360" stroke="#543"/><path d="M24 360H360" stroke="#543"/><path d="M24 402H360" stroke="#543"/><path d="M24 24V402" stroke="#543"/><path d="M66 24V402" stroke="#543"/><path d="M108 24V402" stroke="#543"/><path d="M150 24V402" stroke="#543"/><path d="M192 24V402" stroke="#543"/><path d="M234 24V402" stroke="#543"/><path d="M276 24V402" stroke="#543"/><path d="M318 24V402" stroke="#543"/><path d="M360 24V402" stroke="#543"/><circle cx="24" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="24" y="29" text-anchor="middle">車</text><circle cx="66" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="66" y="29" text-anchor="middle">馬</text><circle cx="108" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="108" y="29" text-anchor="middle">象</text><circle cx="150" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="150" y="29" text-anchor="middle">士</text><circle cx="192" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="192" y="29" text-anchor="middle">將</text><circle cx="234" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="234" y="29" text-anchor="middle">士</text><circle cx="276" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="276" y="29" text-anchor="middle">象</text><circle cx="318" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="318" y="29" text-anchor="middle">馬</text><circle cx="360" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="360" y="29" text-anchor="middle">車</text><circle cx="66" cy="108" r="16" fill="#fff8e8" stroke="#222"/><text x="66" y="113" text-anchor="middle">砲</text><circle cx="318" cy="108" r="16" fill="#fff8e8" stroke="#222"/><text x="318" y="113" text-anchor="middle">砲</text><circle cx="24" cy="150" r="16" fill="#fff8e8" stroke="#222"/><text x="24" y="155" text-anchor="middle">卒</text><circle cx="108" cy="150" r="16" fill="#fff8e8" stroke="#222"/><text x="108" y="155" text-anchor="middle">卒</text><circle cx="192" cy="150" r="16" fill="#fff8e8" stroke="#222"/><text x="192" y="155" text-anchor="middle">卒</text><circle cx="276" cy="150" r="16" fill="#fff8e8" stroke="#222"/><text x="276" y="155" text-anchor="middle">卒</text><circle cx="360" cy="150" r="16" fill="#fff8e8" stroke="#222"/><text x="360" y="155" text-anchor="middle">卒</text><circle cx="24" cy="276" r="16" fill="#fff8e8" stroke="#a22"/><text x="24" y="281" text-anchor="middle">兵</text><circle cx="108" cy="276" r="16" fill="#fff8e8" stroke="#a22"/><text x="108" y="281" text-anchor="middle">兵</text><circle cx="192" cy="276" r="16" fill="#fff8e8" stroke="#a22"/><text x="192" y="281" text-anchor="middle">兵</text><circle cx="276" cy="276" r="16" fill="#fff8e8" stroke="#a22"/><text x="276" y="281" text-anchor="middle">兵</text><circle cx="360" cy="276" r="16" fill="#fff8e8" stroke="#a22"/><text x="360" y="281" text-anchor="middle">兵</text><circle cx="66" cy="318" r="16" fill="#fff8e8" stroke="#a22"/><text x="66" y="323" text-anchor="middle">炮</text><circle cx="318" cy="318" r="16" fill="#fff8e8" stroke="#a22"/><text x="318" y="323" text-anchor="middle">炮</text><circle cx="24" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="24" y="407" text-anchor="middle">車</text><circle cx="66" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="66" y="407" text-anchor="middle">馬</text><circle cx="108" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="108" y="407" text-anchor="middle">相</text><circle cx="150" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="150" y="407" text-anchor="middle">仕</text><circle cx="192" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="192" y="407" text-anchor="middle">帥</text><circle cx="234" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="234" y="407" text-anchor="middle">仕</text><circle cx="276" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="276" y="407" text-anchor="middle">相</text><circle cx="318" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="318" y="407" text-anchor="middle">馬</text><circle cx="360" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="360" y="407" text-anchor="middle">車</text></svg>

### 第 2 手・馬8進7

- 實著：馬8進7（h9g7）
- 最佳候選・深度 8・50,000 節點：h2e2
- 主要變化：h2e2 h9g7 h0g2 i9h9 i0h0 b9c7
- 勝率損失：12.0%
- 原因：引擎算到你錯過了在 3 步內將死對方的機會。

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 426" role="img"><title>第 2 手前</title><rect width="384" height="426" fill="#f3dfb8"/><path d="M24 24H360" stroke="#543"/><path d="M24 66H360" stroke="#543"/><path d="M24 108H360" stroke="#543"/><path d="M24 150H360" stroke="#543"/><path d="M24 192H360" stroke="#543"/><path d="M24 234H360" stroke="#543"/><path d="M24 276H360" stroke="#543"/><path d="M24 318H360" stroke="#543"/><path d="M24 360H360" stroke="#543"/><path d="M24 402H360" stroke="#543"/><path d="M24 24V402" stroke="#543"/><path d="M66 24V402" stroke="#543"/><path d="M108 24V402" stroke="#543"/><path d="M150 24V402" stroke="#543"/><path d="M192 24V402" stroke="#543"/><path d="M234 24V402" stroke="#543"/><path d="M276 24V402" stroke="#543"/><path d="M318 24V402" stroke="#543"/><path d="M360 24V402" stroke="#543"/><circle cx="24" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="24" y="29" text-anchor="middle">車</text><circle cx="66" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="66" y="29" text-anchor="middle">馬</text><circle cx="108" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="108" y="29" text-anchor="middle">象</text><circle cx="150" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="150" y="29" text-anchor="middle">士</text><circle cx="192" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="192" y="29" text-anchor="middle">將</text><circle cx="234" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="234" y="29" text-anchor="middle">士</text><circle cx="276" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="276" y="29" text-anchor="middle">象</text><circle cx="318" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="318" y="29" text-anchor="middle">馬</text><circle cx="360" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="360" y="29" text-anchor="middle">車</text><circle cx="66" cy="108" r="16" fill="#fff8e8" stroke="#222"/><text x="66" y="113" text-anchor="middle">砲</text><circle cx="318" cy="108" r="16" fill="#fff8e8" stroke="#222"/><text x="318" y="113" text-anchor="middle">砲</text><circle cx="24" cy="150" r="16" fill="#fff8e8" stroke="#222"/><text x="24" y="155" text-anchor="middle">卒</text><circle cx="108" cy="150" r="16" fill="#fff8e8" stroke="#222"/><text x="108" y="155" text-anchor="middle">卒</text><circle cx="192" cy="150" r="16" fill="#fff8e8" stroke="#222"/><text x="192" y="155" text-anchor="middle">卒</text><circle cx="276" cy="150" r="16" fill="#fff8e8" stroke="#222"/><text x="276" y="155" text-anchor="middle">卒</text><circle cx="360" cy="150" r="16" fill="#fff8e8" stroke="#222"/><text x="360" y="155" text-anchor="middle">卒</text><circle cx="24" cy="276" r="16" fill="#fff8e8" stroke="#a22"/><text x="24" y="281" text-anchor="middle">兵</text><circle cx="108" cy="276" r="16" fill="#fff8e8" stroke="#a22"/><text x="108" y="281" text-anchor="middle">兵</text><circle cx="192" cy="276" r="16" fill="#fff8e8" stroke="#a22"/><text x="192" y="281" text-anchor="middle">兵</text><circle cx="276" cy="276" r="16" fill="#fff8e8" stroke="#a22"/><text x="276" y="281" text-anchor="middle">兵</text><circle cx="360" cy="276" r="16" fill="#fff8e8" stroke="#a22"/><text x="360" y="281" text-anchor="middle">兵</text><circle cx="66" cy="318" r="16" fill="#fff8e8" stroke="#a22"/><text x="66" y="323" text-anchor="middle">炮</text><circle cx="318" cy="318" r="16" fill="#fff8e8" stroke="#a22"/><text x="318" y="323" text-anchor="middle">炮</text><circle cx="24" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="24" y="407" text-anchor="middle">車</text><circle cx="66" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="66" y="407" text-anchor="middle">馬</text><circle cx="108" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="108" y="407" text-anchor="middle">相</text><circle cx="150" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="150" y="407" text-anchor="middle">仕</text><circle cx="192" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="192" y="407" text-anchor="middle">帥</text><circle cx="234" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="234" y="407" text-anchor="middle">仕</text><circle cx="276" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="276" y="407" text-anchor="middle">相</text><circle cx="318" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="318" y="407" text-anchor="middle">馬</text><circle cx="360" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="360" y="407" text-anchor="middle">車</text></svg>

### 第 5 手・車一平二

- 實著：車一平二（i0h0）
- 最佳候選・深度 8・50,000 節點：h2e2
- 主要變化：h2e2 h9g7 h0g2 i9h9 i0h0 b9c7
- 勝率損失：6.0%
- 原因：原因尚未判定。

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 426" role="img"><title>第 5 手前</title><rect width="384" height="426" fill="#f3dfb8"/><path d="M24 24H360" stroke="#543"/><path d="M24 66H360" stroke="#543"/><path d="M24 108H360" stroke="#543"/><path d="M24 150H360" stroke="#543"/><path d="M24 192H360" stroke="#543"/><path d="M24 234H360" stroke="#543"/><path d="M24 276H360" stroke="#543"/><path d="M24 318H360" stroke="#543"/><path d="M24 360H360" stroke="#543"/><path d="M24 402H360" stroke="#543"/><path d="M24 24V402" stroke="#543"/><path d="M66 24V402" stroke="#543"/><path d="M108 24V402" stroke="#543"/><path d="M150 24V402" stroke="#543"/><path d="M192 24V402" stroke="#543"/><path d="M234 24V402" stroke="#543"/><path d="M276 24V402" stroke="#543"/><path d="M318 24V402" stroke="#543"/><path d="M360 24V402" stroke="#543"/><circle cx="24" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="24" y="29" text-anchor="middle">車</text><circle cx="66" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="66" y="29" text-anchor="middle">馬</text><circle cx="108" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="108" y="29" text-anchor="middle">象</text><circle cx="150" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="150" y="29" text-anchor="middle">士</text><circle cx="192" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="192" y="29" text-anchor="middle">將</text><circle cx="234" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="234" y="29" text-anchor="middle">士</text><circle cx="276" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="276" y="29" text-anchor="middle">象</text><circle cx="318" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="318" y="29" text-anchor="middle">馬</text><circle cx="360" cy="24" r="16" fill="#fff8e8" stroke="#222"/><text x="360" y="29" text-anchor="middle">車</text><circle cx="66" cy="108" r="16" fill="#fff8e8" stroke="#222"/><text x="66" y="113" text-anchor="middle">砲</text><circle cx="318" cy="108" r="16" fill="#fff8e8" stroke="#222"/><text x="318" y="113" text-anchor="middle">砲</text><circle cx="24" cy="150" r="16" fill="#fff8e8" stroke="#222"/><text x="24" y="155" text-anchor="middle">卒</text><circle cx="108" cy="150" r="16" fill="#fff8e8" stroke="#222"/><text x="108" y="155" text-anchor="middle">卒</text><circle cx="192" cy="150" r="16" fill="#fff8e8" stroke="#222"/><text x="192" y="155" text-anchor="middle">卒</text><circle cx="276" cy="150" r="16" fill="#fff8e8" stroke="#222"/><text x="276" y="155" text-anchor="middle">卒</text><circle cx="360" cy="150" r="16" fill="#fff8e8" stroke="#222"/><text x="360" y="155" text-anchor="middle">卒</text><circle cx="24" cy="276" r="16" fill="#fff8e8" stroke="#a22"/><text x="24" y="281" text-anchor="middle">兵</text><circle cx="108" cy="276" r="16" fill="#fff8e8" stroke="#a22"/><text x="108" y="281" text-anchor="middle">兵</text><circle cx="192" cy="276" r="16" fill="#fff8e8" stroke="#a22"/><text x="192" y="281" text-anchor="middle">兵</text><circle cx="276" cy="276" r="16" fill="#fff8e8" stroke="#a22"/><text x="276" y="281" text-anchor="middle">兵</text><circle cx="360" cy="276" r="16" fill="#fff8e8" stroke="#a22"/><text x="360" y="281" text-anchor="middle">兵</text><circle cx="66" cy="318" r="16" fill="#fff8e8" stroke="#a22"/><text x="66" y="323" text-anchor="middle">炮</text><circle cx="318" cy="318" r="16" fill="#fff8e8" stroke="#a22"/><text x="318" y="323" text-anchor="middle">炮</text><circle cx="24" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="24" y="407" text-anchor="middle">車</text><circle cx="66" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="66" y="407" text-anchor="middle">馬</text><circle cx="108" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="108" y="407" text-anchor="middle">相</text><circle cx="150" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="150" y="407" text-anchor="middle">仕</text><circle cx="192" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="192" y="407" text-anchor="middle">帥</text><circle cx="234" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="234" y="407" text-anchor="middle">仕</text><circle cx="276" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="276" y="407" text-anchor="middle">相</text><circle cx="318" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="318" y="407" text-anchor="middle">馬</text><circle cx="360" cy="402" r="16" fill="#fff8e8" stroke="#a22"/><text x="360" y="407" text-anchor="middle">車</text></svg>

## 推演分支

- h2e2 b9c7：這裡先出馬保中卒，比急著出車穩。

## 毛病統計

- 走進被殺：1 次
- 錯過殺棋：1 次
- 原因尚未判定：1 次

## 下次注意

下次注意：待分析

## 完整棋譜

起始 FEN：`rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1`

```pgn
[Red "示範紅方"]
[Black "示範黑方"]
[Result "1-0"]
[FEN "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1"]

1. 炮二平五 馬8進7 2. 馬二進三 車9平8 3. 車一平二 馬2進3
1-0
```
