use xq_core::{Game, Move, Position};
use xq_engine::{SearchConfig, Searcher};

fn config(root_alpha: bool, check_extensions: bool, depth: u8, table: bool) -> SearchConfig {
    SearchConfig {
        node_limit: 2_000_000,
        max_depth: depth,
        use_transposition_table: table,
        use_root_alpha: root_alpha,
        use_check_extensions: check_extensions,
        ..SearchConfig::default()
    }
}

fn assert_same_full_depth(
    game: &Game,
    depth: u8,
    check_extensions: bool,
) -> xq_engine::SearchResult {
    let plain = Searcher::new(config(false, check_extensions, depth, true)).search_game(game);
    let narrowed = Searcher::new(config(true, check_extensions, depth, true)).search_game(game);
    assert_eq!(
        plain.depth, depth,
        "full-window search did not complete depth"
    );
    assert_eq!(
        narrowed.depth, depth,
        "RootAlpha search did not complete depth"
    );
    assert_eq!(narrowed.score, plain.score, "RootAlpha changed exact score");
    assert_eq!(
        narrowed.mate_in, plain.mate_in,
        "RootAlpha changed mate distance"
    );
    assert_eq!(
        narrowed.best_move, plain.best_move,
        "stable root tie changed"
    );
    assert!(narrowed.nodes <= 2_000_000);
    assert!(plain.nodes <= 2_000_000);
    narrowed
}

#[test]
fn default_search_uses_the_frozen_explicit_composite_behavior() {
    let game = Game::new(Position::startpos());
    let default_result = Searcher::new(SearchConfig {
        node_limit: 10_000,
        max_depth: 2,
        ..SearchConfig::default()
    })
    .search_game(&game);
    let explicit_result = Searcher::new(SearchConfig {
        node_limit: 10_000,
        max_depth: 2,
        use_root_alpha: true,
        use_check_extensions: true,
        ..SearchConfig::default()
    })
    .search_game(&game);

    assert_eq!(default_result, explicit_result);

    let frozen_baseline = Searcher::new(SearchConfig {
        node_limit: 10_000,
        max_depth: 2,
        use_root_alpha: true,
        use_check_extensions: true,
        use_killer_history_ordering: false,
        ..SearchConfig::default()
    })
    .search_game(&game);
    assert_eq!(
        (
            frozen_baseline.best_move.unwrap().to_iccs(),
            frozen_baseline.score,
            frozen_baseline.nodes,
            frozen_baseline.depth
        ),
        ("b2b6".to_owned(), 7, 2_530, 2),
        "the pre-KH frozen snapshot explicitly disables the adopted ordering"
    );
    let config = SearchConfig::default();
    assert!(config.use_root_alpha);
    assert!(config.use_check_extensions);
}

#[test]
fn root_alpha_matches_full_window_with_extensions_independently_off_or_on() {
    let start = Game::new(Position::startpos());
    let start_result = assert_same_full_depth(&start, 2, false);
    assert_eq!(start_result.best_move.unwrap().to_iccs(), "b2b6");
    assert_eq!(start_result.score, 7);
    assert_same_full_depth(&start, 2, true);

    let tactical = Position::from_fen("3a5/4N4/P3k4/4c4/3R5/9/9/9/9/3K5 w - - 0 1")
        .expect("frozen tactic FEN is valid");
    assert_same_full_depth(&Game::new(tactical.clone()), 2, false);
    assert_same_full_depth(&Game::new(tactical), 2, true);

    let mate =
        Position::from_fen("9/2Nka4/9/5R3/9/9/9/9/9/5K3 w - - 0 1").expect("mate fixture is valid");
    let winning = assert_same_full_depth(&Game::new(mate.clone()), 3, false);
    assert_eq!((winning.score > 0, winning.mate_in), (true, Some(2)));
    let winning_extended = assert_same_full_depth(&Game::new(mate.clone()), 3, true);
    assert!(winning_extended.score > 0);

    let mut losing_game = Game::new(mate);
    losing_game.play(Move::from_iccs("f6f8").unwrap()).unwrap();
    assert!(losing_game.outcome().is_none());
    let mut losing_position = losing_game.position().clone();
    assert!(losing_position.legal_moves().len() > 1);
    let losing = assert_same_full_depth(&losing_game, 2, false);
    assert_eq!((losing.score < 0, losing.mate_in), (true, Some(1)));
    let losing_extended = assert_same_full_depth(&losing_game, 2, true);
    assert!(losing_extended.score < 0);
    assert_eq!(losing_extended.mate_in, losing.mate_in);
}

