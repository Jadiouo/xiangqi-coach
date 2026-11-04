import type { ReviewClassification, ReviewComparison, ReviewLineStep, ReviewContinuationStatus, ReviewExplanationLevel, ReviewPiece, ReviewPvEnd, ReviewReason, ReviewReasonKind } from "../review-client";

const pieceNames = {
  red: { king: "帥", advisor: "仕", elephant: "相", horse: "馬", rook: "車", cannon: "炮", pawn: "兵" },
  black: { king: "將", advisor: "士", elephant: "象", horse: "馬", rook: "車", cannon: "炮", pawn: "卒" },
} as const;
const sideNames = { red: "紅", black: "黑" } as const;

/** "一匹馬", "一輛車", "一門炮", "一個卒": one piece with its measure word. */
function onePiece(piece: ReviewPiece): string {
  const unit = { horse: "匹", rook: "輛", cannon: "門" }[piece.kind as "horse" | "rook" | "cannon"] ?? "個";
  return `一${unit}${pieceName(piece)}`;
}

const countWords = ["", "一", "兩", "三", "四", "五", "六", "七", "八", "九", "十"];
/** Pieces of one kind and side merged: [馬, 卒, 馬] -> ["兩匹馬", "一個卒"], first appearance first. */
function groupPieces(pieces: ReviewPiece[]): string[] {
  const groups: { piece: ReviewPiece; count: number }[] = [];
  for (const piece of pieces) {
    const group = groups.find((g) => g.piece.kind === piece.kind && g.piece.side === piece.side);
    if (group) group.count += 1; else groups.push({ piece, count: 1 });
  }
  return groups.map(({ piece, count }) => {
    const text = onePiece(piece);
    return count === 1 ? text : `${countWords[count] ?? String(count)}${text.slice(1)}`;
  });
}

/** A mover's piece after 你把, without repeating 你的. */
function plainPiece(piece: ReviewPiece): string {
  return `${sideNames[piece.side]}${pieceName(piece)}`;
}
function pieceName(piece: ReviewPiece): string {
  return pieceNames[piece.side][piece.kind];
}
/** The mover's own piece, e.g. 你的紅馬（c4）. */
function ownPiece(piece: ReviewPiece): string {
  return `你的${sideNames[piece.side]}${pieceName(piece)}`;
}
/** The opponent's piece, e.g. 對方黑卒. */
function foePiece(piece: ReviewPiece): string {
  return `對方${sideNames[piece.side]}${pieceName(piece)}`;
}

/** Sentence templates for the reasons that SPEC 8.4 items 5 to 9 add. */
function exchangeReason(reason: Extract<ReviewReason, { protection: unknown }>, level: ReviewExplanationLevel): string {
  const e = reason.protection;
  const own = ownPiece(e.piece);
  const foe = foePiece(e.attacker);
  if (reason.kind === "sent_piece") {
    switch (level) {
      case "beginner": return `你把${plainPiece(e.piece)}走到一個會被${foe}吃掉的地方，又沒有足夠的保護，這一步會白白送掉${onePiece(e.piece)}。`;
      case "intermediate": return `${own}走出去後會被${foe}吃，保護不足，這個交換你會少${onePiece(e.piece)}。`;
      case "proficient": return `送吃：${pieceName(e.piece)}被${foe}吃，淨少${onePiece(e.piece)}。`;
    }
  }
  const guarded = e.protectedPiece ? ownPiece(e.protectedPiece) : "原處的棋子";
  const guardedCount = e.protectedPiece ? onePiece(e.protectedPiece) : "一個棋子";
  switch (level) {
    case "beginner": return `你把${plainPiece(e.piece)}移開，它原本在保護${guarded}；它一走開，${foe}就能吃掉${guarded}，你吃不回來。`;
    case "intermediate": return `${pieceName(e.piece)}離開原位，不再保護${guarded}；${foe}可吃，你會少${guardedCount}。`;
    case "proficient": return `放掉保護：${pieceName(e.piece)}離位，${guarded}失守。`;
  }
}

function cannonMountReason(reason: Extract<ReviewReason, { kind: "cannon_mount" }>, level: ReviewExplanationLevel): string {
  const e = reason.cannonMount;
  const cannon = foePiece(e.cannon);
  const victim = ownPiece(e.victim);
  switch (level) {
    case "beginner": return `你把${plainPiece(e.screen)}走到${cannon}和${victim}之間，它成了「炮架」，${cannon}就能隔著它吃掉${victim}。`;
    case "intermediate": return `${ownPiece(e.screen)}成了${cannon}的炮架，${victim}會被隔子吃掉，這個交換你會少${onePiece(e.victim)}。`;
    case "proficient": return `炮架：${pieceName(e.screen)}墊在${pieceName(e.cannon)}與${pieceName(e.victim)}之間，被隔子吃，淨少${onePiece(e.victim)}。`;
  }
}

