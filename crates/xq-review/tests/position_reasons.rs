//! TEST_PLAN 6.3.8: when no tactical reason applies, name the evaluation component in which
//! the played move is worst compared with the best move.

mod common;

use common::{kind_of, review};
use xq_core::{Move, Position, Side};
use xq_review::{EvalComponent, MOBILITY_GAP_STEPS, ReasonKind};

// PV lengths differ on purpose so the material-line reasons stay out of the picture.
const BEST_ROOK: &[&str] = &["c3c8", "e9e8"];
const ROOK_FEN: &str = "4k4/9/9/9/9/9/2R6/9/9/1N1K5 w - - 0 1";

fn legal_count(fen: &str, side: Side, after: Option<&str>) -> u16 {
    let mut position = Position::from_fen(fen).unwrap();
    if let Some(text) = after {
        position.make_move(Move::from_iccs(text).unwrap()).unwrap();
    }
    position.legal_moves_for(side).len() as u16
}

// Originally this test expected Mobility with best_value 40 / played_value 36 and a mobility
// sentence. On 2026-10-20 the requirement changed (user option C, docs/DECISIONS.md): Mobility
// needs a step gap of at least MOBILITY_GAP_STEPS, and here the gap is 1 (20 vs 21). A gap of
// 3 or more still names Mobility; tests/mobility_gap.rs covers that (sample-beginner ply 17).
#[test]
fn blocking_your_own_rook_by_one_step_is_not_reported_as_mobility() {
    // Horse b0->c2 stands in the rook's file; best c3c8 keeps everything open.
    let result = review(ROOK_FEN, "b0c2", BEST_ROOK, &["b0c2", "e9e8", "d0d1"]);
    let played_steps = legal_count(ROOK_FEN, Side::Red, Some("b0c2")) as i32;
    let best_steps = legal_count(ROOK_FEN, Side::Red, Some("c3c8")) as i32;
    assert_eq!(best_steps - played_steps, 1);
    assert!(best_steps - played_steps < MOBILITY_GAP_STEPS as i32);
    if let Some(reason) = result.reason
        && reason.kind == ReasonKind::PositionType
    {
        let evidence = reason.position.expect("evidence is attached");
        assert_ne!(evidence.component, EvalComponent::Mobility);
    }
}

#[test]
fn moving_the_rook_to_the_edge_is_reported_as_a_placement_loss() {
    let result = review(
        ROOK_FEN,
        "c3a3",
        &["c3d3", "e9e8"],
        &["c3a3", "e9e8", "d0d1"],
    );
    let reason = result.reason.expect("a quiet mistake still gets a reason");
    assert_eq!(reason.kind, ReasonKind::PositionType);
    assert_eq!(reason.position.unwrap().component, EvalComponent::Position);
}

#[test]
fn skipping_a_free_capture_that_the_lines_do_not_prove_is_reported_as_material() {
    // The PVs have different lengths, so 6.3.4 cannot claim it; the static material term can.
    let result = review(
        "3k5/9/9/9/p8/9/1N7/9/9/4K4 w - - 0 1",
        "e0e1",
        &["b3a5", "d9d8"],
        &["e0e1", "a5a4", "e1e0"],
    );
    let reason = result.reason.expect("material is the largest difference");
    assert_eq!(reason.kind, ReasonKind::PositionType);
    assert_eq!(reason.position.unwrap().component, EvalComponent::Material);
}

#[test]
fn a_move_that_is_not_worse_in_any_component_has_no_position_reason() {
    // Played c3d3 and best b0c2 evaluate identically in all four components.
    let result = review(
        ROOK_FEN,
        "c3d3",
        &["b0c2", "e9e8"],
        &["c3d3", "e9e8", "d0d1"],
    );
    assert_ne!(kind_of(&result), Some(ReasonKind::PositionType));
    assert!(result.reason.is_none());
}

#[test]
fn a_tactical_reason_wins_over_the_position_type_for_the_same_move() {
    // Horse hangs to a pawn: the reason is the loss of the horse, not the static terms.
    let result = review(
        "4k4/9/9/9/2p6/9/9/1N7/9/3K5 w - - 0 1",
        "b2c4",
        &["d0d1", "e9e8"],
        &["b2c4", "c5c4", "d0d1"],
    );
    assert_ne!(kind_of(&result), Some(ReasonKind::PositionType));
    assert!(result.reason.is_some());
}
