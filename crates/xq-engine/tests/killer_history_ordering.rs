use xq_core::Game;
use xq_core::Position;
use xq_engine::{SearchConfig, Searcher};

const QUIET_CUTOFF_POSITION: &str = "4k4/4r4/9/4p4/9/9/9/9/4R4/3K5 w - - 0 1";

#[test]
fn killer_history_ordering_reduces_search_nodes_without_changing_the_completed_result() {
    let position = Position::from_fen(QUIET_CUTOFF_POSITION).unwrap();
    let baseline = SearchConfig {
        node_limit: 100_000,
        max_depth: 5,
        use_killer_history_ordering: false,
        ..SearchConfig::default()
    };
    let candidate = SearchConfig {
        use_killer_history_ordering: true,
        ..baseline.clone()
    };

    let before = Searcher::new(baseline).search(&position);
    let searcher = Searcher::new(candidate);
    let after = searcher.search(&position);
    let replay = searcher.search(&position);

    assert_eq!(before.depth, 5);
    assert_eq!(after.depth, 5);
    assert_eq!(
        (after.best_move, after.score, after.mate_in),
        (before.best_move, before.score, before.mate_in)
    );
    assert!(
        after.nodes < before.nodes,
        "quiet-cutoff ordering should avoid repeated subtree work"
    );
    assert_eq!(
        after, replay,
        "ordering state must reset deterministically for each search"
    );
    assert!(position.clone().make_move(after.best_move.unwrap()).is_ok());
}

#[test]
fn killer_history_ordering_is_enabled_by_default() {
    assert!(SearchConfig::default().use_killer_history_ordering);
}

#[test]
fn killer_history_ordering_keeps_multipv_and_stop_at_complete_depths() {
    let position = Position::from_fen(QUIET_CUTOFF_POSITION).unwrap();
    let game = Game::new(position.clone());
    let context = game.context_key();
    let config = SearchConfig {
        node_limit: 100_000,
        max_depth: 4,
        use_killer_history_ordering: true,
        ..SearchConfig::default()
    };
    let searcher = Searcher::new(config.clone());
    let single = searcher.search_game(&game);
    let lines = searcher.search_multipv(&game, 3);
    assert_eq!(single.depth, 4);
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0].best_move, single.best_move.unwrap());
    assert_eq!(lines[0].score, single.score);
    assert!(lines.windows(2).all(|pair| pair[0].score >= pair[1].score));
    assert!(
        lines
            .iter()
            .all(|line| { line.depth == 4 && position.clone().make_move(line.best_move).is_ok() })
    );

    let mut stop_calls = 0;
    let mut completed_depths = Vec::new();
    let stopped_lines = Searcher::new(config).search_multipv_with_progress(
        &game,
        3,
        || {
            stop_calls += 1;
            stop_calls >= 100
        },
        |depth, _, _| completed_depths.push(depth),
    );
    let stopped_depth = stopped_lines.first().map_or(0, |line| line.depth);
    assert!(completed_depths.iter().all(|depth| *depth <= stopped_depth));
    assert_eq!(completed_depths.last().copied().unwrap_or(0), stopped_depth);
    assert!(
        stopped_lines
            .iter()
            .all(|line| position.clone().make_move(line.best_move).is_ok())
    );
    assert_eq!(
        game.context_key(),
        context,
        "search and cancellation must not mutate Game"
    );
}