function checkCaptureReason(reason: Extract<ReviewReason, { kind: "check_capture" }>, level: ReviewExplanationLevel): string {
  const e = reason.checkCapture;
  const victim = ownPiece(e.victim);
  const attacker = foePiece(e.attacker);
  switch (level) {
    case "beginner": return `這一步之後，${attacker}可以吃掉${victim}並同時將軍，你得先應將，這個子就救不回來了。`;
    case "intermediate": return `${attacker}可吃${victim}並將軍，無法回吃，你會少${onePiece(e.victim)}。`;
    case "proficient": return `${pieceName(e.attacker)}吃${pieceName(e.victim)}將軍，無回吃。`;
  }
}

/** The best move must leave this many more steps than the played one before the step sentence is used (SPEC 8.4 item 9).
 * 門檻以 Rust 的 MOBILITY_GAP_STEPS 為準，兩邊要一致；這裡保留是給沒有 mobilityAfterBest 的舊存檔用。 */
const MOBILITY_GAP_STEPS = 3;

function positionReason(reason: Extract<ReviewReason, { kind: "position_type" }>, level: ReviewExplanationLevel): string {
  const e = reason.position;
  switch (e.component) {
    case "mobility":
      if (e.mobilityAfterBest !== undefined && e.mobilityAfterBest - e.mobilityAfter >= MOBILITY_GAP_STEPS) {
        // Counts of moves only (no scores): what the played move left, and what the best one would have.
        const dropped = e.mobilityAfter * 5 <= e.mobilityBefore * 4;
        switch (level) {
          case "beginner": return dropped
            ? `這一步之後，你能走的步數從 ${e.mobilityBefore} 步變成 ${e.mobilityAfter} 步，棋子被擋住、不夠靈活；改走最佳走法，你還有 ${e.mobilityAfterBest} 步可以走。`
            : `這一步之後，你能走的步數是 ${e.mobilityAfter} 步；改走最佳走法，你還有 ${e.mobilityAfterBest} 步可以走，活動空間比較大。`;
          case "intermediate": return dropped
            ? `此著後你的可走步數由 ${e.mobilityBefore} 降為 ${e.mobilityAfter}，子力活動受限；最佳走法後有 ${e.mobilityAfterBest} 步。`
            : `此著後你的可走步數是 ${e.mobilityAfter}，最佳走法後有 ${e.mobilityAfterBest} 步，機動性落後。`;
          case "proficient": return `機動性 ${e.mobilityBefore}→${e.mobilityAfter} 步，最佳走法 ${e.mobilityAfterBest} 步。`;
        }
      }
      if (e.mobilityAfter === e.mobilityBefore) {
        switch (level) {
          case "beginner": return "這一步之後，你的活動空間不如最佳走法。";
          case "intermediate": return "此著後機動性不如最佳走法。";
          case "proficient": return "機動性不如最佳走法。";
        }
      }
      if (e.mobilityAfter * 5 > e.mobilityBefore * 4) {
        // The move did not cut the mover's options by a fifth; the gap is against the best move.
        switch (level) {
          case "beginner": return `這一步之後，你能走的步數從 ${e.mobilityBefore} 步變成 ${e.mobilityAfter} 步，活動空間不如最佳走法。`;
          case "intermediate": return `此著後你能走的步數從 ${e.mobilityBefore} 步變成 ${e.mobilityAfter} 步，機動性落後最佳走法。`;
          case "proficient": return `機動性從 ${e.mobilityBefore} 步變成 ${e.mobilityAfter} 步，落後最佳走法。`;
        }
      }
      switch (level) {
        case "beginner": return `這一步之後，你的棋子能走的步數從 ${e.mobilityBefore} 步變成 ${e.mobilityAfter} 步，棋子被擋住、不夠靈活；最佳走法能保留更多活動空間。`;
        case "intermediate": return `此著後你的可走步數由 ${e.mobilityBefore} 降為 ${e.mobilityAfter}，子力活動受限，最佳走法能保留更多。`;
        case "proficient": return `機動性 ${e.mobilityBefore}→${e.mobilityAfter} 步，最佳走法保留更多。`;
      }
    case "material":
      switch (level) {
        case "beginner": return "這一步之後，你的子力不如最佳走法能保持的多。";
        case "intermediate": return "此著後材料優勢落後最佳走法。";
        case "proficient": return "材料優勢落後最佳走法。";
      }
    case "position":
      switch (level) {
        case "beginner": return "這一步把棋子放在比較差的位置，最佳走法的位置更好。";
        case "intermediate": return "此著後棋子站位不如最佳走法。";
        case "proficient": return "站位不如最佳走法。";
      }
    case "king_safety":
      switch (level) {
        case "beginner": return "這一步讓你的帥（將）離開了比較安全的位置，最佳走法更安全。";
        case "intermediate": return "此著後將帥安全度下降，不如最佳走法。";
        case "proficient": return "將帥安全不如最佳走法。";
      }
  }
}

