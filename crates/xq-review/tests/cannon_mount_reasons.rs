//! TEST_PLAN 6.3.16 (SPEC 8.4 item 6): a move that becomes the screen ("炮架") an enemy cannon
//! needs to capture one of the mover's pieces. One positive position per side and look-alike
//! negatives.

mod common;

use common::{kind_of, review};
use xq_core::{PieceKind, Side};
use xq_review::ReasonKind;

// Black cannon a5, red rook a0, red horse b0. Nothing stands on the a-file between cannon and
// rook, so the cannon cannot capture. After the horse goes to a2 it is the screen.
const RED_FEN: &str = "4k4/9/9/9/c8/9/9/9/9/RN1K5 w - - 0 1";
const RED_BEST: &[&str] = &["d0d1", "e9e8"];

#[test]
fn a_horse_stepping_between_the_cannon_and_the_rook_becomes_the_screen() {
    let result = review(RED_FEN, "b0a2", RED_BEST, &["b0a2", "a5a0", "d0d1"]);
    let reason = result.reason.expect("the quiet-looking move has a reason");
    assert_eq!(reason.kind, ReasonKind::CannonMount);
    let evidence = reason.cannon_mount.expect("evidence is attached");
    assert_eq!(evidence.screen.kind, PieceKind::Horse);
    assert_eq!(evidence.screen.side, Side::Red);
    assert_eq!(evidence.screen_square.to_iccs(), "a2");
    assert_eq!(evidence.cannon.kind, PieceKind::Cannon);
    assert_eq!(evidence.cannon.side, Side::Black);
    assert_eq!(evidence.cannon_from.to_iccs(), "a5");
    assert_eq!(evidence.victim.kind, PieceKind::Rook);
    assert_eq!(evidence.victim_square.to_iccs(), "a0");
    assert_eq!(evidence.net, -600);
}

#[test]
fn black_can_mount_the_enemy_cannon_too() {
    // Mirror image: red cannon a4, black rook a9, black horse b9 steps to a7.
    let result = review(
        "rn1k5/9/9/9/9/C8/9/9/9/4K4 b - - 0 1",
        "b9a7",
        &["d9d8", "e0e1"],
        &["b9a7", "a4a9", "d9d8"],
    );
    let reason = result.reason.expect("a reason is given");
    assert_eq!(reason.kind, ReasonKind::CannonMount);
    let evidence = reason.cannon_mount.unwrap();
    assert_eq!(evidence.screen.side, Side::Black);
    assert_eq!(evidence.victim.kind, PieceKind::Rook);
    assert_eq!(evidence.victim_square.to_iccs(), "a9");
    assert_eq!(evidence.cannon_from.to_iccs(), "a4");
}

#[test]
fn a_move_that_does_not_touch_the_cannons_file_is_not_this_reason() {
    let result = review(RED_FEN, "b0c2", RED_BEST, &["b0c2", "e9e8", "d0d1"]);
    assert_ne!(kind_of(&result), Some(ReasonKind::CannonMount));
}

#[test]
fn a_capture_that_was_already_possible_is_not_blamed_on_this_move() {
    // A red pawn on a3 is already a screen, so Cxa0 existed before the quiet horse move.
    let result = review(
        "4k4/9/9/9/c8/9/P8/9/9/RN1K5 w - - 0 1",
        "b0c2",
        RED_BEST,
        &["b0c2", "a5a0", "d0d1"],
    );
    assert_ne!(kind_of(&result), Some(ReasonKind::CannonMount));
}

#[test]
fn a_protected_victim_that_is_even_on_the_exchange_is_not_this_reason() {
    // Elephant c0 goes to a2 and is the screen, but the red rook b0 takes the cannon back on
    // a0: horse for cannon, nothing lost.
    let result = review(
        "4k4/9/9/9/c8/9/9/9/3K5/NRB6 w - - 0 1",
        "c0a2",
        RED_BEST,
        &["c0a2", "a5a0", "b0a0"],
    );
    assert_ne!(kind_of(&result), Some(ReasonKind::CannonMount));
}

#[test]
fn the_engines_own_reply_must_be_the_cannon_capture() {
    // The cannon could capture, but the engine plays something else, so the sentence would
    // contradict the line shown beside it.
    let result = review(RED_FEN, "b0a2", RED_BEST, &["b0a2", "e9e8", "d0d1"]);
    assert_ne!(kind_of(&result), Some(ReasonKind::CannonMount));
}
