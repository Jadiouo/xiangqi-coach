use std::env;
use xq_core::{Game, Move, Position};
use xq_engine::{SearchConfig, Searcher};

const NODE_LIMIT: u64 = 100_000;
const FIXTURE: &str = include_str!("fixtures/m4-tactics-v3.tsv");

fn screen_config_for(mode: Option<&str>) -> SearchConfig {
    let Some(mode) = mode else {
        return SearchConfig {
            node_limit: NODE_LIMIT,
            ..SearchConfig::default()
        };
    };
    let mut config = SearchConfig {
        node_limit: NODE_LIMIT,
        use_root_alpha: true,
        use_check_extensions: true,
        use_killer_history_ordering: false,
        ..SearchConfig::default()
    };
    match mode {
        "baseline" => config.use_killer_history_ordering = false,
        "killer" => config.use_killer_history_ordering = true,
        other => panic!("unknown XQ_M4_TACTICS_SCREEN mode: {other}"),
    }
    config
}

#[test]
fn screen_config_selects_exactly_one_additional_search_candidate() {
    let default = screen_config_for(None);
    let engine_default = SearchConfig::default();
    assert_eq!(default.node_limit, NODE_LIMIT);
    assert_eq!(default.use_root_alpha, engine_default.use_root_alpha);
    assert_eq!(
        default.use_check_extensions,
        engine_default.use_check_extensions
    );
    assert_eq!(
        default.use_killer_history_ordering,
        engine_default.use_killer_history_ordering
    );
    for (mode, killer) in [("baseline", false), ("killer", true)] {
        let config = screen_config_for(Some(mode));
        assert_eq!(config.node_limit, NODE_LIMIT);
        assert!(config.use_root_alpha);
        assert!(config.use_check_extensions);
        assert_eq!(config.use_killer_history_ordering, killer, "{mode}");
    }
}

#[test]
fn searches_all_frozen_mate_positions_within_the_node_limit() {
    let rows: Vec<_> = FIXTURE
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| {
            let fields: Vec<_> = line.split('\t').collect();
            assert_eq!(fields.len(), 4, "malformed M4 tactic fixture row: {line}");
            (
                fields[0].to_owned(),
                fields[1]
                    .parse::<u8>()
                    .expect("fixture mate distance must be an integer"),
                fields[2].to_owned(),
                Move::from_iccs(fields[3]).expect("fixture move must be valid ICCS"),
            )
        })
        .collect();
    assert_eq!(
        rows.len(),
        30,
        "the frozen fixture must contain 30 positions"
    );

    let mode = env::var("XQ_M4_TACTICS_SCREEN").ok();
    let searcher = Searcher::new(screen_config_for(mode.as_deref()));
    println!(
        "M4 frozen30 screen mode={}",
        mode.as_deref().unwrap_or("baseline")
    );
    let mut failures = Vec::new();
    for (id, target, fen, source_move) in rows {
        let position = Position::from_fen(&fen).expect("fixture FEN must parse");
        let mut after_source_move = position.clone();
        let source_move_is_legal = after_source_move.make_move(source_move).is_ok();
        let result = searcher.search_game(&Game::new(position));
        println!(
            "M4 {id} target={target} expected={} legal={} best={} score={} depth={} mate={:?} nodes={}",
            source_move.to_iccs(),
            source_move_is_legal,
            result
                .best_move
                .map(|movement| movement.to_iccs())
                .unwrap_or_else(|| "none".to_owned()),
            result.score,
            result.depth,
            result.mate_in,
            result.nodes,
        );
        if !source_move_is_legal
            || result.best_move != Some(source_move)
            || result.mate_in != Some(target)
            || result.nodes > NODE_LIMIT
        {
            failures.push((
                id,
                source_move_is_legal,
                result.best_move.map(|movement| movement.to_iccs()),
                result.mate_in,
                result.nodes,
            ));
        }
    }

    assert!(failures.is_empty(), "M4 tactic failures: {failures:?}");
}