/** One step as "你炮二平五" / "對方馬8進7", with "（吃你的馬）" / "（吃對方的卒）" after a capture. */
function stepText(step: ReviewLineStep, mover: ReviewLineStep["side"]): string {
  const who = step.side === mover ? "你" : "對方";
  const taken = step.captured
    ? `（吃${step.captured.side === mover ? "你" : "對方"}的${pieceNames[step.captured.side][step.captured.kind]}）`
    : "";
  return `${who}${step.notation}${taken}`;
}

/** SPEC 8.4.1: the two sentences that set the played line against the best line. */
function comparisonSentences(comparison: ReviewComparison): { played: string; best: string } {
  const stop = "（引擎只算到這裡）";
  const open = "；交換還沒結束，實際得失可能還會變";
  // The best line starts with the mover's best move, so its first step tells who "you" are.
  const first = comparison.bestLine[0];
  const mover = first?.side ?? (comparison.playedLine[0]?.side === "red" ? "black" : "red");
  const list = (steps: ReviewLineStep[]) => steps.map((step) => stepText(step, mover)).join("、");
  const played = comparison.playedLine.length > 0
    ? `引擎預期，你這樣走，接下來會是：${list(comparison.playedLine)}${comparison.playedComplete ? "" : stop}${comparison.playedSettled === false ? open : ""}`
    : comparison.playedComplete ? "引擎預期，你這樣走之後對局就結束了。" : `引擎預期你這樣走，但還沒算出接下來的走法${stop}`;
  let best = "引擎沒有給出更好的走法。";
  if (first) {
    // The first step lives in the brackets only; what follows starts with the reply.
    const rest = comparison.bestLine.slice(1);
    const head = `引擎預期，改走〔${first.notation}〕${first.captured ? `（吃${first.captured.side === mover ? "你" : "對方"}的${pieceNames[first.captured.side][first.captured.kind]}）` : ""}`;
    const tail = rest.length > 0 ? `，接下來會是：${list(rest)}` : "";
    best = `${head}${tail}${comparison.bestComplete ? "" : stop}${comparison.bestSettled === false ? open : ""}${rest.length > 0 || !comparison.bestComplete ? "" : "。"}`;
  }
  return { played, best };
}

/**
 * The two "what happens next" lines of the review card, built from the same comparison lines as the
 * sentences above; `bestMove` is the better move in Chinese notation (null when the engine named none).
 */
function followUps(comparison: ReviewComparison): { bestMove: string | null; played: string; best: string | null } {
  const stop = "（引擎只算到這裡）";
  const open = "；交換還沒結束，實際得失可能還會變";
  const first = comparison.bestLine[0];
  const mover = first?.side ?? (comparison.playedLine[0]?.side === "red" ? "black" : "red");
  const list = (steps: ReviewLineStep[]) => steps.map((step) => stepText(step, mover)).join("、");
  const played = comparison.playedLine.length > 0
    ? `${list(comparison.playedLine)}${comparison.playedComplete ? "" : stop}${comparison.playedSettled === false ? open : ""}`
    : comparison.playedComplete ? "之後對局就結束了。" : `還沒算出接下來的走法${stop}`;
  if (!first) return { bestMove: null, played, best: null };
  const rest = comparison.bestLine.slice(1);
  const best = rest.length > 0
    ? `${list(rest)}${comparison.bestComplete ? "" : stop}${comparison.bestSettled === false ? open : ""}`
    : comparison.bestComplete ? "之後對局就結束了。" : `還沒算出接下來的走法${stop}`;
  const taken = first.captured
    ? `（吃${first.captured.side === mover ? "你" : "對方"}的${pieceNames[first.captured.side][first.captured.kind]}）`
    : "";
  return { bestMove: `${first.notation}${taken}`, played, best };
}

const pvEndLabels: Record<ReviewPvEnd, string> = {
  terminal: "遇到終局",
  depth_limit: "達到深度上限",
  transposition_cutoff: "轉置表提前截斷",
  forced_move: "唯一合法著",
  no_completed_iteration: "尚無完整搜尋結果",
};

const continuationStatusLabels: Record<ReviewContinuationStatus, string> = {
  pending: "續算中",
  terminal: "抵達終局",
  invalid_pv: "原始變化無法合法重播",
  invalid_continuation: "續算著法無法合法套用",
  no_result: "本次續算沒有結果",
  cancelled: "續算已取消",
  minimum_reached: "原始變化已達六步",
  complete: "已補足六步",
  search_truncated: "已補足六步，續算搜尋有截斷",
};

const classificationLabels: Record<ReviewClassification, string> = {
  unclassified: "未分類",
  good: "好棋",
  unique_move: "唯一著",
  inaccuracy: "緩著",
  doubtful_move: "疑問手",
  mistake: "失誤",
  blunder: "大漏著",
  missed_mate: "錯過殺棋",
};

