//! SPEC 8.4 item 9 (user decision 2026-10-20): the Mobility component is only named when the
//! best move leaves at least `MOBILITY_GAP_STEPS` more legal moves than the played one.
//! Positions come from the frozen review samples (docs/samples/data/*.json): the move lists
//! below are copied from those files and replayed here, so every move is checked for legality.

mod common;

use common::review;
use xq_core::{Game, Move, Position, Side};
use xq_review::{EvalComponent, MOBILITY_GAP_STEPS, PlyAnalysis, ReasonKind};

const START: &str = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";

/// sample-intermediate.json, first 46 plies; ply 47 is a4a5 with best b1b8 (mobility 36 vs 37).
const INTERMEDIATE_PREFIX: &str = "c3c4 g6g5 h2g2 g9e7 h0i2 h9g7 i0h0 i9h9 h0h4 g7f5 c0e2 h9h8 e3e4 b9c7 b0c2 a9a8 b2b3 h7i7 h4h3 b7b5 h3h8 a8h8 a3a4 e7g9 a0a1 c9a7 e2c0 a7c9 a1f1 h8h2 e4e5 b5b7 i3i4 i7e7 f1c1 e9e8 c2a1 h2g2 b3d3 e6e5 c0e2 b7b0 d0e1 e7h7 c1b1 f5g3";
/// sample-beginner.json, first 16 plies; ply 17 is c0a2 with best a0a1 (mobility 40 vs 51).
const BEGINNER_PREFIX: &str =
    "c3c4 g6g5 h2g2 g9e7 h0i2 h9g7 i0h0 i9h9 h0h6 f9e8 b2b9 e6e5 h6h4 e8f9 g2b2 f9e8";

fn replay(prefix: &str) -> Game {
    let mut game = Game::new(Position::from_fen(START).unwrap());
    for text in prefix.split(' ') {
        game.play(Move::from_iccs(text).unwrap())
            .unwrap_or_else(|error| panic!("{text} is not legal: {error:?}"));
    }
    game
}

fn legal_after(game: &Game, mover: Side, text: &str) -> i32 {
    let mut position = game.position().clone();
    position.make_move(Move::from_iccs(text).unwrap()).unwrap();
    position.legal_moves_for(mover).len() as i32
}

/// Review `played` against `best` using scripted lines; replies are the first legal move.
fn review_sample(game: &Game, played: &str, best: &str) -> PlyAnalysis {
    let first_reply = |text: &str| -> Vec<String> {
        let mut position = game.position().clone();
        position.make_move(Move::from_iccs(text).unwrap()).unwrap();
        let reply = position.legal_moves()[0];
        position.make_move(reply).unwrap();
        let next = position.legal_moves()[0];
        vec![reply.to_iccs(), next.to_iccs()]
    };
    // Different PV lengths keep the line-based material reasons out of the picture.
    let best_tail = first_reply(best);
    let played_tail = first_reply(played);
    let best_pv = [best, best_tail[0].as_str()];
    let actual_pv = [played, played_tail[0].as_str(), played_tail[1].as_str()];
    review(&game.position().to_fen(), played, &best_pv, &actual_pv)
}

#[test]
fn the_gap_constant_is_three_steps() {
    assert_eq!(MOBILITY_GAP_STEPS, 3);
}

#[test]
fn a_one_step_mobility_difference_is_not_reported_as_mobility() {
    // sample-intermediate ply 47: the old text said "36 steps, behind the best move" (37).
    let game = replay(INTERMEDIATE_PREFIX);
    let mover = game.position().side_to_move();
    let gap = legal_after(&game, mover, "b1b8") - legal_after(&game, mover, "a4a5");
    assert!(gap < MOBILITY_GAP_STEPS as i32, "scenario check: gap {gap}");
    assert_eq!(gap, 1);
    let result = review_sample(&game, "a4a5", "b1b8");
    if let Some(reason) = &result.reason
        && reason.kind == ReasonKind::PositionType
    {
        let evidence = reason.position.expect("evidence is attached");
        assert_ne!(evidence.component, EvalComponent::Mobility);
    }
}

#[test]
fn a_mobility_difference_of_at_least_the_gap_is_still_reported() {
    // sample-beginner ply 17: 51 vs 40 legal moves, Mobility is the largest deficit.
    let game = replay(BEGINNER_PREFIX);
    let mover = game.position().side_to_move();
    let best_steps = legal_after(&game, mover, "a0a1");
    let played_steps = legal_after(&game, mover, "c0a2");
    assert!(best_steps - played_steps >= MOBILITY_GAP_STEPS as i32);
    let result = review_sample(&game, "c0a2", "a0a1");
    let reason = result.reason.expect("a quiet mistake still gets a reason");
    assert_eq!(reason.kind, ReasonKind::PositionType);
    let evidence = reason.position.expect("evidence is attached");
    assert_eq!(evidence.component, EvalComponent::Mobility);
    assert_eq!(evidence.mobility_after_best as i32, best_steps);
    assert_eq!(evidence.mobility_after as i32, played_steps);
}

// Not covered: a real sample position with a gap of exactly 3 or a gap of 2. The three frozen
// samples contain only mobility gaps of 1 (intermediate 47) and 11 (beginner 17); no moves were
// invented for the missing cases.
