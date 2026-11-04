use xq_core::{Game, Move, Position};
use xq_engine::{SearchConfig, SearchLine, Searcher};

/// Opt-in PV recording must not change the search: same best moves, scores, depths,
/// mate distances and node counts as the untraced MultiPV search.
fn game_after(moves: &str) -> Game {
    let mut game = Game::new(Position::startpos());
    for text in moves.split_whitespace() {
        game.play(Move::from_iccs(text).unwrap())
            .unwrap_or_else(|_| panic!("illegal fixture move {text} in `{moves}`"));
    }
    game
}

fn fixed_positions() -> Vec<(String, Game)> {
    let mut positions: Vec<(String, Game)> = [
        "",
        "h2e2",
        "h2e2 h9g7",
        "b2e2 b9c7",
        "b0c2 b9c7",
        "h0g2 h9g7",
        "c3c4 c6c5",
        "g3g4 g6g5",
        "a3a4 a6a5",
        "i3i4 i6i5",
        "e3e4 e6e5",
        "h2e2 h9g7 h0g2 i9h9",
    ]
    .iter()
    .map(|moves| (format!("startpos + [{moves}]"), game_after(moves)))
    .collect();
    for fen in [
        "4k4/4r4/9/4p4/9/9/9/9/4R4/3K5 w - - 0 1",
        "3rk4/9/9/9/4P4/9/9/2n1r4/7n1/4K4 b - - 0 1",
    ] {
        positions.push((fen.to_owned(), Game::new(Position::from_fen(fen).unwrap())));
    }
    positions
}

#[test]
fn principal_variation_recording_leaves_multipv_search_unchanged() {
    let searcher = Searcher::new(SearchConfig {
        node_limit: 20_000,
        max_depth: 5,
        ..SearchConfig::default()
    });
    let positions = fixed_positions();
    assert!(positions.len() >= 10);
    for (name, game) in &positions {
        let mut last: Option<(u8, u64, Vec<SearchLine>)> = None;
        let untraced = searcher.search_multipv_with_progress(
            game,
            3,
            || false,
            |d, n, lines| {
                last = Some((d, n, lines.to_vec()));
            },
        );
        let traced = searcher.search_multipv_with_principal_variation(game, 3, || false);

        assert_eq!(traced.len(), untraced.len(), "{name}: candidate count");
        for (with_pv, without) in traced.iter().zip(untraced.iter()) {
            assert_eq!(with_pv.line, *without, "{name}: bestmove/score/depth/mate");
        }
        if let Some((depth, nodes, _)) = last {
            for with_pv in &traced {
                assert_eq!(with_pv.nodes, nodes, "{name}: nodes");
                assert_eq!(with_pv.line.depth, depth, "{name}: depth");
            }
        }
    }
}
