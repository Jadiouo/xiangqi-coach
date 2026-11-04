//! `PlyAnalysis::comparison`: the "what you played vs. the best line" data, filled only for
//! doubtful moves, mistakes and blunders, straight from the engine lines (no extra search).

mod common;

use common::{review, review_scores};
use xq_core::{Game, Move, Position, Side, format_chinese_move};
use xq_review::{Classification, PlyAnalysis, ReviewScore};

const FEN: &str = "4k4/9/9/9/2p6/9/9/1N7/9/3K5 w - - 0 1";

fn mv(text: &str) -> Move {
    Move::from_iccs(text).unwrap()
}

fn moves_of(steps: &[xq_review::LineStep]) -> Vec<String> {
    steps.iter().map(|s| s.mv.to_iccs()).collect()
}

fn flagged(result: &PlyAnalysis) {
    assert!(matches!(
        result.classification,
        Classification::DoubtfulMove | Classification::Mistake | Classification::Blunder
    ));
}

#[test]
fn a_flagged_move_carries_both_lines() {
    let result = review(FEN, "b2c4", &["d0d1", "e9e8"], &["b2c4", "e9e8", "d0d1"]);
    flagged(&result);
    let comparison = result.comparison.expect("comparison on a flagged move");
    // The played line is what follows the played move (the move itself is not repeated).
    assert_eq!(moves_of(&comparison.played_line), ["e9e8", "d0d1"]);
    // The best line starts with the best move.
    assert_eq!(moves_of(&comparison.best_line), ["d0d1", "e9e8"]);
    assert_eq!(comparison.played_line[0].side, Side::Black);
    assert_eq!(comparison.best_line[0].side, Side::Red);
}

#[test]
fn notation_follows_the_replayed_positions() {
    let result = review(FEN, "b2c4", &["d0d1", "e9e8"], &["b2c4", "e9e8", "d0d1"]);
    let comparison = result.comparison.unwrap();
    let start = Game::new(Position::from_fen(FEN).unwrap());
    assert_eq!(
        comparison.best_line[0].notation,
        format_chinese_move(start.position(), mv("d0d1")).unwrap()
    );
    let mut after = start.clone();
    after.play(mv("b2c4")).unwrap();
    assert_eq!(
        comparison.played_line[0].notation,
        format_chinese_move(after.position(), mv("e9e8")).unwrap()
    );
}

#[test]
fn short_lines_are_not_complete() {
    let result = review(FEN, "b2c4", &["d0d1", "e9e8"], &["b2c4", "e9e8", "d0d1"]);
    let comparison = result.comparison.unwrap();
    assert!(!comparison.played_complete);
    assert!(!comparison.best_complete);
}

#[test]
fn lines_are_cut_at_four_plies_and_then_complete() {
    let result = review(
        FEN,
        "b2c4",
        &["d0d1", "e9e8", "d1d0", "e8e9", "d0d1"],
        &["b2c4", "e9e8", "d0d1", "e8e9", "d1d0", "e9e8"],
    );
    flagged(&result);
    let comparison = result.comparison.unwrap();
    assert_eq!(comparison.best_line.len(), 4);
    assert_eq!(comparison.played_line.len(), 4);
    assert!(comparison.best_complete);
    assert!(comparison.played_complete);
}

#[test]
fn a_line_that_ends_the_game_is_complete() {
    let fen = "5k3/9/9/9/R4n3/6N2/9/9/9/3RK4 w - - 0 1";
    let start = Game::new(Position::from_fen(fen).unwrap());
    let mut probe = Position::from_fen(fen).unwrap();
    let mating = probe
        .legal_moves()
        .into_iter()
        .find(|&m| {
            let mut g = start.clone();
            g.play(m).unwrap();
            g.outcome().is_some()
        })
        .expect("mate in one exists");
    let other = probe
        .legal_moves()
        .into_iter()
        .find(|&m| {
            m != mating && {
                let mut g = start.clone();
                g.play(m).unwrap();
                g.outcome().is_none()
            }
        })
        .unwrap();
    let result = review_scores(
        fen,
        &other.to_iccs(),
        &[&mating.to_iccs()],
        &[&other.to_iccs(), "f9e9"],
        ReviewScore::centipawns(400),
        ReviewScore::centipawns(0),
    );
    flagged(&result);
    let comparison = result.comparison.expect("comparison");
    assert_eq!(moves_of(&comparison.best_line), [mating.to_iccs()]);
    assert!(comparison.best_complete, "the best line ends the game");
}

#[test]
fn an_unmarked_move_has_no_comparison() {
    let result = review_scores(
        FEN,
        "d0d1",
        &["d0d1", "e9e8"],
        &["d0d1", "e9e8"],
        ReviewScore::centipawns(0),
        ReviewScore::centipawns(0),
    );
    assert_eq!(result.classification, Classification::Good);
    assert!(result.comparison.is_none());
}

#[test]
fn a_missed_mate_also_carries_the_comparison() {
    let fen = "5k3/9/9/9/R4n3/6N2/9/9/9/3RK4 w - - 0 1";
    let start = Game::new(Position::from_fen(fen).unwrap());
    let mut probe = Position::from_fen(fen).unwrap();
    let moves = probe.legal_moves();
    let mating = *moves
        .iter()
        .find(|&&m| {
            let mut g = start.clone();
            g.play(m).unwrap();
            g.outcome().is_some()
        })
        .unwrap();
    let other = *moves
        .iter()
        .find(|&&m| {
            m != mating && {
                let mut g = start.clone();
                g.play(m).unwrap();
                g.outcome().is_none()
            }
        })
        .unwrap();
    let result = review_scores(
        fen,
        &other.to_iccs(),
        &[&mating.to_iccs()],
        &[&other.to_iccs(), "f9e9"],
        ReviewScore::mate_in(1),
        ReviewScore::centipawns(0),
    );
    assert_eq!(result.classification, Classification::MissedMate);
    let comparison = result.comparison.expect("comparison on a missed mate");
    assert_eq!(moves_of(&comparison.best_line), [mating.to_iccs()]);
    assert!(comparison.best_complete);
}

/// Red takes the pawn on c4 and the black rook on c9 can take the horse back.
const CAPTURE_FEN: &str = "2r1k4/9/9/9/9/2p6/9/1N7/9/3K5 w - - 0 1";

#[test]
fn a_line_with_a_capture_and_a_capture_on_offer_is_not_settled() {
    let result = review(CAPTURE_FEN, "d0d1", &["b2c4"], &["d0d1", "e9e8"]);
    flagged(&result);
    let comparison = result.comparison.unwrap();
    assert_eq!(
        comparison.best_line[0].captured.map(|p| p.side),
        Some(Side::Black)
    );
    assert!(!comparison.best_settled);
    // The played line has no capture at all.
    assert!(comparison.played_settled);
}

#[test]
fn a_line_without_any_capture_is_always_settled() {
    // b2c4 puts the horse where the pawn c5 can take it, but nothing is captured in the line:
    // there is no exchange to speak of.
    let result = review(FEN, "d0d1", &["b2c4"], &["d0d1", "e9e8"]);
    flagged(&result);
    let comparison = result.comparison.unwrap();
    assert!(comparison.best_line.iter().all(|s| s.captured.is_none()));
    assert!(comparison.best_settled);
    assert!(comparison.played_settled);
}
