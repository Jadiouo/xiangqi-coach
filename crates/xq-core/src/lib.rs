//! Pure Xiangqi board and move-generation primitives.

mod game;
mod hash;
mod locale;
mod notation;
mod position;
mod record;

pub use game::{Game, GameOutcome};
pub use notation::{MoveNotationError, format_chinese_move, format_iccs_move, parse_chinese_move};
pub use record::{
    ImportError, ImportErrorKind, ImportResult, ImportWarning, NotationFormat, import_record,
};

pub use position::{
    FenError, Move, MoveError, Piece, PieceKind, Position, STARTPOS_FEN, Side, Square, Undo,
    legal_recaptures_after_hypothetical_capture, position_after_hypothetical_move,
};

#[cfg(test)]
mod tests;
