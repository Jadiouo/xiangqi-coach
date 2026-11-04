use xq_core::{Game, Move, Position};
use xq_engine::{PrincipalVariationEnd, SearchConfig, SearchLine, Searcher};

#[test]
fn terminal_root_candidate_reports_its_observed_mating_pv() {
    let position = Position::from_fen("3rk4/9/9/9/4P4/9/9/2n1r4/7n1/4K4 b - - 0 1").unwrap();
    let game = Game::new(position);
    let mating_move = Move::from_iccs("e2e1").unwrap();
    let searcher = Searcher::new(SearchConfig {
        node_limit: 2_000,
        max_depth: 2,
        ..SearchConfig::default()
    });

    let lines = searcher.search_multipv_with_principal_variation(&game, 64, || false);
    let mating_line = lines
        .iter()
        .find(|line| line.line.best_move == mating_move)
        .unwrap_or_else(|| panic!("winning move absent; candidates: {lines:?}"));

    assert_eq!(mating_line.principal_variation, [mating_move]);
    assert_eq!(mating_line.end, PrincipalVariationEnd::Terminal);
    let mut replay = game.clone();
    replay.play(mating_move).unwrap();
    assert!(replay.outcome().is_some());
}

#[test]
fn observed_multipv_matches_untraced_search_and_contains_legal_six_ply_line() {
    let position = Position::from_fen("4k4/4r4/9/4p4/9/9/9/9/4R4/3K5 w - - 0 1").unwrap();
    let game = Game::new(position);
    let config = SearchConfig {
        node_limit: 300_000,
        max_depth: 6,
        ..SearchConfig::default()
    };
    let searcher = Searcher::new(config);
    let mut last_iteration: Option<(u8, u64, Vec<SearchLine>)> = None;
    let untraced = searcher.search_multipv_with_progress(
        &game,
        3,
        || false,
        |depth, nodes, lines| {
            last_iteration = Some((depth, nodes, lines.to_vec()));
        },
    );
    let observed = searcher.search_multipv_with_principal_variation(&game, 3, || false);

    let (depth, nodes, expected_lines) = last_iteration.expect("a full depth should complete");
    assert_eq!(observed.len(), expected_lines.len());
    assert_eq!(untraced, expected_lines);
    for (entry, expected) in observed.iter().zip(expected_lines.iter()) {
        assert_eq!(entry.line, *expected);
        assert_eq!(entry.nodes, nodes);
        assert_eq!(entry.line.depth, depth);
        assert_eq!(
            entry.principal_variation.first(),
            Some(&entry.line.best_move)
        );

        let mut replay = game.clone();
        for movement in &entry.principal_variation {
            assert!(
                replay.outcome().is_none(),
                "PV continued beyond terminal state"
            );
            replay
                .play(*movement)
                .expect("every PV move must be legal in context");
        }
        if entry.end == PrincipalVariationEnd::Terminal {
            assert!(replay.outcome().is_some());
        }
    }
    assert!(
        observed.iter().any(|entry| {
            entry.principal_variation.len() >= 6 && entry.end == PrincipalVariationEnd::DepthLimit
        }),
        "expected six plies at depth {depth}; candidates: {observed:?}"
    );
}
