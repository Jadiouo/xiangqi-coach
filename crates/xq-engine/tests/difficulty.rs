use xq_core::{Game, GameOutcome, Move, Position, Side};
use xq_engine::{
    SearchConfig, Searcher,
    difficulty::{DifficultyRequest, choose_move},
};

fn request(level: u8, seed: u64, config: SearchConfig, caller_nodes: u64) -> DifficultyRequest {
    DifficultyRequest {
        level,
        rng_state: seed,
        search_config: config,
        node_limit: caller_nodes,
    }
}

fn decision(
    game: &Game,
    level: u8,
    seed: u64,
    node_limit: u64,
) -> xq_engine::difficulty::DifficultyDecision {
    choose_move(
        game,
        request(
            level,
            seed,
            SearchConfig {
                node_limit,
                max_depth: 1,
                ..SearchConfig::default()
            },
            node_limit,
        ),
        || false,
    )
    .expect("valid difficulty level")
}

#[test]
fn same_game_level_and_seed_reproduce_move_analysis_and_next_state() {
    let game = Game::new(Position::startpos());
    let a = decision(&game, 3, 71, 0);
    let b = decision(&game, 3, 71, 0);
    assert_eq!(a, b);
    assert!(a.selected_move.is_some());
    assert!(a.used_fallback);
    assert!(
        a.analysis.is_none(),
        "a fallback must not claim a searched score"
    );
    assert_ne!(
        a.rng_state, 71,
        "a weak fallback draws only from the supplied caller state"
    );
}

#[test]
fn weak_fallback_uses_seeded_legal_choices_and_does_not_mutate_game_context() {
    let mut game = Game::new(Position::startpos());
    game.play(Move::from_iccs("h2e2").unwrap()).unwrap();
    let before_fen = game.position().to_fen();
    let before_context = game.context_key();
    let legal: Vec<_> = {
        let mut p = game.position().clone();
        p.legal_moves()
    };

    let choices: Vec<_> = (0..64)
        .map(|seed| decision(&game, 1, seed, 0).selected_move.unwrap())
        .collect();
    assert!(choices.iter().all(|movement| legal.contains(movement)));
    assert!(choices.iter().any(|movement| *movement != choices[0]));
    assert_eq!(game.position().to_fen(), before_fen);
    assert_eq!(game.context_key(), before_context);
}

#[test]
fn weak_level_returns_clean_completed_analysis_within_effective_node_cap() {
    let game = Game::new(Position::startpos());
    let config = SearchConfig {
        node_limit: 20_000,
        max_depth: 1,
        ..SearchConfig::default()
    };
    let result = choose_move(&game, request(9, 9, config, 20_000), || false).unwrap();
    assert!(result.selected_move.is_some());
    if let Some(analysis) = result.analysis {
        assert_eq!(analysis.depth, 1);
        assert!(analysis.nodes <= 16_384);
        assert!(
            analysis
                .lines
                .iter()
                .all(|line| line.depth == analysis.depth)
        );
        let expected = Searcher::new(SearchConfig {
            node_limit: analysis.nodes,
            max_depth: analysis.depth,
            ..SearchConfig::default()
        })
        .search_multipv(&game, analysis.lines.len());
        assert_eq!(
            analysis.lines, expected,
            "difficulty noise must not alter true analysis scores"
        );
    } else {
        assert!(result.used_fallback);
    }
}

