use xq_core::{Game, Position};
use xq_engine::{SearchConfig, SearchLine, Searcher};

#[test]
fn completed_depth_callback_is_sorted_and_matches_final_multipv_result() {
    let game = Game::new(Position::startpos());
    let searcher = Searcher::new(SearchConfig {
        node_limit: 3_000,
        max_depth: 6,
        ..SearchConfig::default()
    });
    let mut snapshots: Vec<(u8, u64, Vec<SearchLine>)> = Vec::new();
    let final_lines = searcher.search_multipv_with_progress(
        &game,
        3,
        || false,
        |depth, nodes, lines| snapshots.push((depth, nodes, lines.to_vec())),
    );

    assert!(!snapshots.is_empty());
    assert!(snapshots.windows(2).all(|pair| pair[0].0 < pair[1].0));
    for (depth, nodes, lines) in &snapshots {
        assert!(*nodes <= 3_000);
        assert_eq!(lines.len(), 3);
        assert!(lines.iter().all(|line| line.depth == *depth));
        assert!(lines.windows(2).all(|pair| pair[0].score >= pair[1].score));
    }
    assert_eq!(final_lines, snapshots.last().unwrap().2);
    assert_eq!(
        final_lines,
        searcher.search_multipv_until(&game, 3, || false)
    );
}

#[test]
fn interrupted_first_depth_emits_no_partial_snapshot() {
    let game = Game::new(Position::startpos());
    let searcher = Searcher::new(SearchConfig {
        node_limit: 1,
        max_depth: 6,
        ..SearchConfig::default()
    });
    let mut callbacks = 0;
    let lines = searcher.search_multipv_with_progress(&game, 3, || false, |_, _, _| callbacks += 1);
    assert_eq!(callbacks, 0);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].depth, 0);
}
