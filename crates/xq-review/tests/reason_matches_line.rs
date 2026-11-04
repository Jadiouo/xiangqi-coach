//! A tactical reason ("they can take your piece") must agree with the engine's own best reply
//! to the played move (`PlyAnalysis::played_line`). If the engine's reply is something else,
//! the explanation would contradict the engine's line, so the rule must not fire.
//! Triggered by the 2026-10-16 user feedback that the explanation said something wrong.

mod common;

use common::{kind_of, review};
use xq_core::{Game, Move, Position};
use xq_engine::SearchConfig;
use xq_review::{BuiltinAnalyzer, Limit, PlyAnalysis, ReasonKind, review_one_move};

fn no_tactical_reason(result: &PlyAnalysis) {
    assert!(
        !matches!(
            kind_of(result),
            Some(
                ReasonKind::SentPiece | ReasonKind::AbandonedProtection | ReasonKind::CheckCapture
            )
        ),
        "got {:?}",
        kind_of(result)
    );
}

const BEST: &[&str] = &["d0d1", "e9e8"];

#[test]
fn sent_piece_is_not_claimed_when_the_engine_reply_takes_something_else() {
    // b2->c4 hangs the horse to the pawn c5, but the engine's reply is a king move.
    let result = review(
        "4k4/9/9/9/2p6/9/9/1N7/9/3K5 w - - 0 1",
        "b2c4",
        BEST,
        &["b2c4", "e9e8", "d0d1"],
    );
    assert_ne!(kind_of(&result), Some(ReasonKind::SentPiece));
    no_tactical_reason(&result);
}

#[test]
fn sent_piece_is_still_claimed_when_the_engine_reply_takes_the_moved_piece() {
    let result = review(
        "4k4/9/9/9/2p6/9/9/1N7/9/3K5 w - - 0 1",
        "b2c4",
        BEST,
        &["b2c4", "c5c4", "d0d1"],
    );
    assert_eq!(kind_of(&result), Some(ReasonKind::SentPiece));
}

#[test]
fn abandoned_protection_is_not_claimed_when_the_engine_reply_does_something_else() {
    // a5->a4 abandons the cannon b5 to the rook c5, but the engine replies with a king move.
    let result = review(
        "4k4/9/9/9/RCr1P4/9/9/9/9/3K5 w - - 0 1",
        "a5a4",
        BEST,
        &["a5a4", "e9e8", "d0d1"],
    );
    assert_ne!(kind_of(&result), Some(ReasonKind::AbandonedProtection));
    no_tactical_reason(&result);
}

#[test]
fn abandoned_protection_is_still_claimed_when_the_engine_reply_takes_the_cannon() {
    let result = review(
        "4k4/9/9/9/RCr1P4/9/9/9/9/3K5 w - - 0 1",
        "a5a4",
        BEST,
        &["a5a4", "c5b5", "d0d1"],
    );
    assert_eq!(kind_of(&result), Some(ReasonKind::AbandonedProtection));
}

#[test]
fn check_capture_is_not_claimed_when_the_engine_reply_does_something_else() {
    let result = review(
        "4k4/9/9/9/9/9/r3N4/9/9/3K5 w - - 0 1",
        "d0e0",
        BEST,
        &["d0e0", "e9e8", "e0d0"],
    );
    assert_ne!(kind_of(&result), Some(ReasonKind::CheckCapture));
    no_tactical_reason(&result);
}

#[test]
fn check_capture_is_still_claimed_when_the_engine_reply_is_that_capture() {
    let result = review(
        "4k4/9/9/9/9/9/r3N4/9/9/3K5 w - - 0 1",
        "d0e0",
        BEST,
        &["d0e0", "a3e3", "e0d0"],
    );
    assert_eq!(kind_of(&result), Some(ReasonKind::CheckCapture));
}

#[test]
fn abandoned_protection_evidence_names_the_attacker_the_engine_uses() {
    // The cannon b5 is attacked by the rook c5 and the horse a7 alike; after a5a4 either
    // takes it for the same loss. The evidence must name the one the engine actually plays.
    let fen = "4k4/9/n8/9/RCr1P4/9/9/9/9/3K5 w - - 0 1";
    for (reply, attacker) in [
        ("c5b5", xq_core::PieceKind::Rook),
        ("a7b5", xq_core::PieceKind::Horse),
    ] {
        let result = review(fen, "a5a4", BEST, &["a5a4", reply, "d0d1"]);
        let reason = result.reason.expect("a reason exists");
        assert_eq!(reason.kind, ReasonKind::AbandonedProtection, "{reply}");
        let evidence = reason.protection.expect("evidence");
        assert_eq!(evidence.attacker.kind, attacker, "{reply}");
    }
}

/// Real regression: sample-beginner game 0, ply 37 (index 36), red f2g4. The engine's reply
/// to it is a cannon move elsewhere, not a capture of the horse on g4.
#[test]
fn sample_beginner_ply_37_does_not_claim_the_horse_is_taken() {
    let moves = [
        "c3c4", "g6g5", "h2g2", "g9e7", "h0i2", "h9g7", "i0h0", "i9h9", "h0h6", "f9e8", "b2b9",
        "e6e5", "h6h4", "e8f9", "g2b2", "f9e8", "c0a2", "h7h8", "b0d1", "h8f8", "h4d4", "a9b9",
        "b2b9", "h9h6", "i2g1", "b7b8", "d1f2", "e8d7", "a0a1", "b8b0", "d0e1", "g7h5", "d4d2",
        "b0b1", "b9b6", "a6a5",
    ];
    let mut game = Game::new(Position::startpos());
    for text in moves {
        game.play(Move::from_iccs(text).unwrap()).unwrap();
    }
    let played = Move::from_iccs("f2g4").unwrap();
    let mut analyzer = BuiltinAnalyzer::new(SearchConfig {
        node_limit: 100_000,
        ..SearchConfig::default()
    });
    let result = review_one_move(&mut analyzer, &game, played, Limit::new(100_000)).unwrap();
    let reply = result
        .played_line
        .as_ref()
        .and_then(|line| line.principal_variation.first().copied())
        .expect("engine has a reply");
    assert_ne!(reply.to, played.to, "premise: the engine does not take g4");
    assert_ne!(kind_of(&result), Some(ReasonKind::SentPiece));
}
