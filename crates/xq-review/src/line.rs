//! Turn an engine line (a sequence of moves) into Chinese-notation steps.

use xq_core::{Game, Move, Piece, Side, format_chinese_move};

/// One step of a described line.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LineStep {
    pub mv: Move,
    /// The side that makes this move.
    pub side: Side,
    /// Traditional Chinese notation, computed against the position at this step.
    pub notation: String,
    /// The piece this move captures, if any.
    pub captured: Option<Piece>,
}

/// Describe up to `max_plies` moves of `moves`, starting from `start`.
///
/// The line is cut at the first illegal move, and nothing is described once the game is over
/// (the step that ends the game is still included). Never panics.
pub fn describe_line(start: &Game, moves: &[Move], max_plies: usize) -> Vec<LineStep> {
    let mut game = start.clone();
    let mut steps = Vec::new();
    for &movement in moves.iter().take(max_plies) {
        if game.outcome().is_some() {
            break;
        }
        let Ok(notation) = format_chinese_move(game.position(), movement) else {
            break;
        };
        let side = game.position().side_to_move();
        let captured = game.position().piece_at(movement.to);
        if game.play(movement).is_err() {
            break;
        }
        steps.push(LineStep {
            mv: movement,
            side,
            notation,
            captured,
        });
    }
    steps
}

/// Longest line (in plies) shown by a move comparison.
pub const COMPARISON_PLIES: usize = 4;

/// The played line and the best line of a marked move, ready for the review UI.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MoveComparison {
    /// What the engine expects after the played move (the played move itself is not included).
    pub played_line: Vec<LineStep>,
    /// The best line, starting with the best move.
    pub best_line: Vec<LineStep>,
    /// The line reached `COMPARISON_PLIES` plies or ended the game.
    pub played_complete: bool,
    pub best_complete: bool,
    /// False when the side to move at the end of the line still has a capture available, so a
    /// material balance read from the line may change ("the exchange is not over").
    pub played_settled: bool,
    pub best_settled: bool,
}

/// True when `steps` is as long as a comparison line gets or the game is over after them.
pub(crate) fn line_is_complete(start: &Game, steps: &[LineStep]) -> bool {
    if steps.len() >= COMPARISON_PLIES {
        return true;
    }
    let mut game = start.clone();
    for step in steps {
        if game.play(step.mv).is_err() {
            return false;
        }
    }
    game.outcome().is_some()
}

/// Nodes for each analyzer call that tops up a short line; same as the wasm continuation step.
pub const EXTENSION_NODES: u64 = 20_000;

/// False only when some step of `steps` captured a piece and the side to move at the end still
/// has a capture available. A line without any capture has no exchange to leave open, and a
/// finished game is settled.
pub(crate) fn line_is_settled(start: &Game, steps: &[LineStep]) -> bool {
    if steps.iter().all(|step| step.captured.is_none()) {
        return true;
    }
    let mut game = start.clone();
    for step in steps {
        if game.play(step.mv).is_err() {
            return true;
        }
    }
    if game.outcome().is_some() {
        return true;
    }
    let mut position = game.position().clone();
    let side = position.side_to_move();
    !position.legal_moves().into_iter().any(|m| {
        position
            .piece_at(m.to)
            .is_some_and(|piece| piece.side != side)
    })
}