export const zhTW = {
  updateBanner: {
    message: "有新版本",
    unsavedWarning: "更新會重新載入頁面，還沒按「保存」的對局與覆盤會消失。",
    button: "更新",
    updated: "已更新，請重新整理",
    refreshButton: "重新整理",
  },
  appTitle: "象棋教練",
  settings: {
    navLabel: "設定分類",
    categories: {
      play: "對弈",
      review: "覆盤",
      level: "我的程度",
      data: "棋譜與資料",
      advanced: "進階",
    },
    playNote: "難度和執子方都在這裡改。",
    reviewNote: "這兩項只影響覆盤：分析越深越慢；勝率視角決定曲線和重點步是從哪一方看。",
    advancedNote: "給想看引擎細節的人。打開開發者模式後，下棋和覆盤畫面才會多出數字與分支工具。",
    dataNote: "貼上別人的棋譜來覆盤，或把自己的棋局備份出去、還原回來。",
  },
  shell: {
    navLabel: "主要畫面",
    tabPlay: "下棋",
    tabReview: "覆盤",
    tabLibrary: "棋譜庫",
    settings: "設定",
  },
  opponent: {
    title: (level: number) => `電腦・難度 ${level}`,
    // the first sentence of each stays word for word what the play page test looks for
    hint: "你執紅，先走。要換難度，按右上角齒輪，也可以在那裡換邊。",
    hintBlack: "你執黑，電腦先走。要換難度，按右上角齒輪，也可以在那裡換邊。",
    nextSide: { red: "下一盤改執紅。", black: "下一盤改執黑。" },
  },
  userSide: {
    label: "執子方",
    red: "我執紅（我先走）",
    black: "我執黑（電腦先走）",
    note: "換邊會從下一盤開始；這盤還沒走棋的話，馬上就換。",
  },
  gameOver: {
    title: "這盤下完了",
    result: { win: "你贏了。", lose: "你輸了。", draw: "和棋。" },
    body: "想知道哪幾步可以走得更好，可以馬上覆盤這盤。",
    review: "覆盤這盤",
    again: "再下一盤",
  },
  dev: {
    title: "開發者資訊",
    toggle: "開發者模式",
    toggleNote: "打開後，下棋畫面會多出節點數、深度、分數、耗時與即時評估。",
    aiLevel: "電腦難度參數",
    nodes: "節點數",
    depth: "深度",
    score: "分數 (cp)",
    ms: "耗時 (ms)",
    none: "—",
    needLive: "開啟即時評估後顯示",
  },
  previewLabel: "Xiangqi Coach・預覽",
  appSubtitle: "把棋走清楚，一步一步練習。",
  boardLabel: "中國象棋棋盤，紅方在下",
  boardLabelBlack: "中國象棋棋盤，黑方在下",
  boardCaption: "紅方在下・點選棋子，再點亮點落子",
  boardCaptionBlack: "黑方在下・點選棋子，再點亮點落子",
  turn: {
    red: "輪到紅方",
    black: "輪到黑方",
  },
  playerLabels: {
    red: "紅方",
    black: "黑方",
  },
  undoReason: {
    workerFailed: "棋局工作已中斷，不能悔棋",
    importing: "正在載入棋譜",
    loading: "棋局載入中",
    thinking: "電腦思考中",
    busy: "處理中，請稍候",
    reviewLocked: "覆盤開始後才能在這裡退一步",
    noMoves: "還沒有可悔的步",
    branchStart: "已經回到這條線的起點",
    branchBusy: "棋盤載入中",
  },
  buttons: {
    undo: "悔棋",
    restart: "重新開始",
    reloadNewGame: "重新載入新局",
  },
  historyTitle: "棋譜",
  library: {
    title: "棋局庫",
    save: "儲存棋局",
    open: (ordinal: number, moves: number, source: "played" | "imported" = "played") =>
      `第 ${ordinal} 局（${moves} 手${source === "imported" ? "・匯入" : ""}）`,
    empty: "尚未儲存棋局",
    date: (savedAt: number) => new Date(savedAt).toLocaleDateString("zh-TW", { month: "long", day: "numeric" }),
    resultForUser: { win: "你贏", lose: "你輸", draw: "和棋" },
    reviewed: "已覆盤",
    notReviewed: "尚未覆盤",
    attention: (side: "red" | "black", count: number) => `${side === "red" ? "紅方" : "黑方"} ${count} 步要注意`,
    viewReview: "看覆盤",
    resultOngoing: "未結束",
    resultUnknown: "—",
    sideLabel: { red: "執紅", black: "執黑" },
    difficulty: (level: number | null) => `難度 ${level ?? "—"}`,
    delete: "刪除",
    deleteLabel: (ordinal: number) => `刪除第 ${ordinal} 局`,
    deleteConfirm: (ordinal: number) => `確定要刪除第 ${ordinal} 局嗎？刪除後無法復原。`,
    deleteYes: "確定刪除",
    deleteNo: "先不要",
    deleted: (ordinal: number) => `已刪除第 ${ordinal} 局`,
    deleteError: "棋局無法刪除，請檢查瀏覽器本機儲存空間。",
    saved: "棋局已儲存",
    savedWithoutNote: "棋局已儲存，但畫面上的筆記屬於不同的起始局面，沒有一起存。",
    saveError: "棋局無法儲存，請檢查瀏覽器本機儲存空間。",
    loadError: "棋局庫無法讀取，請重新整理後再試。",
    status: "棋局庫狀態",
    archiveTitle: "棋譜與資料備份",
    exportAll: "匯出整庫備份",
    importAll: "匯入整庫備份",
    archiveReady: (count: number) => `已匯出 ${count} 局及其分析、筆記與分支資料。`,
    archiveImported: (added: number, skipped: number) => `備份匯入完成：新增 ${added} 局，略過相同資料 ${skipped} 局。`,
    archiveError: (reason: string) => `備份匯入失敗：${reason} 棋局庫沒有變更。`,
    archiveExportError: "備份匯出失敗，請檢查瀏覽器本機儲存空間。",
  },
  recordImport: {
    title: "匯入棋譜",
    status: "匯入狀態",
    paste: "貼上棋譜",
    submit: "辨識並載入",
    adoptPrefix: "採用前段合法棋譜",
    analyzing: "正在辨識並驗證棋譜…",
    loading: "正在載入棋局…",
    format: (format: string) => ({
      iccs: "座標格式",
      chinese: "中文格式",
      pgn: "PGN 格式",
      dhtmlxq: "東萍格式",
    }[format] ?? "未知格式"),
    summary: (format: string, moves: number, standard: boolean | null) =>
      `${format}，${moves} 步・${standard === null ? "起始局面無效" : standard ? "標準開局" : "非標準起局"}`,
    error: (step: number, token: string, message: string) =>
      `${step > 0 ? `第 ${step} 手` : "棋譜"}${token ? `「${token}」` : ""}：${message}`,
    prefixOffer: (moves: number) => `前 ${moves} 手合法；確認後可以載入這段。`,
    prefixLoaded: (moves: number) => `已載入前 ${moves} 手。`,
    warningVariations: "這份棋譜含有變著；目前只載入主線。",
    noMoves: "棋譜沒有可載入的合法著法。",
    invalidRoot: "起始局面無效，棋局沒有改變。",
    loadError: "棋譜無法載入，棋局沒有改變。",
  },
  review: {
    trialBanner: "試走中：這是你自己試的走法，不會改到原棋局。",
    trialBack: "回到原局面",
    start: "開始覆盤",
    title: "覆盤",
    budget: "分析仔細程度",
    progress: (done: number, total: number) => `正在分析 ${done}/${total} 步`,
    eta: (text: string) => `預估剩餘時間：${text}`,
    etaPending: "估算中",
    duration: (seconds: number) => {
      const rounded = Math.max(1, Math.round(seconds));
      if (rounded < 60) return `約 ${rounded} 秒`;
      const minutes = Math.ceil(rounded / 60);
      if (minutes < 60) return `約 ${minutes} 分鐘`;
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return rest === 0 ? `約 ${hours} 小時` : `約 ${hours} 小時 ${rest} 分鐘`;
    },
    longWarning: (plies: number, budgetLabel: string, duration: string) =>
      `這盤有 ${plies} 手，用「${budgetLabel}」預估要${duration}（粗估，依你的裝置而定）。要照樣開始，還是改用較快的預算？`,
    nodeBudget: (nodeLimit: number) => `${nodeLimit.toLocaleString("zh-TW")} 節點`,
    warnGo: "照樣開始",
    warnFaster: "改用較快的預算",
    complete: "分析完成",
    fromCache: (count: number) => `已從先前的分析載入 ${count} 步，不必重算`,
    cancelled: "分析已取消",
    failed: "分析失敗，請重新分析。",
    cancel: "取消分析",
    restart: "重新分析",
    deepen: "想更久",
    perspective: "勝率視角",
    perspectiveRed: "紅方（預設）",
    perspectiveBlack: "黑方",
    curve: "勝率曲線",
    candidates: "候選變化",
    selectLine: "選擇此變化",
    selectedLine: "已選擇變化",
    ply: (value: number) => `第 ${value} 手`,
    sideRed: "紅方視角",
    sideBlack: "黑方視角",
    noPoints: "尚無分析結果",
    pv: (move: string, score: number, depth: number, length: number, end: ReviewPvEnd) =>
      `原始搜尋 ${move}・評分 ${score}・深度 ${depth}・${length} 手（${pvEndLabels[end] ?? "搜尋已停止"}）`,
    continuation: (length: number, budget: number) =>
      `逐局面續算 ${length} 手（每個新局面最多 ${budget.toLocaleString("zh-TW")} 節點）`,
    continuationStatus: (status: ReviewContinuationStatus) =>
      continuationStatusLabels[status] ?? "狀態待確認",
    classification: (classification: ReviewClassification) =>
      classificationLabels[classification] ?? "未分類",
    comparison: comparisonSentences,
    focus: {
      region: "這盤的重點步",
      summary: (side: "red" | "black", count: number) => {
        const name = side === "red" ? "紅方" : "黑方";
        return count === 0 ? `這盤${name}沒有需要特別注意的步` : `這盤${name}有 ${count} 步要注意`;
      },
      empty: "還沒有分析結果",
      waiting: "分析完成後，這裡會列出要注意的步。",
      running: "正在分析，先看已經分析好的步。",
      pick: "點上面的一步，看這步錯在哪、該下哪。",
      chip: (ply: number) => `第 ${ply} 手`,
      chipLabel: (ply: number, classification: string) => `第 ${ply} 手・${classification}`,
      position: (ply: number, side: "red" | "black", sideStep: number, index: number, total: number) =>
        `第 ${ply} 手（${side === "red" ? "紅方" : "黑方"}第 ${sideStep} 步）・第 ${index}／${total} 個重點`,
      played: "你走了",
      best: "比較好的是",
      bestOnBoard: "看棋盤上的藍色箭頭",
      playedFollow: "你這樣走，接下來會是",
      bestFollow: (move: string) => `改走〔${move}〕，接下來會是`,
      bestFollowNoMove: "改走比較好的走法，接下來會是",
      prev: "上一步",
      next: "下一步",
      nextTime: "下次注意",
      legend: { played: "你走的", best: "比較好的走法", danger: "危險的子" },
      followUps,
      advice: {
        walked_into_mate: "走子前先看一下對方有沒有一連串的將軍能殺你。",
        missed_mate: "有機會殺棋時，先把每一個將軍都數一遍。",
        dropped_material: "走子前先數一數，這一步之後雙方各會吃掉什麼。",
        missed_material: "走子前先看看對方有沒有沒保護好的子可以吃。",
        sent_piece: "走子前先看這個落點會不會被對方吃掉。",
        cannon_mount: "走子前先看這一步會不會替對方的炮墊上炮架。",
        abandoned_protection: "移開一個子之前，先看它是不是正在保護別的子。",
        check_capture: "走子前先看對方有沒有一邊將軍一邊吃子的走法。",
        position_type: "子力差不多的時候，多留意子的活動空間和位置。",
      } as Record<string, string>,
    },
    reason: (reason: ReviewReason, level: ReviewExplanationLevel): string => {
      if (reason.kind === "sent_piece" || reason.kind === "abandoned_protection") return exchangeReason(reason, level);
      if (reason.kind === "cannon_mount") return cannonMountReason(reason, level);
      if (reason.kind === "check_capture") return checkCaptureReason(reason, level);
      if (reason.kind === "position_type") return positionReason(reason, level);
      if (reason.kind === "dropped_material" || reason.kind === "missed_material") {
        const evidence = reason.material;
        const dropped = reason.kind === "dropped_material";
        
        const mine = groupPieces(evidence.playedCaptures.filter((capture) => capture.piece.side === evidence.mover).map((capture) => capture.piece));
        const theirs = groupPieces(evidence.playedCaptures.filter((capture) => capture.piece.side !== evidence.mover).map((capture) => capture.piece));
        const won = groupPieces(evidence.bestCaptures.filter((capture) => capture.piece.side !== evidence.mover).map((capture) => capture.piece));
        // An exchange still open at a line end: say so, and do not assert a net result.
        const open = evidence.settled === false ? "（之後可能還有交換）" : "";
        if (dropped) {
          const trade = mine.length > 0
            ? `你會少${mine.join("、")}${theirs.length > 0 ? `、對方少${theirs.join("、")}` : ""}`
            : "你得到的子比最佳走法少";
          switch (level) {
            case "beginner": return open
              ? `引擎算到照你這樣走，接下來${trade}${open}。`
              : `引擎算到照你這樣走，接下來${trade}，淨少子力；最佳走法不會這樣吃虧。`;
            case "intermediate": return `實走主變化中${trade}，最佳走法沒有這個損失${open}。`;
            case "proficient": return `計算線（實走）：${trade}${open}。`;
          }
        }
        const target = won.length > 0 ? won.join("、") : "子力";
        switch (level) {
          case "beginner": return `引擎算到你錯過吃掉對方${target}的機會${open}。`;
          case "intermediate": return `最佳主變化可吃到對方${target}，實走線沒有${open}。`;
          case "proficient": return `計算線：漏了對方${target}${open}。`;
        }
      }
      const moves = reason.moves;
      if (reason.kind === "walked_into_mate") {
        switch (level) {
          case "beginner": return `引擎算到這一步之後，對方可以在 ${moves} 步內將死你。`;
          case "intermediate": return `引擎算到此著讓對方形成 ${moves} 步殺。`;
          case "proficient": return `引擎算到此著入 ${moves} 步殺。`;
        }
      }
      switch (level) {
        case "beginner": return `引擎算到你錯過了在 ${moves} 步內將死對方的機會。`;
        case "intermediate": return `引擎算到此處有 ${moves} 步殺，實戰未走。`;
        case "proficient": return `引擎算到：漏了 ${moves} 步殺。`;
      }
    },
    terminal: "已到終局",
    noContinuation: "尚無續算走法",
    continuationTerminal: "續算抵達終局",
    variationTree: "分支樹",
    mainlineNode: (ply: number, move: string) => ply === 0 ? "起始局面" : `主線第 ${ply} 手：${move}`,
    branchNode: (move: string) => `變線：${move}`,
    branchNote: "分支註解",
    saveNote: "儲存註解",
    branchLoading: "正在載入分支局面…",
    branchEngineThinking: "分支回應思考中…",
    branchEngineAuto: "讓引擎走 4 步",
    branchWinProbability: "這條線的勝率",
    branchError: "分支局面無法重播，請選擇其他節點。",
    userLevel: "我的程度",
    reestimate: "重新估計",
    levelNames: { entry: "入門", beginner: "初學", intermediate: "中等", proficient: "熟練", expert: "高手" } as Record<string, string>,
    levelStatus: (name: string, view: { displayed: boolean; manual: boolean; gameCount: number }) =>
      view.manual ? `程度：${name}（手動指定，不再自動更新；按「重新估計」才會恢復）`
        : view.displayed ? `程度：${name}（依 ${view.gameCount} 盤覆盤自動估計）`
          : `程度：${name}（預設；至少覆盤 3 盤自己下的棋才會估計，目前 ${view.gameCount} 盤）`,
    playedCount: (played: number, counted: number) => `已下 ${played} 盤，${counted} 盤已計入`,
    playedCountManual: (played: number) => `已下 ${played} 盤。程度是你指定的，不另外計入`,
    playedAssisted: (assisted: number) => `。另有 ${assisted} 盤開了即時勝率，不計入`,
    backgroundReviewing: "背景覆盤中…",
    budgetShort: "較快",
    budgetNormal: "標準",
    budgetHigh: "較深入",
    engine: "分析器：內建引擎",
    externalEngineNotice: "網頁版只用內建引擎覆盤。想用外接強引擎（例如 Pikafish），請用命令列：scripts/review-with-engine.sh，會同時輸出覆盤結果與筆記。",
  },
  reviewNote: {
    title: "覆盤筆記", headings: ["對局資訊", "勝率曲線", "對局摘要", "關鍵時刻", "推演分支", "毛病統計", "下次注意", "完整棋譜"],
    curveTitle: "紅方勝率 &amp; 曲線", curveLabel: "紅方勝率", curveCaption: "紅方勝率變化：", boardTitle: (ply: number) => `第 ${ply} 手前`,
    red: "紅方", black: "黑方", redWin: "紅勝", blackWin: "黑勝", draw: "和棋", undecided: "未定",
    knownOpening: "中炮對屏風馬（開局辨識）", standardOpening: "標準開局（未辨識細分）", customOpening: "自訂起局",
    date: "日期", result: "結果", opening: "開局", analyzer: "分析器", quickNodes: "快掃", deepNodes: "深入", nodes: "節點", searchConfig: "搜尋設定",
    total: (moves: number, ply: number, loss: string) => `全局共 ${moves} 手；最大轉折在第 ${ply} 手，勝率損失 ${loss}%。`, clean: "這盤沒有明顯的失誤。",
    moment: (ply: number, move: string) => `第 ${ply} 手・${move}`, played: "實著", bestCandidate: "最佳候選", bestNotation: "最佳著（中文記譜）", noCandidate: "無候選來源", mainLine: "主要變化", noPv: "無可用候選變化", loss: "勝率損失", cause: "原因",
    walkedMate: (moves: number) => `引擎算到這一步之後，對方可以在 ${moves} 步內將死你。`, missedMate: (moves: number) => `引擎算到你錯過了在 ${moves} 步內將死對方的機會。`, unknownReason: "原因尚未判定。",
    noAnnotatedBranches: "沒有附註的推演分支。", kindLabels: {
      walked_into_mate: "走進被殺", missed_mate: "錯過殺棋", dropped_material: "丟子", sent_piece: "送吃", cannon_mount: "炮架",
      missed_material: "錯過得子", abandoned_protection: "放掉保護", check_capture: "被抽將", position_type: "局面型",
    } satisfies Record<ReviewReasonKind, string>,
    kindCount: (label: string, count: number) => `${label}：${count} 次`, unknownCount: (count: number) => `原因尚未判定：${count} 次`,
    cliConfig: (timeoutMs: number) => `外部 UCI 引擎（命令列覆盤，單步逾時 ${timeoutMs} 毫秒）`,
    nextFocus: "引擎可證明最多的是", pendingFocus: "下次注意：待分析", startFen: "起始 FEN", chartText: "勝率曲線圖", pgnResult: "*",
    incomplete: "分析尚未完成，完成完整覆盤後才能產生筆記。", generate: "產生覆盤筆記", generating: "正在產生筆記…", ready: "筆記已產生並儲存。", generateError: "筆記無法產生，請稍後重試。", snapshotError: "分析結果無法保存，請重新分析。", copy: "複製純文字", copied: "已複製筆記純文字。", copyError: "無法複製，請檢查瀏覽器剪貼簿權限。", downloadMarkdown: "下載 Markdown", savePdf: "存成 PDF", pdfError: "無法開啟列印畫面，請稍後重試。", pdfFallback: "這個瀏覽器不能直接列印，已在新分頁開啟報告；請用瀏覽器的分享或列印功能存成 PDF。",
    pieces: { k: "將", a: "士", b: "象", n: "馬", r: "車", c: "砲", p: "卒", K: "帥", A: "仕", B: "相", N: "馬", R: "車", C: "炮", P: "兵" },
  },
  reviewPrint: {
    docTitle: "覆盤報告",
    headings: { header: "對局資訊", curve: "勝率曲線", summary: "對局摘要", keyMoves: "關鍵步", moves: "每一步走法", improve: "哪裡要改進" },
    players: (red: string | null, black: string | null) => `${red ? `${red}（紅）` : "紅方"} 對 ${black ? `${black}（黑）` : "黑方"}`,
    youPlay: "你執", sideName: { red: "紅方", black: "黑方" } as Record<string, string>,
    curveTitle: "你的勝率曲線", curveLabel: "你的勝率（越高越好）", curveCaption: "橫軸是棋局進行的順序，曲線越高代表你的局面越好。",
    keyIntro: (count: number) => `這盤有 ${count} 步要注意（和覆盤頁列的重點步相同），依損失由大到小排列。`,
    legend: "圖上橘色箭頭是你走的，藍色箭頭是比較好的走法。",
    momentTitle: (round: number, side: string) => `第 ${round} 回合・${side}`,
    total: (moves: number, round: number, side: string, loss: string) => `全局共 ${moves} 手；最大轉折在第 ${round} 回合・${side}，勝率損失 ${loss}%。`,
    played: "你走的", better: "比較好的走法", reasonLabel: "原因", adviceLabel: "下次注意",
    lossText: (percent: string) => `勝率少了 ${percent}%`,
    moveNo: "手數", red: "紅方", black: "黑方", youMark: "（你）", betterNote: (move: string) => `較好：${move}`,
    countsIntro: "你的這些步裡，出現各類毛病的次數：",
    focusKind: (label: string) => `這盤最常出現的是「${label}」。`, focusNone: "這盤沒有特別集中的毛病，繼續保持。",
    keyEmptyButProblems: "沒有需要特別注意的大失誤，較小的問題見下方每一步走法和改進段。",
    unknownMove: "未知著法", footer: "由象棋教練在你的裝置上產生",
  },
  difficultyLabel: "電腦難度",
  difficultyNote: "1 最弱、10 最強；電腦互相對下時，相差兩級的高的一方約九成會贏。",
  engineDifficultyStatus: (level: number) => `電腦已使用難度 ${level} 回應。`,
  moveCountSuffix: "手",
  noMoves: "尚未走棋",
  engineNotice: "棋局與搜尋都在你的裝置上執行。",
  searching: "電腦思考中…",
  live: {
    toggle: "即時勝率",
    label: "目前局面的紅方勝率",
    assisted: "本局已開啟輔助，請勿納入程度估計。",
    notAvailable: "尚無即時評估",
  },
  loading: "棋局載入中…",
  workerStateUnknown: "棋局狀態未確認",
  workerInterrupted: "背景棋局工作已中斷；畫面局面可能未同步，重新載入將開始新局。",
  selectionHint: "選擇自己一方的棋子。",
  gameEndedHint: "這盤棋已經結束，不能再走子。",
  destinationHint: "已選擇 {square}，請點選標示的落點。",
  outcome: {
    red_win: "紅方勝",
    black_win: "黑方勝",
    draw: "和棋",
  },
  errors: {
    invalidBoard: "棋盤資料格式錯誤。",
    invalidMove: "這一步不合法，棋局沒有改變。",
    notInitialized: "棋局尚未載入，請重新開始。",
    initializationFailed: "棋局載入失敗，請重新開始再試一次。",
    workerFailed: "背景工作已中斷；此局不會繼續操作，請重新載入新局。",
  },
  river: {
    redBank: "楚河",
    blackBank: "漢界",
  },
  pieces: {
    red: {
      king: "帥",
      advisor: "仕",
      elephant: "相",
      horse: "馬",
      rook: "車",
      cannon: "炮",
      pawn: "兵",
    },
    black: {
      king: "將",
      advisor: "士",
      elephant: "象",
      horse: "馬",
      rook: "車",
      cannon: "炮",
      pawn: "卒",
    },
  },
  aria: {
    square: (square: string, piece: string) =>
      piece ? `${square}，${piece}` : square,
    selected: (square: string) => `已選擇${square}`,
    legalDestination: (square: string) => `${square}，合法落點`,
  },
} as const;
