use xq_core::{Game, Move, Position};

#[test]
fn context_key_changes_with_move_history_even_when_position_repeats() {
    let mut game = Game::new(Position::startpos());
    let initial = game.context_key();
    for movement in ["h0g2", "h9g7", "g2h0", "g7h9"] {
        game.play(Move::from_iccs(movement).unwrap()).unwrap();
    }
    assert_eq!(game.position().hash(), Position::startpos().hash());
    assert_ne!(game.context_key(), initial);
}

#[test]
fn context_key_reconstruction_and_undo_are_deterministic() {
    let mut first = Game::new(Position::startpos());
    let mut second = Game::new(Position::startpos());
    let moves = ["h0g2", "h9g7"];
    for movement in moves {
        first.play(Move::from_iccs(movement).unwrap()).unwrap();
        second.play(Move::from_iccs(movement).unwrap()).unwrap();
    }
    assert_eq!(first.context_key(), second.context_key());
    let key = first.context_key();
    first.undo_last_move();
    first.play(Move::from_iccs("h9g7").unwrap()).unwrap();
    assert_eq!(first.context_key(), key);
}

#[test]
fn context_key_changes_with_halfmove_clock_and_illegal_move_preserves_it() {
    let a =
        Position::from_fen("rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1")
            .unwrap();
    let b = Position::from_fen(
        "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 12 1",
    )
    .unwrap();
    let game_a = Game::new(a);
    let mut game_b = Game::new(b);
    assert_ne!(game_a.context_key(), game_b.context_key());
    let before = game_b.context_key();
    assert!(game_b.play(Move::from_iccs("a0a9").unwrap()).is_err());
    assert_eq!(game_b.context_key(), before);
}
