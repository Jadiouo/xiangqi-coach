use std::collections::HashMap;

use xq_core::{Game, Move, Position};
use xq_review::{Analyzer, Limit, Line, ReasonKind, ReviewScore, review_one_move};

#[derive(Default)]
struct Fixture(HashMap<(String, usize), Vec<Line>>);

impl Fixture {
    fn set(&mut self, game: &Game, multipv: usize, lines: Vec<Line>) {
        self.0.insert((game.position().to_fen(), multipv), lines);
    }
}

impl Analyzer for Fixture {
    fn analyze(&mut self, position: &Position, _: Limit, multipv: usize) -> Vec<Line> {
        self.0
            .get(&(position.to_fen(), multipv))
            .cloned()
            .unwrap_or_default()
    }
    fn name(&self) -> String {
        "fixture".into()
    }
}

fn line(pv: &[&str], score: ReviewScore) -> Line {
    Line {
        best_move: Move::from_iccs(pv[0]).unwrap(),
        score,
        principal_variation: pv
            .iter()
            .map(|text| Move::from_iccs(text).unwrap())
            .collect(),
        depth: 6,
        nodes: 100,
        pv_end: xq_engine::PrincipalVariationEnd::DepthLimit,
    }
}

fn fixture_review(
    fen: &str,
    played: &str,
    best_pv: &[&str],
    actual_pv: &[&str],
) -> xq_review::PlyAnalysis {
    let game = Game::new(Position::from_fen(fen).unwrap());
    let played = Move::from_iccs(played).unwrap();
    let mut after = game.clone();
    after
        .play(played)
        .unwrap_or_else(|error| panic!("played {played:?} in {fen}: {error:?}"));
    let mut fixture = Fixture::default();
    fixture.set(&game, 3, vec![line(best_pv, ReviewScore::centipawns(400))]);
    fixture.set(
        &after,
        1,
        vec![line(&actual_pv[1..], ReviewScore::centipawns(0))],
    );
    review_one_move(&mut fixture, &game, played, Limit::new(100)).unwrap()
}

/// Since TEST_PLAN 6.3.8 every marked move gets a fallback reason, so "no material claim"
/// means the reason is neither of the two PV-ledger kinds.
fn no_material_claim(result: &xq_review::PlyAnalysis) -> bool {
    !matches!(
        result.reason.as_ref().map(|reason| reason.kind),
        Some(ReasonKind::DroppedMaterial | ReasonKind::MissedMaterial)
    )
}

#[test]
fn material_drop_is_based_on_the_replayed_actual_line_and_reports_the_lost_piece() {
    // Best: Red captures the black rook. Actual: Red king moves, then the black rook
    // captures the red rook. Both two-ply lines finish with no immediate capture reply.
    let result = fixture_review(
        "4k4/9/9/9/r8/9/9/9/3K5/R8 w - - 0 1",
        "d1d2",
        &["a0a5", "e9e8"],
        &["d1d2", "a5a0"],
    );
    let reason = result.reason.expect("material loss should be explained");
    assert_eq!(reason.kind, ReasonKind::DroppedMaterial);
    let evidence = reason
        .material
        .expect("renderer needs the concrete capture");
    assert_eq!(
        evidence.played_captures[0].piece.kind,
        xq_core::PieceKind::Rook
    );
    assert_eq!(evidence.played_captures[0].square.to_iccs(), "a0");
    assert_eq!(evidence.plies, 2);
    assert!(evidence.settled, "no capture is pending at either endpoint");
}

#[test]
fn missed_capture_requires_a_net_gain_in_the_best_line() {
    // Best captures a pawn, actual line leaves it alone; neither line exchanges material.
    let result = fixture_review(
        "3k5/9/9/9/p8/9/1N7/9/9/4K4 w - - 0 1",
        "e0e1",
        &["b3a5", "d9d8"],
        &["e0e1", "a5a4"],
    );
    let reason = result
        .reason
        .expect("missed material gain should be explained");
    assert_eq!(reason.kind, ReasonKind::MissedMaterial);
    assert_eq!(
        reason.material.unwrap().best_captures[0].piece.kind,
        xq_core::PieceKind::Pawn
    );
}

