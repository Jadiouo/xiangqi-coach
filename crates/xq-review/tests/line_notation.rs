//! `describe_line` turns an engine line into Chinese notation, step by step.
//! Golden strings are copied from the xq-core notation tests (crates/xq-core/src/tests.rs).

use xq_core::{Game, Move, PieceKind, Position, Side, format_chinese_move};
use xq_review::describe_line;

fn mv(text: &str) -> Move {
    Move::from_iccs(text).unwrap()
}

fn game(fen: &str) -> Game {
    Game::new(Position::from_fen(fen).unwrap())
}

const BLACK_FEN: &str = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b - - 0 1";

#[test]
fn red_step_matches_the_core_golden_string() {
    let start = Game::new(Position::startpos());
    let steps = describe_line(&start, &[mv("b0c2")], 4);
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].notation, "馬八進七");
    assert_eq!(steps[0].mv, mv("b0c2"));
    assert_eq!(steps[0].side, Side::Red);
    assert_eq!(steps[0].captured, None);
}

#[test]
fn black_step_matches_the_core_golden_strings() {
    let steps = describe_line(&game(BLACK_FEN), &[mv("d9e8")], 4);
    assert_eq!(steps[0].notation, "士4進5");
    assert_eq!(steps[0].side, Side::Black);
    let steps = describe_line(&game(BLACK_FEN), &[mv("h9g7")], 4);
    assert_eq!(steps[0].notation, "馬8進7");
}

#[test]
fn notation_is_computed_against_the_position_at_each_step() {
    // Red horse b0c2, then black horse h9g7 from the start position.
    let steps = describe_line(
        &Game::new(Position::startpos()),
        &[mv("b0c2"), mv("h9g7")],
        4,
    );
    let notations: Vec<_> = steps.iter().map(|s| s.notation.as_str()).collect();
    assert_eq!(notations, ["馬八進七", "馬8進7"]);
    assert_eq!([steps[0].side, steps[1].side], [Side::Red, Side::Black]);
}

#[test]
fn same_file_disambiguators_come_from_the_current_position() {
    let two_rooks = game("4k4/9/9/9/4P4/9/R8/9/9/R3K4 w - - 0 1");
    assert_eq!(
        describe_line(&two_rooks, &[mv("a3b3")], 4)[0].notation,
        "前車平八"
    );
    assert_eq!(
        describe_line(&two_rooks, &[mv("a0b0")], 4)[0].notation,
        "後車平八"
    );
}

#[test]
fn every_step_equals_format_chinese_move_on_the_replayed_game() {
    let moves = [mv("b0c2"), mv("h9g7"), mv("h2e2"), mv("b9c7")];
    let steps = describe_line(&Game::new(Position::startpos()), &moves, 4);
    assert_eq!(steps.len(), 4);
    let mut replay = Game::new(Position::startpos());
    for (step, movement) in steps.iter().zip(moves) {
        let expected = format_chinese_move(replay.position(), movement).unwrap();
        assert_eq!(step.notation, expected);
        replay.play(movement).unwrap();
    }
}

#[test]
fn captures_name_the_piece_taken() {
    let capture = game("4k4/9/9/9/4p4/4P4/9/9/9/4K4 w - - 0 1");
    let steps = describe_line(&capture, &[mv("e4e5")], 4);
    assert_eq!(
        steps[0].captured.map(|p| (p.side, p.kind)),
        Some((Side::Black, PieceKind::Pawn))
    );
    assert_eq!(
        steps[0].notation,
        format_chinese_move(capture.position(), mv("e4e5")).unwrap()
    );
}

#[test]
fn the_line_is_cut_at_max_plies() {
    let moves = [mv("b0c2"), mv("h9g7"), mv("h2e2"), mv("b9c7")];
    let start = Game::new(Position::startpos());
    assert_eq!(describe_line(&start, &moves, 2).len(), 2);
    assert_eq!(describe_line(&start, &moves, 0).len(), 0);
    assert_eq!(describe_line(&start, &moves, 99).len(), 4);
}

#[test]
fn an_illegal_step_stops_the_line_without_panicking() {
    let start = Game::new(Position::startpos());
    // The second move is not legal for black at that point (a red move repeated).
    let steps = describe_line(&start, &[mv("b0c2"), mv("b0c2"), mv("h9g7")], 4);
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].notation, "馬八進七");
}

#[test]
fn a_finished_game_yields_no_steps() {
    // From xq-core: red to move and checkmated.
    let mated = game("3rk4/9/9/9/4P4/9/9/2n6/4r2n1/4K4 w - - 0 1");
    assert!(describe_line(&mated, &[mv("e0d0")], 4).is_empty());
}

#[test]
fn the_line_stops_after_the_move_that_ends_the_game() {
    // Find a mating move for red in a known mate-in-one position, then offer a follow-up.
    let fen = "5k3/9/9/9/R4n3/6N2/9/9/9/3RK4 w - - 0 1";
    let start = game(fen);
    let mut probe = Position::from_fen(fen).unwrap();
    let mating = probe
        .legal_moves()
        .into_iter()
        .find(|&m| {
            let mut g = start.clone();
            g.play(m).unwrap();
            g.outcome().is_some()
        })
        .expect("the fixture position has a mate in one");
    let steps = describe_line(&start, &[mating, mv("f9e9")], 4);
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].mv, mating);
}