#[test]
fn check_extension_score_is_stable_with_transposition_table_enabled_or_disabled() {
    let position = Position::from_fen("3a5/4N4/P3k4/4c4/3R5/9/9/9/9/3K5 w - - 0 1")
        .expect("frozen tactic FEN is valid");
    let game = Game::new(position);
    let cached = Searcher::new(config(true, true, 2, true)).search_game(&game);
    let uncached = Searcher::new(config(true, true, 2, false)).search_game(&game);
    assert_eq!(cached.depth, 2);
    assert_eq!(uncached.depth, 2);
    assert_eq!(cached.score, uncached.score);
    assert_eq!(cached.mate_in, uncached.mate_in);
}

#[test]
fn composite_search_returns_a_legal_move_and_only_a_completed_iteration_on_stop() {
    let game = Game::new(Position::startpos());
    let searcher = Searcher::new(config(true, true, 8, true));
    let mut calls = 0;
    let stopped = searcher.search_game_until(&game, || {
        calls += 1;
        calls >= 1_000
    });
    let movement = stopped.best_move.expect("legal fallback remains available");
    assert!(game.position().clone().make_move(movement).is_ok());
    assert!(stopped.depth > 0);
    assert!(stopped.nodes <= 2_000_000);

    let complete_prefix = Searcher::new(config(true, true, stopped.depth, true)).search_game(&game);
    assert_eq!(stopped.depth, complete_prefix.depth);
    assert_eq!(stopped.best_move, complete_prefix.best_move);
    assert_eq!(stopped.score, complete_prefix.score);
    assert_eq!(stopped.mate_in, complete_prefix.mate_in);
}

#[test]
fn composite_search_is_deterministic_and_handles_existing_game_history() {
    let mut repeated = Game::new(Position::startpos());
    for text in ["h0g2", "h9g7", "g2h0", "g7h9", "h0g2", "h9g7", "g2h0"] {
        repeated.play(Move::from_iccs(text).unwrap()).unwrap();
    }
    assert!(repeated.outcome().is_none());
    let searcher = Searcher::new(config(true, true, 1, true));
    let first = searcher.search_game(&repeated);
    let second = searcher.search_game(&repeated);
    assert_eq!(first, second);
}

#[test]
fn multipv_observer_and_single_line_result_match_under_the_composite_configuration() {
    let game = Game::new(Position::startpos());
    let searcher = Searcher::new(config(true, true, 2, true));
    let single = searcher.search_game(&game);
    let mut reported = Vec::new();
    let lines = searcher.search_multipv_with_progress(
        &game,
        3,
        || false,
        |depth, nodes, rows| reported.push((depth, nodes, rows.to_vec())),
    );
    assert_eq!(single.depth, 2);
    assert_eq!(lines.first().unwrap().best_move, single.best_move.unwrap());
    assert_eq!(lines.first().unwrap().score, single.score);
    assert_eq!(lines.first().unwrap().mate_in, single.mate_in);
    assert_eq!(reported.last().unwrap().2, lines);
    assert!(reported.iter().all(|(_, _, rows)| rows.len() == 3));
}

#[test]
fn check_extensions_preserve_terminal_history_and_node_cap_boundaries() {
    let terminal = Position::from_fen("3rk4/9/9/9/4P4/9/9/2n6/4r2n1/4K4 w - - 120 1")
        .expect("terminal fixture is valid");
    let terminal_result = Searcher::new(config(true, true, 8, true)).search(&terminal);
    assert_eq!(terminal_result.best_move, None);
    assert_eq!(terminal_result.nodes, 0);

    let mut repeated = Game::new(Position::startpos());
    for text in [
        "b0c2", "b9c7", "c2b0", "c7b9", "b0c2", "b9c7", "c2b0", "c7b9",
    ] {
        repeated.play(Move::from_iccs(text).unwrap()).unwrap();
    }
    assert!(repeated.outcome().is_some());
    assert_eq!(
        Searcher::new(config(true, true, 8, true))
            .search_game(&repeated)
            .best_move,
        None
    );

    let start = Position::from_fen("1n2k4/3R5/9/9/4P4/9/9/9/9/1N2K4 w - - 0 1")
        .expect("bounded-check fixture is valid");
    let mut checking_game = Game::new(start);
    for text in ["b0c2", "b9c7", "d8e8", "e9d9", "e8d8", "d9e9"] {
        checking_game.play(Move::from_iccs(text).unwrap()).unwrap();
    }
    assert!(checking_game.outcome().is_none());
    let bounded = Searcher::new(SearchConfig {
        node_limit: 5_000,
        max_depth: u8::MAX,
        use_root_alpha: true,
        use_check_extensions: true,
        ..SearchConfig::default()
    })
    .search_game(&checking_game);
    assert!(bounded.best_move.is_some());
    assert!(bounded.nodes <= 5_000);
}
