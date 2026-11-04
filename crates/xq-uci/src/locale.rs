use xq_core::{ImportWarning, NotationFormat, Side};
use xq_review::Classification;

pub const ROOT_HELP: &str = "\
象棋教練命令列

用法：
  xq-uci
      以 UCI 協定模式啟動引擎，從標準輸入讀取指令。
  xq-uci review --record <棋譜檔> --engine <引擎執行檔> [選項]
      使用外部 UCI 引擎分析一份棋譜，並將結構化覆盤輸出為 JSON。
  xq-uci spar --engine <引擎執行檔> [選項]
      內建引擎對外部 UCI 引擎（例如 Pikafish）對打，輸出每盤棋與勝負統計 JSON。
  xq-uci --help
      顯示這份說明。

棋譜與外部引擎的完整選項請執行：xq-uci review --help
";

pub const REVIEW_HELP: &str = "\
使用外部 UCI 引擎分析棋譜並輸出結構化覆盤 JSON。

用法：
  xq-uci review --record <棋譜檔> --engine <引擎執行檔> [選項]

必要參數：
  --record <路徑>       要匯入的棋譜文字檔。
  --engine <路徑>       外部 UCI 引擎執行檔；程式會以 UCI 協定啟動它。

選項：
  --nodes <數量>        快速分析每個局面的節點上限（預設：1000）。
  --deep-nodes <數量>   深入分析節點損失超過 5% 的局面（預設：10000）。
  --timeout-ms <毫秒>   每次 UCI 交換的逾時時間（預設：30000）。
  -h, --help            顯示這份說明。

棋譜匯入或引擎分析失敗時，命令會以非零狀態結束，錯誤訊息寫到標準錯誤。
JSON 的 schema_version 為 1；format、side、classification 與 warning code 是穩定識別碼。
";

pub const SPAR_HELP: &str = "\
內建引擎對外部 UCI 引擎對打，並以 JSON 記錄每盤棋與統計（TEST_PLAN §5.4，記錄而非門檻）。

用法：
  xq-uci spar --engine <引擎執行檔> [選項]

必要參數：
  --engine <路徑>         外部 UCI 引擎執行檔；程式只透過 UCI 文字協定與它溝通。

選項：
  --openings <路徑>       開局檔：每行一組以空白分隔的 ICCS 著法，# 開頭為註解。
                          每個開局內建引擎各執紅、黑一盤（預設：只有起始局面）。
  --nodes <數量>          內建引擎每步的節點上限（預設：10000）。
  --engine-nodes <數量>   外部引擎每步的節點上限（預設：100）。
  --max-plies <數量>      單盤總步數上限，超過記為 unfinished（預設：300）。
  --timeout-ms <毫秒>     外部引擎每次 UCI 交換的逾時時間（預設：30000）。
  -h, --help              顯示這份說明。

任何一步外部引擎逾時、當掉、回傳不合法走法時，命令以非零狀態結束且不輸出部分報告。
";

pub fn spar_openings_read_error(path: &str) -> String {
    format!("無法讀取開局檔「{path}」。")
}

pub fn spar_openings_invalid(line: usize, token: &str) -> String {
    format!("開局檔第 {line} 行的著法「{token}」不合法。")
}

pub fn format_metadata(format: Option<NotationFormat>) -> (&'static str, &'static str) {
    match format {
        Some(NotationFormat::Iccs) => ("iccs", "座標記譜"),
        Some(NotationFormat::Chinese) => ("chinese", "中文記譜"),
        Some(NotationFormat::Pgn) => ("pgn", "PGN 樣式"),
        Some(NotationFormat::DhtmlXq) => ("dhtml_xq", "東萍格式"),
        None => ("unknown", "未知格式"),
    }
}

pub fn side_metadata(side: Side) -> (&'static str, &'static str) {
    match side {
        Side::Red => ("red", "紅方"),
        Side::Black => ("black", "黑方"),
    }
}

pub fn classification_metadata(classification: Classification) -> (&'static str, &'static str) {
    match classification {
        Classification::Unclassified => ("unclassified", "未分類"),
        Classification::Good => ("good", "好棋"),
        Classification::UniqueMove => ("unique_move", "唯一著"),
        Classification::Inaccuracy => ("inaccuracy", "緩著"),
        Classification::DoubtfulMove => ("doubtful_move", "疑問手"),
        Classification::Mistake => ("mistake", "失誤"),
        Classification::Blunder => ("blunder", "大漏著"),
        Classification::MissedMate => ("missed_mate", "錯過殺棋"),
    }
}

