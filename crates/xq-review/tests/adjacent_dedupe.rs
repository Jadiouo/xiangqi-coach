//! Adjacent plies share one search: the search after ply i is the search before ply i + 1.
//! The merged path must give exactly the per-ply results of the old path (every ply searched on
//! its own), and must really run fewer searches. The old path is the same analyzer with sharing
//! switched off; its results are the expected value and are never edited.

use xq_core::{Game, Move, Position};
use xq_engine::SearchConfig;
use xq_review::{
    Analyzer, BuiltinAnalyzer, IncrementalReview, Limit, Line, PlyInput, TwoPassPlyAnalysis,
    analyze_two_pass,
};

// First 16 plies of docs/samples/data/sample-beginner.json. Plies 11, 12 and 13 lose more than 5%
// there, so the deep pass also meets adjacent plies.
const GAME: [&str; 16] = [
    "c3c4", "g6g5", "h2g2", "g9e7", "h0i2", "h9g7", "i0h0", "i9h9", "h0h6", "f9e8", "b2b9", "e6e5",
    "h6h4", "e8f9", "g2b2", "f9e8",
];
const QUICK_NODES: u64 = 3_000;

/// The built-in analyzer with call and node counters; `share` decides whether it declares that
/// its first line does not depend on the requested line count (the old path declares nothing).
struct Counting {
    inner: BuiltinAnalyzer,
    share: bool,
    searches: u64,
    nodes: u64,
}

impl Counting {
    fn new(share: bool) -> Self {
        Self {
            inner: BuiltinAnalyzer::new(SearchConfig {
                node_limit: u64::from(u32::MAX),
                ..SearchConfig::default()
            }),
            share,
            searches: 0,
            nodes: 0,
        }
    }
}

impl Analyzer for Counting {
    fn analyze(&mut self, pos: &Position, limit: Limit, multipv: usize) -> Vec<Line> {
        self.analyze_game(&Game::new(pos.clone()), limit, multipv)
    }

    fn analyze_game(&mut self, game: &Game, limit: Limit, multipv: usize) -> Vec<Line> {
        let lines = self.inner.analyze_game(game, limit, multipv);
        self.searches += 1;
        self.nodes += lines.iter().map(|line| line.nodes).max().unwrap_or(0);
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
        self.searches += 1;
        self.nodes += lines.iter().map(|line| line.nodes).max().unwrap_or(0);
        lines
    }

    fn first_line_ignores_multipv(&self) -> bool {
        self.share && self.inner.first_line_ignores_multipv()
    }

    fn name(&self) -> String {
        self.inner.name()
    }
}

fn plies(indices: &[usize]) -> Vec<PlyInput> {
    let mut game = Game::new(Position::startpos());
    let mut all = Vec::new();
    for text in GAME {
        let movement = Move::from_iccs(text).unwrap();
        all.push(PlyInput::new(game.clone(), movement));
        game.play(movement).unwrap();
    }
    indices.iter().map(|index| all[*index].clone()).collect()
}

fn run(analyzer: &mut Counting, indices: &[usize]) -> Vec<TwoPassPlyAnalysis> {
    let mut review = IncrementalReview::new(
        &mut *analyzer,
        plies(indices),
        Limit::new(QUICK_NODES),
        Limit::new(QUICK_NODES * 10),
    );
    while review.advance().expect("review step").is_some() {}
    review.report().points
}

#[test]
fn merged_review_equals_per_ply_review_for_adjacent_plies() {
    let indices: Vec<usize> = (9..16).collect();
    let (mut old, mut new) = (Counting::new(false), Counting::new(true));
    let expected = run(&mut old, &indices);
    let merged = run(&mut new, &indices);
    assert!(
        expected.iter().any(|point| point.deepened),
        "the fixture must exercise the deep pass"
    );
    assert_eq!(merged, expected);
}

#[test]
fn merged_review_equals_per_ply_review_when_plies_are_not_adjacent() {
    let indices = [9, 11, 12, 15];
    let (mut old, mut new) = (Counting::new(false), Counting::new(true));
    assert_eq!(run(&mut new, &indices), run(&mut old, &indices));
}

#[test]
fn merging_runs_fewer_searches_and_fewer_nodes() {
    let indices: Vec<usize> = (9..16).collect();
    let (mut old, mut new) = (Counting::new(false), Counting::new(true));
    run(&mut old, &indices);
    run(&mut new, &indices);
    eprintln!(
        "searches old {} new {}, nodes old {} new {}",
        old.searches, new.searches, old.nodes, new.nodes
    );
    // Quick pass: 2 searches per ply become n + 1; each adjacent deep pair saves one more.
    assert!(new.searches + indices.len() as u64 - 1 <= old.searches);
    assert!(new.nodes < old.nodes);
}

#[test]
fn analyze_two_pass_merges_the_same_way() {
    let indices: Vec<usize> = (9..16).collect();
    let (mut old, mut new) = (Counting::new(false), Counting::new(true));
    let inputs = plies(&indices);
    let expected = analyze_two_pass(
        &mut old,
        &inputs,
        Limit::new(QUICK_NODES),
        Limit::new(QUICK_NODES * 10),
    )
    .unwrap();
    let merged = analyze_two_pass(
        &mut new,
        &inputs,
        Limit::new(QUICK_NODES),
        Limit::new(QUICK_NODES * 10),
    )
    .unwrap();
    assert_eq!(merged, expected);
    assert!(new.searches < old.searches);
}
