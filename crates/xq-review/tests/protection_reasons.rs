//! TEST_PLAN 6.3.5 (sent piece) and 6.3.6 (abandoned protection).
//! Every case is one positive position and a look-alike negative position.

mod common;

use common::{kind_of, review};
use xq_core::PieceKind;
use xq_review::ReasonKind;

// Best PV has two moves, the actual line has three, so the material comparison (6.3.3) is
// deliberately not applicable and only the exchange reasons can fire.
const BEST: &[&str] = &["d0d1", "e9e8"];

#[test]
fn horse_moved_next_to_an_unprotected_pawn_attack_is_sent() {
    // Red horse b2->c4 stands under the black pawn on c5, with nothing protecting c4.
    let result = review(
        "4k4/9/9/9/2p6/9/9/1N7/9/3K5 w - - 0 1",
        "b2c4",
        BEST,
        &["b2c4", "c5c4", "d0d1"],
    );
    let reason = result.reason.expect("an unprotected horse is hanging");
    assert_eq!(reason.kind, ReasonKind::SentPiece);
    let evidence = reason.protection.expect("sent piece carries evidence");
    assert_eq!(evidence.piece.kind, PieceKind::Horse);
    assert_eq!(evidence.from.to_iccs(), "b2");
    assert_eq!(evidence.to.to_iccs(), "c4");
    assert_eq!(evidence.captured_at.to_iccs(), "c4");
    assert_eq!(evidence.capturer, xq_core::Side::Black);
    assert_eq!(evidence.attacker.kind, PieceKind::Pawn);
    assert_eq!(evidence.net, -300);
}

#[test]
fn a_protected_rook_that_only_trades_evenly_is_not_sent() {
    // Red rook a1->b1 steps onto the b-file in front of the red rook b0. The black rook b5
    // can take it, but b0 takes back: rook for rook, no loss.
    let result = review(
        "4k4/9/9/9/1r7/9/9/9/R8/1R1K5 w - - 0 1",
        "a1b1",
        BEST,
        &["a1b1", "b5b1", "b0b1"],
    );
    assert_ne!(kind_of(&result), Some(ReasonKind::SentPiece));
}

#[test]
fn a_horse_protected_only_by_a_rook_is_still_sent_to_a_pawn() {
    // The rook on c0 protects c4, but pawn-takes-horse then rook-takes-pawn is -300 + 70.
    let result = review(
        "4k4/9/9/9/2p6/9/9/1N7/9/2RK5 w - - 0 1",
        "b2c4",
        BEST,
        &["b2c4", "c5c4", "c0c4"],
    );
    let reason = result
        .reason
        .expect("insufficient protection is still a loss");
    assert_eq!(reason.kind, ReasonKind::SentPiece);
    assert_eq!(reason.protection.unwrap().net, -230);
}

#[test]
fn a_capturing_move_that_wins_more_than_it_risks_is_not_sent() {
    // Red horse b2->c4 captures a black rook and is then taken by the pawn: +600 - 300.
    let result = review(
        "4k4/9/9/9/2p6/2r6/9/1N7/9/3K5 w - - 0 1",
        "b2c4",
        BEST,
        &["b2c4", "c5c4", "d0d1"],
    );
    assert_ne!(kind_of(&result), Some(ReasonKind::SentPiece));
}

#[test]
fn a_recapturer_that_is_pinned_to_its_king_does_not_count_as_protection() {
    // Horse b2->c4 is attacked by the pawn c5. The red rook e4 could take back along the
    // fourth rank, but it is pinned to its king by the black rook e9: leaving the e-file
    // would be illegal. So the horse is effectively unprotected (-300, not -230).
    let pinned = review(
        "3kr4/9/9/9/2p6/4R4/9/1N7/9/4K4 w - - 0 1",
        "b2c4",
        BEST,
        &["b2c4", "c5c4", "e0d0"],
    );
    let reason = pinned.reason.expect("the pinned rook cannot protect");
    assert_eq!(reason.kind, ReasonKind::SentPiece);
    assert_eq!(reason.protection.unwrap().net, -300);

    // Without the pinning rook the recapture is real: -300 + 70.
    let free = review(
        "3k5/9/9/9/2p6/4R4/9/1N7/9/4K4 w - - 0 1",
        "b2c4",
        BEST,
        &["b2c4", "c5c4", "e4c4"],
    );
    let reason = free.reason.expect("a pawn still wins a horse for a pawn");
    assert_eq!(reason.kind, ReasonKind::SentPiece);
    assert_eq!(reason.protection.unwrap().net, -230);
}

#[test]
fn leaving_the_only_recapturer_exposes_the_protected_cannon() {
    // Red rook a5 protects the cannon on b5 against the black rook c5. Moving the rook to
    // a4 lets the black rook take the cannon for free.
    let result = review(
        "4k4/9/9/9/RCr1P4/9/9/9/9/3K5 w - - 0 1",
        "a5a4",
        BEST,
        &["a5a4", "c5b5", "d0d1"],
    );
    let reason = result.reason.expect("the released cannon is lost");
    assert_eq!(reason.kind, ReasonKind::AbandonedProtection);
    let evidence = reason.protection.unwrap();
    assert_eq!(evidence.piece.kind, PieceKind::Rook);
    assert_eq!(evidence.from.to_iccs(), "a5");
    assert_eq!(evidence.to.to_iccs(), "a4");
    assert_eq!(evidence.attacker.kind, PieceKind::Rook);
    assert_eq!(evidence.protected_piece.unwrap().kind, PieceKind::Cannon);
    assert_eq!(evidence.protected_square.unwrap().to_iccs(), "b5");
    assert_eq!(evidence.captured_at.to_iccs(), "b5");
    assert_eq!(evidence.capturer, xq_core::Side::Black);
    assert_eq!(evidence.net, -300);
}

#[test]
fn another_recapturer_keeps_the_protection_so_it_is_not_abandoned() {
    // Same position with a second red rook on d5: it can still take back on b5.
    let result = review(
        "4k4/9/9/9/RCrRP4/9/9/9/9/3K5 w - - 0 1",
        "a5a4",
        BEST,
        &["a5a4", "c5b5", "d0d1"],
    );
    assert_ne!(kind_of(&result), Some(ReasonKind::AbandonedProtection));
}

#[test]
fn black_can_abandon_a_protection_too() {
    let result = review(
        "3k5/9/9/9/9/rcR1p4/9/9/9/4K4 b - - 0 1",
        "a4a5",
        BEST_BLACK,
        &["a4a5", "c4b4", "d9d8"],
    );
    let reason = result.reason.expect("black loses the cannon");
    assert_eq!(reason.kind, ReasonKind::AbandonedProtection);
    let evidence = reason.protection.unwrap();
    assert_eq!(evidence.protected_piece.unwrap().kind, PieceKind::Cannon);
    assert_eq!(evidence.capturer, xq_core::Side::Red);
}

const BEST_BLACK: &[&str] = &["d9d8", "e0e1"];

#[test]
fn a_move_that_does_not_leave_the_protecting_square_is_not_abandonment() {
    // The rook a5 stays put; the king moves. The cannon is exactly as protected as before.
    let result = review(
        "4k4/9/9/9/RCr1P4/9/9/9/9/3K5 w - - 0 1",
        "d0e0",
        BEST,
        &["d0e0", "c5b5", "a5b5"],
    );
    assert_ne!(kind_of(&result), Some(ReasonKind::AbandonedProtection));
}
