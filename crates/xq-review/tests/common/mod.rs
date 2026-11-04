//! Shared fixtures for reason tests: a scripted analyzer and a one-ply review helper.
#![allow(dead_code)]

use std::collections::HashMap;

use xq_core::{Game, Move, Position};
use xq_review::{Analyzer, Limit, Line, PlyAnalysis, ReasonKind, ReviewScore, review_one_move};

#[derive(Default)]
pub struct Fixture(HashMap<(String, usize), Vec<Line>>);

impl Fixture {
    pub fn set(&mut self, game: &Game, multipv: usize, lines: Vec<Line>) {
        self.0.insert((game.position().to_fen(), multipv), lines);
    }
}

impl Analyzer for Fixture {
    fn analyze(&mut self, position: &Position, _: Limit, multipv: usize) -> Vec<Line> {
        self.0
            .get(&(position.to_fen(), multipv))
            .cloned()
            .unwrap_or_default()
    }
    fn name(&self) -> String {
        "fixture".into()
    }
}

pub fn line(pv: &[&str], score: ReviewScore) -> Line {
    Line {
        best_move: Move::from_iccs(pv[0]).unwrap(),
        score,
        principal_variation: pv
            .iter()
            .map(|text| Move::from_iccs(text).unwrap())
            .collect(),
        depth: 6,
        nodes: 100,
        pv_end: xq_engine::PrincipalVariationEnd::DepthLimit,
    }
}

/// Review `played` in `fen`. The best line scores +400 for the mover; the reply line after
/// the played move scores `after_score` for the opponent (default 0 => about 29% loss).
pub fn review_with_after(
    fen: &str,
    played: &str,
    best_pv: &[&str],
    actual_pv: &[&str],
    after_score: ReviewScore,
) -> PlyAnalysis {
    review_scores(
        fen,
        played,
        best_pv,
        actual_pv,
        ReviewScore::centipawns(400),
        after_score,
    )
}

pub fn review_best_score(
    fen: &str,
    played: &str,
    best_pv: &[&str],
    actual_pv: &[&str],
    best_score: ReviewScore,
) -> PlyAnalysis {
    review_scores(
        fen,
        played,
        best_pv,
        actual_pv,
        best_score,
        ReviewScore::centipawns(0),
    )
}

pub fn review_scores(
    fen: &str,
    played: &str,
    best_pv: &[&str],
    actual_pv: &[&str],
    best_score: ReviewScore,
    after_score: ReviewScore,
) -> PlyAnalysis {
    let game = Game::new(Position::from_fen(fen).unwrap());
    let played = Move::from_iccs(played).unwrap();
    let mut after = game.clone();
    after
        .play(played)
        .unwrap_or_else(|error| panic!("played {played:?} in {fen}: {error:?}"));
    let mut fixture = Fixture::default();
    let mut best_line = line(best_pv, best_score);
    // Before P4 a best line and an actual line of different lengths could not be compared, and
    // these fixtures use that to keep the material rule out of the way of the rule under test.
    // The material rule now compares unequal lines, so the same intent is stated explicitly: the
    // engine did not finish the best line (a transposition-table cutoff), hence no ledger.
    if best_pv.len() != actual_pv.len() {
        best_line.pv_end = xq_engine::PrincipalVariationEnd::TranspositionCutoff;
    }
    fixture.set(&game, 3, vec![best_line]);
    fixture.set(&after, 1, vec![line(&actual_pv[1..], after_score)]);
    review_one_move(&mut fixture, &game, played, Limit::new(100)).unwrap()
}

pub fn review(fen: &str, played: &str, best_pv: &[&str], actual_pv: &[&str]) -> PlyAnalysis {
    review_with_after(fen, played, best_pv, actual_pv, ReviewScore::centipawns(0))
}

pub fn kind_of(result: &PlyAnalysis) -> Option<ReasonKind> {
    result.reason.as_ref().map(|reason| reason.kind)
}
