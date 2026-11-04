//! Static user-facing language for the pure core.
use crate::record::{ImportError, ImportErrorKind};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ImportErrorText {
    UnknownFormat,
    InvalidNotation,
    IllegalMove,
    Ambiguous,
    InvalidFen,
    InvalidBinit,
    MissingMoves,
    MalformedMoves,
    InvalidLegacyMarker,
    NonDigitCoordinates,
    NonDigitLegacySequence,
    CoordinatesOutOfBounds,
    GameOver,
}

pub(crate) fn import_error_message_zh(error: &ImportError) -> String {
    let reason = match error.reason {
        ImportErrorText::UnknownFormat => "無法辨識棋譜格式",
        ImportErrorText::InvalidNotation => "格式錯誤或找不到符合的合法走法",
        ImportErrorText::IllegalMove => "此步不合法",
        ImportErrorText::Ambiguous => "記譜有歧義",
        ImportErrorText::InvalidFen => "FEN 局面錯誤",
        ImportErrorText::InvalidBinit => "東萍起始局面格式錯誤",
        ImportErrorText::MissingMoves => "缺少走法資料",
        ImportErrorText::MalformedMoves => "東萍走法資料長度錯誤",
        ImportErrorText::InvalidLegacyMarker => "東萍舊式走法標記格式錯誤",
        ImportErrorText::NonDigitCoordinates => "東萍走法座標必須使用數字",
        ImportErrorText::NonDigitLegacySequence => "東萍舊式走法序號必須使用數字",
        ImportErrorText::CoordinatesOutOfBounds => "東萍座標超出棋盤",
        ImportErrorText::GameOver => "棋局已結束",
    };
    let decoded = error
        .decoded_move
        .as_ref()
        .map(|move_text| format!("（解碼為 {move_text}）"))
        .unwrap_or_default();
    let candidates = if error.kind == ImportErrorKind::Ambiguous {
        format!("；可選走法：{}", error.candidates.join("、"))
    } else {
        String::new()
    };
    format!(
        "第 {} 步「{}」{}：{}{}",
        error.step, error.token, decoded, reason, candidates
    )
}
