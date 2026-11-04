use xq_core::{Game, Move, Position};
use xq_engine::{Evaluation, SearchConfig, Searcher, evaluate};

fn opening_position() -> Position {
    let mut position = Position::startpos();
    for text in ["h2e2", "h9g7", "c3c4", "g6g5"] {
        position.make_move(Move::from_iccs(text).unwrap()).unwrap();
    }
    position
}

fn tactical_position() -> Position {
    Position::from_fen("4k4/4r4/9/4p4/9/9/9/9/4R4/3K5 w - - 0 1").unwrap()
}

fn assert_search_baseline(
    position: Position,
    expected_move: &str,
    score: i32,
    depth: u8,
    lines: &[(&str, i32)],
) {
    let game = Game::new(position.clone());
    let result = Searcher::new(SearchConfig {
        node_limit: 10_000,
        use_root_alpha: false,
        use_check_extensions: false,
        use_killer_history_ordering: false,
        ..SearchConfig::default()
    })
    .search_game(&game);
    assert_eq!(result.best_move.unwrap().to_iccs(), expected_move);
    assert_eq!(
        (result.score, result.nodes, result.depth, result.mate_in),
        (score, 10_000, depth, None)
    );

    let multipv = Searcher::new(SearchConfig {
        node_limit: 10_000,
        use_root_alpha: false,
        use_check_extensions: false,
        use_killer_history_ordering: false,
        ..SearchConfig::default()
    })
    .search_multipv(&game, 3);
    let actual: Vec<_> = multipv
        .iter()
        .map(|line| (line.best_move.to_iccs(), line.score))
        .collect();
    let expected: Vec<_> = lines
        .iter()
        .map(|(movement, score)| ((*movement).to_owned(), *score))
        .collect();
    assert_eq!(actual, expected);
}

#[test]
fn evaluation_and_fixed_node_search_match_the_preoptimization_baseline() {
    assert_eq!(
        evaluate(&Position::startpos()),
        Evaluation {
            material: 0,
            position: 0,
            mobility: 0,
            king_safety: 0,
            total: 0
        }
    );
    assert_search_baseline(
        Position::startpos(),
        "b2b6",
        7,
        2,
        &[("b2b6", 7), ("h2h6", 7), ("b2c2", 0)],
    );

    let opening = opening_position();
    assert_eq!(
        evaluate(&opening),
        Evaluation {
            material: 0,
            position: 2,
            mobility: -16,
            king_safety: 0,
            total: -14
        }
    );
    assert_search_baseline(
        opening,
        "b2b6",
        -8,
        2,
        &[("b2b6", -8), ("i0i1", -12), ("e2g2", -14)],
    );

    let tactical = tactical_position();
    assert_eq!(
        evaluate(&tactical),
        Evaluation {
            material: -70,
            position: -6,
            mobility: 10,
            king_safety: -2,
            total: -68
        }
    );
    assert_search_baseline(
        tactical,
        "d0e0",
        -63,
        3,
        &[("d0e0", -63), ("e1d1", -73), ("e1f1", -78)],
    );
}