#[test]
fn a_rook_exchange_is_not_a_dropped_piece() {
    let result = fixture_review(
        "4k4/9/9/9/rr7/9/9/9/3K5/1R7 w - - 0 1",
        "b0b5",
        &["d1d2", "b5c5"],
        &["b0b5", "a5b5"],
    );
    assert!(
        result.reason.is_none(),
        "an even rook exchange is not a net loss"
    );
}

#[test]
fn black_material_loss_uses_black_as_the_positive_material_side() {
    let result = fixture_review(
        "r8/3k5/9/9/9/R8/9/9/9/4K4 b - - 0 1",
        "d8d7",
        &["a9a4", "e0f0"],
        &["d8d7", "a4a9"],
    );
    let reason = result
        .reason
        .expect("Black loses its rook on the played line");
    assert_eq!(reason.kind, ReasonKind::DroppedMaterial);
    let evidence = reason.material.unwrap();
    assert!(evidence.played_net < evidence.best_net);
    assert!(evidence.played_captures.iter().any(|capture| {
        capture.piece.side == xq_core::Side::Black && capture.piece.kind == xq_core::PieceKind::Rook
    }));
}

#[test]
fn quiet_lines_and_unmatched_pv_lengths_remain_unknown() {
    let fen = "4k4/9/9/9/9/9/9/9/9/3K5 w - - 0 1";
    let quiet = fixture_review(fen, "d0d1", &["d0e0", "e9e8"], &["d0d1", "e9e8"]);
    assert!(
        quiet.reason.is_none(),
        "score loss without captures is not material evidence"
    );

    let unequal = fixture_review(fen, "d0d1", &["d0e0", "e9e8"], &["d0d1", "e9e8", "d1e1"]);
    assert!(
        unequal.reason.is_none(),
        "different PV horizons are not comparable"
    );
}

#[test]
fn best_move_is_not_a_material_reason_and_illegal_pv_evidence_is_rejected() {
    let fen = "4k4/9/9/9/r8/9/9/9/3K5/R8 w - - 0 1";
    let correct = fixture_review(fen, "a0a5", &["a0a5", "e9e8"], &["a0a5", "e9e8"]);
    assert!(
        correct.reason.is_none(),
        "playing the best material line is not a mistake"
    );

    let illegal = fixture_review(fen, "d1d2", &["a0a5", "a0a5"], &["d1d2", "a5a0"]);
    assert!(
        no_material_claim(&illegal),
        "an illegal PV cannot support a material claim"
    );
}

#[test]
fn analyzer_without_a_completed_pv_cannot_support_a_material_reason() {
    let game = Game::new(Position::from_fen("4k4/9/9/9/r8/9/9/9/3K5/R8 w - - 0 1").unwrap());
    let played = Move::from_iccs("d1d2").unwrap();
    let mut after = game.clone();
    after.play(played).unwrap();
    let mut root = line(&["a0a5", "e9e8"], ReviewScore::centipawns(400));
    root.pv_end = xq_engine::PrincipalVariationEnd::NoCompletedIteration;
    let mut fixture = Fixture::default();
    fixture.set(&game, 3, vec![root]);
    fixture.set(&after, 1, vec![line(&["a5a0"], ReviewScore::centipawns(0))]);

    let result = review_one_move(&mut fixture, &game, played, Limit::new(100)).unwrap();
    assert!(
        no_material_claim(&result),
        "an incomplete search remains unknown"
    );
}