pub fn warning_metadata(warning: ImportWarning) -> serde_json::Value {
    match warning {
        ImportWarning::VariationsNotImported => serde_json::json!({
            "code": "variations_not_imported",
            "message": "棋譜含有變著，但目前未匯入變著。"
        }),
    }
}

pub fn review_error(code: &str, message: &str, cause: &str) -> serde_json::Value {
    serde_json::json!({
        "error": {
            "code": code,
            "message": message,
            "cause": cause,
        }
    })
}

pub fn review_error_message(code: &str) -> &'static str {
    match code {
        "unknown_command" => "不支援這個命令，請查看 --help。",
        "invalid_arguments" => "命令參數有誤，請查看 --help。",
        "record_read_failed" => "無法讀取棋譜檔。",
        "record_import_failed" => "棋譜格式錯誤或含有不合法著法。",
        "record_replay_failed" => "棋譜重播失敗。",
        "engine_start_failed" => "無法啟動外部 UCI 引擎，請檢查執行檔路徑與執行權限。",
        "engine_analysis_failed" => "外部 UCI 引擎分析失敗。",
        "output_failed" => "無法產生覆盤輸出。",
        "openings_read_failed" => "無法讀取開局檔。",
        "openings_invalid" => "開局檔含有不合法的著法。",
        _ => "覆盤命令執行失敗。",
    }
}

pub fn unknown_command_error(command: &str) -> String {
    format!("不支援的命令「{command}」，請查看 --help。")
}

pub fn unexpected_global_argument_error(argument: &str) -> String {
    format!("全域命令列模式不支援參數 {argument}，請查看 --help。")
}

#[derive(Clone, Copy)]
pub enum ArgumentProblem {
    UnknownOption,
    MissingValue,
    MissingRequired,
    InvalidInteger,
    MustBePositive,
}

pub fn argument_error(problem: ArgumentProblem, option: Option<&str>) -> String {
    match (problem, option) {
        (ArgumentProblem::UnknownOption, Some(option)) => format!("不認得參數 {option}。"),
        (ArgumentProblem::MissingValue, Some(option)) => format!("參數 {option} 缺少值。"),
        (ArgumentProblem::MissingRequired, Some(option)) => {
            format!("缺少必要參數 {option}。")
        }
        (ArgumentProblem::InvalidInteger, Some(option)) => {
            format!("參數 {option} 的值必須是整數。")
        }
        (ArgumentProblem::MustBePositive, _) => "節點上限與逾時時間都必須大於零。".to_owned(),
        _ => "命令參數有誤，請查看 --help。".to_owned(),
    }
}

pub fn record_read_error(path: &str) -> String {
    format!("無法讀取棋譜檔「{path}」。")
}

pub fn engine_start_error(path: &str) -> String {
    format!("無法啟動外部 UCI 引擎「{path}」，請檢查路徑與執行權限。")
}

pub fn record_import_error(step: usize, token: &str, reason: &str) -> String {
    if step == 0 {
        format!("棋譜起始局面「{token}」無法匯入：{reason}")
    } else {
        format!("第 {step} 手「{token}」無法匯入：{reason}")
    }
}

pub fn empty_mainline_after_variation() -> String {
    "棋譜從變著分支開始，目前沒有可覆盤的主線；變著尚未匯入。".to_owned()
}

pub fn empty_record_error() -> String {
    "棋譜沒有可覆盤的合法著法，請確認檔案包含棋步。".to_owned()
}

#[derive(Clone, Copy)]
pub enum EngineFailure {
    Timeout,
    Protocol,
    Exited,
    Cancelled,
    Io,
    Other,
}

pub fn engine_analysis_error(ply: usize, pass: &str, failure: EngineFailure) -> String {
    let pass = match pass {
        "deep" => "深入",
        "spar" => "對打時的",
        _ => "快速",
    };
    let description = match failure {
        EngineFailure::Timeout => "逾時",
        EngineFailure::Protocol => "UCI 回應無效",
        EngineFailure::Exited => "外部引擎已結束",
        EngineFailure::Cancelled => "分析已取消",
        EngineFailure::Io => "與外部引擎的輸入輸出發生錯誤",
        EngineFailure::Other => "分析失敗",
    };
    format!("第 {ply} 手{pass}分析{description}。")
}