#[test]
fn level_ten_matches_baseline_single_pv_under_caller_caps_depth_and_stop() {
    let game = Game::new(Position::startpos());
    let base = SearchConfig {
        node_limit: 4_000,
        max_depth: 2,
        use_transposition_table: false,
        use_move_ordering: false,
        use_check_extensions: false,
        use_root_alpha: false,
        use_killer_history_ordering: false,
    };
    let effective = SearchConfig {
        node_limit: 1_700,
        ..base.clone()
    };
    let expected = Searcher::new(effective.clone()).search_game(&game);
    let actual = choose_move(&game, request(10, 1234, base.clone(), 1_700), || false).unwrap();
    assert_eq!(actual.selected_move, expected.best_move);
    assert_eq!(actual.search_result, Some(expected));
    let analysis = actual
        .analysis
        .expect("completed baseline-equivalent search");
    assert_eq!(
        (
            analysis.score,
            analysis.depth,
            analysis.nodes,
            analysis.mate_in
        ),
        (
            expected.score,
            expected.depth,
            expected.nodes,
            expected.mate_in
        )
    );
    assert_eq!(
        actual.rng_state, 1234,
        "best-only level does not consume randomness"
    );

    let smaller_base = SearchConfig {
        node_limit: 64,
        max_depth: 1,
        ..base.clone()
    };
    let expected_by_config = Searcher::new(smaller_base.clone()).search_game(&game);
    let actual_by_config =
        choose_move(&game, request(10, 1234, smaller_base, 1_700), || false).unwrap();
    assert_eq!(actual_by_config.selected_move, expected_by_config.best_move);
    assert_eq!(actual_by_config.search_result, Some(expected_by_config));
    assert_eq!(
        actual_by_config
            .analysis
            .as_ref()
            .map(|a| (a.score, a.depth, a.nodes)),
        (expected_by_config.depth > 0).then_some((
            expected_by_config.score,
            expected_by_config.depth,
            expected_by_config.nodes
        ))
    );

    let stopped_base = Searcher::new(effective);
    let expected_stopped = stopped_base.search_game_until(&game, || true);
    let actual_stopped = choose_move(&game, request(10, 99, base, 1_700), || true).unwrap();
    assert_eq!(actual_stopped.selected_move, expected_stopped.best_move);
    assert_eq!(actual_stopped.search_result, Some(expected_stopped));
    assert!(
        actual_stopped.analysis.is_none(),
        "a stopped partial search exposes no score"
    );
    assert!(actual_stopped.used_fallback);
    assert_eq!(actual_stopped.rng_state, 99);

    let current_default = SearchConfig {
        node_limit: 1_700,
        max_depth: 2,
        ..SearchConfig::default()
    };
    let expected_default = Searcher::new(current_default.clone()).search_game(&game);
    let actual_default =
        choose_move(&game, request(10, 9876, current_default, 1_700), || false).unwrap();
    assert_eq!(actual_default.search_result, Some(expected_default));
    assert_eq!(actual_default.rng_state, 9876);
}

#[test]
fn terminal_game_returns_no_move_without_consuming_seed() {
    let position = Position::from_fen("1n3k3/9/3N5/9/9/9/R8/7N1/3K5/7C1 w - - 0 1").unwrap();
    let mut game = Game::new(position);
    game.play(Move::from_iccs("a3f3").unwrap()).unwrap();
    assert_eq!(game.outcome(), Some(GameOutcome::Win(Side::Red)));

    let result = choose_move(&game, request(1, 456, SearchConfig::default(), 0), || false).unwrap();
    assert_eq!(result.selected_move, None);
    assert_eq!(result.terminal, Some(GameOutcome::Win(Side::Red)));
    assert!(result.analysis.is_none());
    assert_eq!(result.rng_state, 456);
}

#[test]
fn invalid_difficulty_levels_are_rejected() {
    let game = Game::new(Position::startpos());
    for level in [0, 11] {
        assert!(
            choose_move(
                &game,
                request(level, 1, SearchConfig::default(), 1_000),
                || false
            )
            .is_err()
        );
    }
}

#[test]
fn weak_multi_candidate_search_honors_caller_stop_and_uses_legal_seeded_fallback() {
    let game = Game::new(Position::startpos());
    let legal: Vec<_> = {
        let mut position = game.position().clone();
        position.legal_moves()
    };
    let result = choose_move(
        &game,
        request(
            9,
            73,
            SearchConfig {
                node_limit: 20_000,
                max_depth: 2,
                ..SearchConfig::default()
            },
            20_000,
        ),
        || true,
    )
    .unwrap();
    assert!(result.used_fallback);
    assert!(result.analysis.is_none());
    assert!(legal.contains(&result.selected_move.unwrap()));
    assert_ne!(result.rng_state, 73);
}
