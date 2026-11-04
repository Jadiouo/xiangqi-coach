//! TEST_PLAN 6.3.9 and SPEC 8.4: reasons are checked in order and the first that holds wins:
//! walked into mate, missed mate, dropped material, missed material, sent piece, abandoned
//! protection, capture with check, position type.

mod common;

use common::{kind_of, review, review_with_after};
use xq_review::{ReasonKind, ReviewScore};

const DROP_FEN: &str = "4k4/9/9/9/r8/9/9/9/3K5/R8 w - - 0 1";

#[test]
fn walking_into_mate_and_dropping_a_rook_report_only_the_mate() {
    // Without the mate score this exact position and line is a dropped rook (see next test).
    let result = review_with_after(
        DROP_FEN,
        "d1d2",
        &["a0a5", "e9e8"],
        &["d1d2", "a5a0"],
        ReviewScore::mate_in(2),
    );
    let reason = result.reason.expect("a reason exists");
    assert_eq!(reason.kind, ReasonKind::WalkedIntoMate);
    assert_eq!(reason.moves, 2);
    assert!(reason.material.is_none(), "the rook loss is not mentioned");
}

#[test]
fn the_same_line_without_a_mate_is_reported_as_the_dropped_rook() {
    let result = review(DROP_FEN, "d1d2", &["a0a5", "e9e8"], &["d1d2", "a5a0"]);
    assert_eq!(kind_of(&result), Some(ReasonKind::DroppedMaterial));
}

#[test]
fn missing_a_mate_beats_a_material_loss_in_the_played_line() {
    let game = common::review_best_score(
        DROP_FEN,
        "d1d2",
        &["a0a5", "e9e8"],
        &["d1d2", "a5a0"],
        ReviewScore::mate_in(3),
    );
    assert_eq!(kind_of(&game), Some(ReasonKind::MissedMate));
}

#[test]
fn a_proven_material_loss_beats_the_exchange_reasons() {
    // Horse b2->c4 hangs to the pawn. With equal-length lines the material ledger proves it
    // (dropped material, 6.3.3); with unequal lines only the exchange reason (6.3.5) is left.
    let fen = "4k4/9/9/9/2p6/9/9/1N7/9/3K5 w - - 0 1";
    let proven = review(
        fen,
        "b2c4",
        &["d0d1", "e9e8", "d1d0"],
        &["b2c4", "c5c4", "d0d1"],
    );
    assert_eq!(kind_of(&proven), Some(ReasonKind::DroppedMaterial));
    let unproven = review(fen, "b2c4", &["d0d1", "e9e8"], &["b2c4", "c5c4", "d0d1"]);
    assert_eq!(kind_of(&unproven), Some(ReasonKind::SentPiece));
}

#[test]
fn a_piece_sent_away_beats_the_protection_it_also_abandoned() {
    // The rook leaves the cannon's side (abandoning it) and lands where the black horse takes
    // it: both are true, the first listed (sent piece) is the one reported.
    let result = review(
        "4k4/9/9/9/RCr1P4/2n6/9/9/9/3K5 w - - 0 1",
        "a5a3",
        &["d0d1", "e9e8"],
        &["a5a3", "c4a3", "d0d1"],
    );
    assert_eq!(kind_of(&result), Some(ReasonKind::SentPiece));
}

#[test]
fn an_abandoned_protection_beats_the_static_position_type() {
    let result = review(
        "4k4/9/9/9/RCr1P4/9/9/9/9/3K5 w - - 0 1",
        "a5a4",
        &["d0d1", "e9e8"],
        &["a5a4", "c5b5", "d0d1"],
    );
    assert_eq!(kind_of(&result), Some(ReasonKind::AbandonedProtection));
}
