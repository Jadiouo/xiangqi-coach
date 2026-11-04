//! Cost probe for the product review flow: analyzer calls, node total and wall time when
//! reviewing sample-beginner game 0 (level-4 self-play, first 60 plies) with the same limits
//! and two-pass flow the wasm review session uses (quick 100,000, deep 100,000 x XQ_DEEP_FACTOR
//! nodes, factor default 3 as in the product; set 10 to reproduce the old numbers,
//! `SearchConfig { node_limit: u32::MAX, ..default }`).
//!
//! Re-run after changing the review flow:
//!   systemd-run --user --scope -q -p MemoryMax=12G -p MemorySwapMax=0 \
//!     cargo run -q --release -j4 -p xq-review --example review_cost [plies]
//! Output is machine-readable `key=value` lines. Wall time is machine dependent; the call and
//! node counts are deterministic.

use std::time::Instant;

use xq_core::{Game, Move, Position};
use xq_engine::SearchConfig;
use xq_review::{Analyzer, BuiltinAnalyzer, IncrementalReview, Limit, Line, PlyInput};

struct Counting {
    inner: BuiltinAnalyzer,
    calls: u64,
    nodes: u64,
    requested_nodes: u64,
}

impl Counting {
    fn note(&mut self, limit: Limit, lines: &[Line]) {
        self.calls += 1;
        self.requested_nodes += limit.nodes;
        self.nodes += lines.iter().map(|line| line.nodes).max().unwrap_or(0);
    }
}

impl Analyzer for Counting {
    fn analyze(&mut self, pos: &Position, limit: Limit, multipv: usize) -> Vec<Line> {
        let lines = self.inner.analyze(pos, limit, multipv);
        self.note(limit, &lines);
        lines
    }

    fn analyze_game_until(
        &mut self,
        game: &Game,
        limit: Limit,
        multipv: usize,
        should_stop: &mut dyn FnMut() -> bool,
    ) -> Vec<Line> {
        let lines = self
            .inner
            .analyze_game_until(game, limit, multipv, should_stop);
        self.note(limit, &lines);
        lines
    }

    fn name(&self) -> String {
        self.inner.name()
    }
}

fn main() {
    let deep_factor: u64 = std::env::var("XQ_DEEP_FACTOR")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);
    let plies_wanted: usize = std::env::args()
        .nth(1)
        .map_or(60, |text| text.parse().expect("plies"));
    let tsv = include_str!("../tests/fixtures/level-games/games.tsv");
    let row: Vec<&str> = tsv
        .lines()
        .map(|line| line.split('\t').collect::<Vec<_>>())
        .find(|cols| cols.get(1) == Some(&"4") && cols.get(2) == Some(&"0"))
        .expect("level 4 game 0");
    let mut game = Game::new(Position::startpos());
    let mut plies = Vec::new();
    for text in row[7].split(' ').take(plies_wanted) {
        let movement = Move::from_iccs(text).unwrap();
        plies.push(PlyInput::new(game.clone(), movement));
        game.play(movement).unwrap();
    }
    let mut analyzer = Counting {
        inner: BuiltinAnalyzer::new(SearchConfig {
            node_limit: u64::from(u32::MAX),
            ..SearchConfig::default()
        }),
        calls: 0,
        nodes: 0,
        requested_nodes: 0,
    };
    let started = Instant::now();
    let mut review = IncrementalReview::new(
        &mut analyzer,
        plies,
        Limit::new(100_000),
        Limit::new(100_000 * deep_factor),
    );
    while review.advance().expect("review").is_some() {}
    let elapsed = started.elapsed();
    let report = review.report();
    let marked = report
        .points
        .iter()
        .filter(|p| p.final_result.comparison.is_some())
        .count();
    let deepened = report.points.iter().filter(|p| p.deepened).count();
    let incomplete = report
        .points
        .iter()
        .filter_map(|p| p.final_result.comparison.as_ref())
        .filter(|c| !c.played_complete || !c.best_complete)
        .count();
    println!("plies={}", report.points.len());
    println!("deepened={deepened}");
    println!("with_comparison={marked}");
    println!("comparison_incomplete={incomplete}");
    println!("wall_seconds={:.2}", elapsed.as_secs_f64());
    drop(review);
    println!("analyzer_calls={}", analyzer.calls);
    println!("nodes_searched={}", analyzer.nodes);
    println!("nodes_requested={}", analyzer.requested_nodes);
}
