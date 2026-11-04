use xq_core::{Position, Side};

fn old_fen_side_view(position: &Position, side: Side) -> Vec<String> {
    let fen_position = position.to_fen();
    let fields: Vec<_> = fen_position.split_whitespace().collect();
    let side = if side == Side::Red { "w" } else { "b" };
    let fen = format!("{} {side} - - {} {}", fields[0], fields[4], fields[5]);
    let mut view = Position::from_fen(&fen).unwrap();
    let mut moves: Vec<_> = view
        .legal_moves()
        .into_iter()
        .map(|movement| movement.to_iccs())
        .collect();
    moves.sort();
    moves
}

#[test]
fn legal_moves_for_matches_the_previous_fen_side_view_without_mutating_position() {
    let positions = [
        Position::startpos(),
        Position::from_fen("4k4/9/9/9/4r4/9/9/9/9/4K4 w - - 3 5").unwrap(),
        Position::from_fen("4k4/9/9/9/9/4R4/9/9/9/4K4 b - - 0 1").unwrap(),
        Position::from_fen("4k4/9/9/9/4p4/9/4P4/9/9/4K4 w - - 0 1").unwrap(),
        Position::from_fen("3k5/9/9/9/9/9/9/9/3A5/3K5 b - - 0 1").unwrap(),
    ];
    for position in positions {
        let fen_before = position.to_fen();
        let hash_before = position.hash();
        for side in [Side::Red, Side::Black] {
            let mut actual: Vec<_> = position
                .legal_moves_for(side)
                .into_iter()
                .map(|movement| movement.to_iccs())
                .collect();
            actual.sort();
            assert_eq!(
                actual,
                old_fen_side_view(&position, side),
                "{fen_before}, {side:?}"
            );
        }
        assert_eq!(position.to_fen(), fen_before);
        assert_eq!(position.hash(), hash_before);
    }
}
