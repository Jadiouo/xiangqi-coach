//! TEST_PLAN 6.3.7: a move that lets the opponent capture a piece with check ("被抽將",
//! SPEC 8.4 item 8). One positive position and look-alike negatives.

mod common;

use common::{kind_of, review};
use xq_core::PieceKind;
use xq_review::ReasonKind;

const BEST: &[&str] = &["d0d1", "e9e8"];

#[test]
fn moving_the_king_onto_the_rooks_file_lets_it_take_the_horse_with_check() {
    // The black rook a3 can always take the red horse e3, but only from the moment the red
    // king stands on the e-file does that capture also give check (nothing can take back).
    let result = review(
        "4k4/9/9/9/9/9/r3N4/9/9/3K5 w - - 0 1",
        "d0e0",
        BEST,
        &["d0e0", "a3e3", "e0d0"],
    );
    let reason = result.reason.expect("capture with check is a reason");
    assert_eq!(reason.kind, ReasonKind::CheckCapture);
    let evidence = reason.check_capture.expect("evidence is attached");
    assert_eq!(evidence.victim.kind, PieceKind::Horse);
    assert_eq!(evidence.victim_square.to_iccs(), "e3");
    assert_eq!(evidence.attacker.kind, PieceKind::Rook);
    assert_eq!(evidence.attacker_from.to_iccs(), "a3");
    assert_eq!(evidence.net, -300);
}

#[test]
fn the_same_capture_without_check_is_not_this_reason() {
    // The king stays on the d-file, so Rxe3 gives no check.
    let result = review(
        "4k4/9/9/9/9/9/r3N4/9/9/3K5 w - - 0 1",
        "d0d1",
        BEST,
        &["d0d1", "a3e3", "d1d0"],
    );
    assert_ne!(kind_of(&result), Some(ReasonKind::CheckCapture));
}

#[test]
fn a_capture_with_check_that_can_be_taken_back_is_not_this_reason() {
    // Same idea, but the red rook h3 takes the checking rook on e3, which also ends the check.
    let result = review(
        "4k4/9/9/9/9/9/r3N2R1/9/9/3K5 w - - 0 1",
        "d0e0",
        BEST,
        &["d0e0", "a3e3", "h3e3"],
    );
    assert_ne!(kind_of(&result), Some(ReasonKind::CheckCapture));
}

#[test]
fn a_capture_with_check_that_was_already_possible_is_not_blamed_on_this_move() {
    // The red king is already on the e-file and Rxe3+ was available before the quiet move.
    let result = review(
        "4k4/9/9/9/9/9/r3N4/9/9/4K4 w - - 0 1",
        "e0d0",
        BEST,
        &["e0d0", "a3e3", "d0e0"],
    );
    assert_ne!(kind_of(&result), Some(ReasonKind::CheckCapture));
}

#[test]
fn a_capture_with_check_available_both_before_and_after_an_unrelated_move_is_not_blamed_on_it() {
    // The red king already stands on the e-file, so Rxe3+ is possible before the move and
    // remains possible after the quiet rook move i0-i1. The move did not make it possible.
    let result = review(
        "4k4/9/9/9/9/9/r3N4/9/9/4K3R w - - 0 1",
        "i0i1",
        BEST,
        &["i0i1", "a3e3", "e0d0"],
    );
    assert_ne!(kind_of(&result), Some(ReasonKind::CheckCapture));
}
