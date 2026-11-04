use std::collections::HashMap;

use xq_core::{Game, Move, Position};
use xq_review::{Analyzer, Limit, Line, PlyAnalysis, ReasonKind, ReviewScore, review_one_move};

#[derive(Default)]
struct FixtureAnalyzer(HashMap<(String, usize), Vec<Line>>);

impl FixtureAnalyzer {
    fn set(&mut self, position: &Position, multipv: usize, lines: Vec<Line>) {
        self.0.insert((position.to_fen(), multipv), lines);
    }
}

impl Analyzer for FixtureAnalyzer {
    fn analyze(&mut self, position: &Position, _: Limit, multipv: usize) -> Vec<Line> {
        self.0
            .get(&(position.to_fen(), multipv))
            .cloned()
            .unwrap_or_default()
    }
    fn name(&self) -> String {
        "fixture".to_owned()
    }
}

fn line(move_text: &str, score: ReviewScore) -> Line {
    Line {
        best_move: Move::from_iccs(move_text).unwrap(),
        score,
        principal_variation: vec![Move::from_iccs(move_text).unwrap()],
        depth: 1,
        nodes: 10,
        pv_end: xq_engine::PrincipalVariationEnd::DepthLimit,
    }
}

fn analyze_with(best: ReviewScore, played_after: ReviewScore) -> PlyAnalysis {
    let game = Game::new(Position::startpos());
    let played = Move::from_iccs("b2c2").unwrap();
    let mut after = game.clone();
    after.play(played).unwrap();
    let mut analyzer = FixtureAnalyzer::default();
    analyzer.set(
        game.position(),
        3,
        vec![line("h2e2", best), line("b2c2", ReviewScore::centipawns(0))],
    );
    analyzer.set(after.position(), 1, vec![line("h7g7", played_after)]);
    review_one_move(&mut analyzer, &game, played, Limit::new(100)).unwrap()
}

#[test]
fn reason_selects_entered_mate_before_missed_mate_and_preserves_distance() {
    let result = analyze_with(ReviewScore::mate_in(4), ReviewScore::mate_in(2));
    let reason = result
        .reason
        .expect("marked played mate should have a reason");
    assert_eq!(reason.kind, ReasonKind::WalkedIntoMate);
    assert_eq!(reason.moves, 2);
}

#[test]
fn missed_mate_reason_requires_unplayed_best_mate_and_keeps_mover_distance() {
    let result = analyze_with(ReviewScore::mate_in(3), ReviewScore::centipawns(0));
    let reason = result.reason.expect("missed mate should have a reason");
    assert_eq!(reason.kind, ReasonKind::MissedMate);
    assert_eq!(reason.moves, 3);
}

#[test]
fn black_side_mate_distance_is_kept_from_the_mover_view() {
    let fen = "5k3/9/9/9/R4n3/6N2/9/9/9/3RK4 b - - 0 1";
    let game = Game::new(Position::from_fen(fen).unwrap());
    let played = Move::from_iccs("f5g3").unwrap();
    let mut after = game.clone();
    after.play(played).unwrap();
    let mut analyzer = FixtureAnalyzer::default();
    analyzer.set(
        game.position(),
        3,
        vec![
            line("f5g7", ReviewScore::centipawns(0)),
            line("f5g3", ReviewScore::centipawns(-200)),
        ],
    );
    analyzer.set(
        after.position(),
        1,
        vec![line("a5a9", ReviewScore::mate_in(2))],
    );

    let result = review_one_move(&mut analyzer, &game, played, Limit::new(100)).unwrap();
    assert_eq!(result.played_score.mate_in, Some(-2));
    assert_eq!(result.reason.unwrap().moves, 2);
}

#[test]
fn no_mate_evidence_means_no_supported_reason() {
    let result = analyze_with(ReviewScore::centipawns(20), ReviewScore::centipawns(0));
    assert!(result.reason.is_none());
}

#[test]
fn two_frozen_proof_positions_report_walked_into_mate_first() {
    use xq_engine::SearchConfig;
    use xq_review::BuiltinAnalyzer;

    // TSV mate1-11 root is complete unique h1h9/mate 1 (53 nodes, 54 branches).
    // After the legal played move f1f2, child proof is complete unique e8f8/mate 4
    // (609,017 nodes, 68 branches) at depth 4 and cap 1,000,000.
    let cases = [
        (
            "mate1-11",
            "4k4/4r4/9/9/C8/2C6/2R6/9/5K1R1/9 w - - 0 1",
            "f1f2",
            "h1h9",
            4,
        ),
        // TSV mate1-15 root is complete unique c9f9/mate 1 (51 nodes, 52 branches).
        // After the legal played move c0d0, child proof is complete unique a5e5/mate 3
        // (5,292 nodes, 54 branches) at depth 3 and cap 1,000,000.
        (
            "mate1-15",
            "2R6/9/5k3/9/r8/2C6/9/6R2/9/2C1K4 w - - 0 1",
            "c0d0",
            "c9f9",
            3,
        ),
    ];
    for (fixture, fen, played_text, expected_best, mate_distance) in cases {
        let game = Game::new(Position::from_fen(fen).unwrap());
        let played = Move::from_iccs(played_text).unwrap();
        let mut played_game = game.clone();
        played_game.play(played).unwrap();
        let mut analyzer = BuiltinAnalyzer::new(SearchConfig {
            node_limit: 100_000,
            ..SearchConfig::default()
        });
        let result = review_one_move(&mut analyzer, &game, played, Limit::new(100_000))
            .unwrap_or_else(|error| panic!("{fixture}: {error:?}"));
        assert_eq!(
            result.best_move.to_iccs(),
            expected_best,
            "{fixture} best move"
        );
        assert_eq!(result.best_score.mate_in, Some(1), "{fixture} root mate");
        assert_eq!(
            result.played_score.mate_in,
            Some(-mate_distance),
            "{fixture} played score"
        );
        assert_eq!(
            result.reason,
            Some(xq_review::Reason::bare(
                ReasonKind::WalkedIntoMate,
                mate_distance as u16
            )),
            "{fixture} reason"
        );
    }
}

#[test]
fn real_mate_scores_that_keep_the_mate_or_play_the_best_move_do_not_create_a_reason() {
    use xq_engine::SearchConfig;
    use xq_review::BuiltinAnalyzer;
    for (fixture, fen, played_text, expected_best, expected_played_mate) in [
        (
            "mate1-03",
            "5k3/9/9/9/R4n3/6N2/9/9/9/3RK4 w - - 0 1",
            "d0c0",
            "a5f5",
            2,
        ),
        (
            "mate1-15",
            "2R6/9/5k3/9/r8/2C6/9/6R2/9/2C1K4 w - - 0 1",
            "c9f9",
            "c9f9",
            1,
        ),
    ] {
        let game = Game::new(Position::from_fen(fen).unwrap());
        let played = Move::from_iccs(played_text).unwrap();
        let mut analyzer = BuiltinAnalyzer::new(SearchConfig {
            node_limit: 100_000,
            ..SearchConfig::default()
        });
        let result = review_one_move(&mut analyzer, &game, played, Limit::new(100_000))
            .unwrap_or_else(|error| panic!("{fixture}: {error:?}"));
        assert_eq!(
            result.best_move.to_iccs(),
            expected_best,
            "{fixture} best move"
        );
        assert_eq!(
            result.played_score.mate_in,
            Some(expected_played_mate),
            "{fixture} played score"
        );
        assert_eq!(
            result.reason, None,
            "{fixture} should not emit an entered-mate reason"
        );
    }
}