#[test]
fn an_immediate_legal_recapture_at_the_pv_endpoint_keeps_material_unknown() {
    // The played line appears to lose a rook, but Red's rook on b0 can take the
    // capturing black rook on a0 immediately after this PV ends.
    let game = Game::new(Position::from_fen("4k4/9/9/9/r8/9/9/9/3K5/RR7 w - - 0 1").unwrap());
    let mut endpoint = game.clone();
    endpoint.play(Move::from_iccs("d1d2").unwrap()).unwrap();
    endpoint.play(Move::from_iccs("a5a0").unwrap()).unwrap();
    assert!(
        endpoint
            .position()
            .legal_moves_for(xq_core::Side::Red)
            .contains(&Move::from_iccs("b0a0").unwrap())
    );

    let result = fixture_review(
        "4k4/9/9/9/r8/9/9/9/3K5/RR7 w - - 0 1",
        "d1d2",
        &["a0a5", "e9e8"],
        &["d1d2", "a5a0"],
    );
    // P4 (DECISIONS 2026-10-19): the claim is kept but flagged, so the renderer can say the
    // exchange is not over instead of asserting a net result.
    let evidence = result
        .reason
        .expect("the capture is still reported")
        .material
        .expect("material evidence");
    assert!(
        !evidence.settled,
        "unresolved immediate recapture must be flagged as not settled"
    );
}

#[test]
fn a_played_capture_with_the_same_gain_is_not_a_missed_gain() {
    // Best takes the pawn on a5, the played move takes the pawn on c5: equal net gain, so
    // nothing was missed (TEST_PLAN 6.3.4 control).
    let result = fixture_review(
        "3k5/9/9/9/p1p6/9/1N7/9/9/4K4 w - - 0 1",
        "b3c5",
        &["b3a5", "d9d8"],
        &["b3c5", "d9d8"],
    );
    assert!(
        result.reason.as_ref().map(|reason| reason.kind) != Some(ReasonKind::MissedMaterial),
        "{result:#?}"
    );
}

#[test]
fn a_move_classified_correct_never_carries_a_reason() {
    // The best move, scored consistently before and after (+400 for the mover), is Good or
    // UniqueMove; neither may get a reason even though a capture is on the board.
    let game = Game::new(Position::from_fen("4k4/9/9/9/r8/9/9/9/3K5/R8 w - - 0 1").unwrap());
    let played = Move::from_iccs("a0a5").unwrap();
    let mut after = game.clone();
    after.play(played).unwrap();
    let mut fixture = Fixture::default();
    fixture.set(
        &game,
        3,
        vec![line(&["a0a5", "e9e8"], ReviewScore::centipawns(400))],
    );
    fixture.set(
        &after,
        1,
        vec![line(&["e9e8"], ReviewScore::centipawns(-400))],
    );
    let correct = review_one_move(&mut fixture, &game, played, Limit::new(100)).unwrap();
    assert!(
        matches!(
            correct.classification,
            xq_review::Classification::Good | xq_review::Classification::UniqueMove
        ),
        "the best move is a correct move, got {:?}",
        correct.classification
    );
    assert!(correct.reason.is_none());
}

#[test]
fn lines_of_different_lengths_are_compared_on_what_each_one_has() {
    // Best: take the rook (2 plies). Actual: the king steps aside, the rook is taken, and the
    // king steps back (3 plies). Before P4 the unequal horizons made this unknown.
    let result = fixture_review(
        "4k4/9/9/9/r8/9/9/9/3K5/R8 w - - 0 1",
        "d1d2",
        &["a0a5", "e9e8"],
        &["d1d2", "a5a0", "d2d1"],
    );
    let reason = result.reason.expect("unequal horizons are comparable now");
    assert_eq!(reason.kind, ReasonKind::DroppedMaterial);
    let evidence = reason.material.unwrap();
    assert_eq!(evidence.plies, 3);
    assert!(evidence.settled);
}

#[test]
fn each_line_is_cut_at_the_comparison_length() {
    // The rook is lost only at ply 6 of the actual line; the first four plies are quiet, so
    // what is left to explain is the rook the best line takes at once.
    let result = fixture_review(
        "4k4/9/9/9/r8/9/9/9/3K5/R8 w - - 0 1",
        "d1d2",
        &["a0a5", "e9f9", "d1d2", "f9f8"],
        &["d1d2", "e9f9", "d2e2", "f9f8", "e2e1", "a5a0"],
    );
    let reason = result.reason.expect("the missed rook is explained");
    assert_eq!(reason.kind, ReasonKind::MissedMaterial);
    let evidence = reason.material.unwrap();
    assert_eq!(evidence.plies, 4);
    assert!(
        evidence.played_captures.is_empty(),
        "the capture at ply 6 is beyond the comparison length"
    );
}
