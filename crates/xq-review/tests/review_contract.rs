use std::collections::HashMap;

use xq_core::{Game, Move, Position};
use xq_engine::SearchConfig;
use xq_review::{
    Analyzer, BuiltinAnalyzer, Classification, IncrementalReview, Limit, Line, PlyInput,
    ReviewError, ReviewPass, ReviewScore, ReviewStep, analyze_two_pass, classify_loss,
    review_game_two_pass_until, review_one_move, win_probability,
};

#[derive(Default)]
struct FakeAnalyzer {
    lines: HashMap<(String, u64, usize), Vec<Line>>,
    calls: Vec<(String, u64, usize)>,
}

impl FakeAnalyzer {
    fn set(&mut self, position: &Position, limit: Limit, multipv: usize, lines: Vec<Line>) {
        self.lines
            .insert((position.to_fen(), limit.nodes, multipv), lines);
    }
}

impl Analyzer for FakeAnalyzer {
    fn analyze(&mut self, position: &Position, limit: Limit, multipv: usize) -> Vec<Line> {
        let key = (position.to_fen(), limit.nodes, multipv);
        self.calls.push(key.clone());
        self.lines.get(&key).cloned().unwrap_or_default()
    }

    fn name(&self) -> String {
        "fake".to_owned()
    }
}

fn line(move_text: &str, centipawns: i32, mate_in: Option<i16>) -> Line {
    Line {
        best_move: Move::from_iccs(move_text).unwrap(),
        score: ReviewScore {
            centipawns,
            mate_in,
        },
        principal_variation: vec![Move::from_iccs(move_text).unwrap()],
        depth: 1,
        nodes: 1,
        pv_end: xq_engine::PrincipalVariationEnd::DepthLimit,
    }
}

fn starting_game() -> Game {
    Game::new(Position::startpos())
}

#[test]
fn win_probability_uses_spec_default_and_mate_scores() {
    assert_eq!(win_probability(ReviewScore::centipawns(0)), 0.5);
    assert!(win_probability(ReviewScore::centipawns(100)) > 0.5);
    assert!((win_probability(ReviewScore::centipawns(1_042)) - 0.97).abs() < 0.01);
    assert!(
        (win_probability(ReviewScore::centipawns(300)) - 1.0 / (1.0 + (-1.0_f64).exp())).abs()
            < 1e-12
    );
    assert_eq!(
        win_probability(ReviewScore::mate_in(3)),
        1.0,
        "a forced mate for the side to move is a win"
    );
    assert_eq!(win_probability(ReviewScore::mated_in(3)), 0.0);
}

#[test]
fn win_probability_is_monotonic_over_a_centipawn_sweep() {
    // TEST_PLAN 6.1.2: -3000..=3000 cp in 50 cp steps; each step must not lower the
    // probability, and must raise it strictly while it is not saturated in f64.
    let mut previous = win_probability(ReviewScore::centipawns(-3_000));
    let mut points = 1;
    for cp in (-2_950..=3_000).step_by(50) {
        let current = win_probability(ReviewScore::centipawns(cp));
        assert!(
            current > previous,
            "p({cp}) = {current} is not above p({}) = {previous}",
            cp - 50
        );
        assert!((0.0..=1.0).contains(&current));
        previous = current;
        points += 1;
    }
    assert_eq!(points, 121);
}

#[test]
fn win_probability_of_opposite_scores_sums_to_one() {
    // TEST_PLAN 6.1.3: p(x) + p(-x) = 1 within 1e-12 for finite scores.
    for cp in (-3_000..=3_000).step_by(50) {
        let sum = win_probability(ReviewScore::centipawns(cp))
            + win_probability(ReviewScore::centipawns(-cp));
        assert!((sum - 1.0).abs() < 1e-12, "p({cp}) + p(-{cp}) = {sum}");
    }
    // Mate scores are exact opposites too (1.0 + 0.0).
    assert_eq!(
        win_probability(ReviewScore::mate_in(2)) + win_probability(ReviewScore::mated_in(2)),
        1.0
    );
}

#[test]
fn black_move_loss_is_measured_from_black_to_move_perspective() {
    let position =
        Position::from_fen("rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b - - 0 1")
            .unwrap();
    let game = Game::new(position.clone());
    let played = Move::from_iccs("h9g7").unwrap();
    let mut after = game.clone();
    after.play(played).unwrap();

    let quick = Limit::new(100);
    let mut analyzer = FakeAnalyzer::default();
    analyzer.set(
        &position,
        quick,
        3,
        vec![line("h9g7", 122, None), line("b9c7", 0, None)],
    );
    analyzer.set(after.position(), quick, 1, vec![line("h0g2", 186, None)]);

    let result = review_one_move(&mut analyzer, &game, played, quick).unwrap();
    assert!((result.loss_percent - 25.0).abs() < 0.2);
    assert_eq!(result.played_move, played);
}

#[test]
fn classification_covers_thresholds_unique_move_and_missed_mate() {
    assert_eq!(
        classify_loss(1.9, Some(2), false, false),
        Classification::Good
    );
    assert_eq!(
        classify_loss(1.9, Some(3), false, false),
        Classification::Unclassified
    );
    assert_eq!(
        classify_loss(2.0, Some(3), false, false),
        Classification::Inaccuracy
    );
    assert_eq!(
        classify_loss(4.9, Some(3), false, false),
        Classification::Inaccuracy
    );
    assert_eq!(
        classify_loss(5.0, Some(3), false, false),
        Classification::DoubtfulMove
    );
    assert_eq!(
        classify_loss(9.9, Some(3), false, false),
        Classification::DoubtfulMove
    );
    assert_eq!(
        classify_loss(10.0, Some(3), false, false),
        Classification::Mistake
    );
    assert_eq!(
        classify_loss(19.9, Some(3), false, false),
        Classification::Mistake
    );
    assert_eq!(
        classify_loss(20.0, Some(3), false, false),
        Classification::Blunder
    );
    assert_eq!(
        classify_loss(0.0, Some(1), true, false),
        Classification::UniqueMove
    );

    let game = starting_game();
    let played = Move::from_iccs("h2e2").unwrap();
    let mut after = game.clone();
    after.play(played).unwrap();
    let limit = Limit::new(100);
    let mut analyzer = FakeAnalyzer::default();
    analyzer.set(
        game.position(),
        limit,
        3,
        vec![line("b2e2", 1042, Some(3)), line("h2e2", 1042, None)],
    );
    // A found mate is 100% per SPEC; the played continuation remains about 98.5%,
    // so the special missed-mate label overrides the otherwise small 1.5% loss.
    analyzer.set(after.position(), limit, 1, vec![line("h9g7", -1_255, None)]);

    let result = review_one_move(&mut analyzer, &game, played, limit).unwrap();
    assert!((result.loss_percent - 1.5).abs() < 0.1);
    assert_eq!(result.classification, Classification::MissedMate);
}

#[test]
fn playing_the_best_move_is_not_a_missed_mate_if_child_analysis_differs() {
    let game = starting_game();
    let played = Move::from_iccs("h2e2").unwrap();
    let mut after = game.clone();
    after.play(played).unwrap();
    let limit = Limit::new(100);
    let mut analyzer = FakeAnalyzer::default();
    analyzer.set(
        game.position(),
        limit,
        3,
        vec![line("h2e2", 1042, Some(3)), line("b2e2", 1042, None)],
    );
    analyzer.set(after.position(), limit, 1, vec![line("h9g7", -1_255, None)]);

    let result = review_one_move(&mut analyzer, &game, played, limit).unwrap();
    assert_ne!(result.classification, Classification::MissedMate);
}

#[test]
fn unique_move_requires_the_best_line_and_a_fifteen_point_gap() {
    let game = starting_game();
    let played = Move::from_iccs("h2e2").unwrap();
    let mut after = game.clone();
    after.play(played).unwrap();
    let limit = Limit::new(100);

    for (second_score, expected) in [
        (-186, Classification::UniqueMove),
        (-185, Classification::Good),
    ] {
        let mut analyzer = FakeAnalyzer::default();
        analyzer.set(
            game.position(),
            limit,
            3,
            vec![line("h2e2", 0, None), line("b2e2", second_score, None)],
        );
        analyzer.set(after.position(), limit, 1, vec![line("h9g7", 0, None)]);

        let result = review_one_move(&mut analyzer, &game, played, limit).unwrap();
        assert_eq!(
            result.classification, expected,
            "second score {second_score}"
        );
    }
}

#[test]
fn second_pass_runs_only_above_five_percent_and_replaces_first_result() {
    let first_game = starting_game();
    let first_move = Move::from_iccs("h2e2").unwrap();
    let mut second_game = first_game.clone();
    second_game.play(first_move).unwrap();
    let second_move = Move::from_iccs("h9g7").unwrap();
    let first_after = {
        let mut game = first_game.clone();
        game.play(first_move).unwrap();
        game
    };
    let second_after = {
        let mut game = second_game.clone();
        game.play(second_move).unwrap();
        game
    };
    let quick = Limit::new(100);
    let deep = Limit::new(1_000);
    let mut analyzer = FakeAnalyzer::default();

    analyzer.set(first_game.position(), quick, 3, vec![line("h2e2", 0, None)]);
    analyzer.set(
        first_after.position(),
        quick,
        1,
        vec![line("h9g7", 59, None)],
    );
    analyzer.set(
        second_game.position(),
        quick,
        3,
        vec![line("h9g7", 0, None)],
    );
    analyzer.set(
        second_after.position(),
        quick,
        1,
        vec![line("h2e2", 61, None)],
    );

    let deep_best = Move::from_iccs("b9c7").unwrap();
    analyzer.set(
        second_game.position(),
        deep,
        3,
        vec![Line {
            best_move: deep_best,
            score: ReviewScore::centipawns(600),
            principal_variation: vec![deep_best],
            depth: 1,
            nodes: 1,
            pv_end: xq_engine::PrincipalVariationEnd::DepthLimit,
        }],
    );
    analyzer.set(
        second_after.position(),
        deep,
        1,
        vec![line("h2e2", -600, None)],
    );

    let inputs = [
        PlyInput::new(first_game, first_move),
        PlyInput::new(second_game, second_move),
    ];
    let results = analyze_two_pass(&mut analyzer, &inputs, quick, deep).unwrap();
    assert_eq!(results.len(), 2);
    assert!(!results[0].deepened);
    assert!(results[1].deepened);
    assert!((results[0].quick.loss_percent - 4.9).abs() < 0.2);
    assert!((results[1].quick.loss_percent - 5.1).abs() < 0.2);
    assert_eq!(results[1].final_result.best_move, deep_best);
    assert_eq!(
        results[1].final_result.best_score,
        ReviewScore::centipawns(600)
    );
    assert_eq!(results[1].final_result.loss_percent, 0.0);
    assert_eq!(
        analyzer
            .calls
            .iter()
            .filter(|(_, nodes, _)| *nodes == deep.nodes)
            .count(),
        2,
        "only the >5% ply is reanalyzed, at before and after positions"
    );
}

#[test]
fn focused_reanalysis_uses_one_requested_budget_without_a_nested_second_pass() {
    let mut game = starting_game();
    game.play(Move::from_iccs("h2e2").unwrap()).unwrap();
    let played = Move::from_iccs("h9g7").unwrap();
    let mut after = game.clone();
    after.play(played).unwrap();
    let requested = Limit::new(1_000_000);
    let mut analyzer = FakeAnalyzer::default();
    analyzer.set(
        game.position(),
        requested,
        3,
        vec![line("b9c7", 600, None), line("h9g7", 0, None)],
    );
    analyzer.set(after.position(), requested, 1, vec![line("h0g2", 0, None)]);

    let mut review =
        IncrementalReview::new_single_pass(analyzer, vec![PlyInput::new(game, played)], requested);
    let Some(ReviewStep::Point {
        pass,
        index,
        result,
    }) = review.advance().unwrap()
    else {
        panic!("focused analysis should produce its requested result");
    };
    assert_eq!(pass, ReviewPass::Quick);
    assert_eq!(index, 0);
    assert!(result.quick.loss_percent > 5.0);
    assert!(!result.deepened);
    assert!(
        review.advance().unwrap().is_none(),
        "one budget means one search pass"
    );
    assert_eq!(review.report().points.len(), 1);
}

#[test]
fn illegal_played_move_returns_a_structured_error() {
    let mut analyzer = FakeAnalyzer::default();
    let error = review_one_move(
        &mut analyzer,
        &starting_game(),
        Move::from_iccs("a0a9").unwrap(),
        Limit::new(100),
    )
    .unwrap_err();
    assert_eq!(error, ReviewError::IllegalPlayedMove);
}

#[test]
fn built_in_analyzer_returns_three_legal_side_to_move_candidates_in_score_order() {
    let config = SearchConfig {
        node_limit: 24_000,
        max_depth: 5,
        ..SearchConfig::default()
    };
    let mut analyzer = BuiltinAnalyzer::new(config);
    let position = Position::startpos();
    let lines = analyzer.analyze(&position, Limit::new(24_000), 3);

    assert_eq!(lines.len(), 3);
    assert!(
        lines
            .windows(2)
            .all(|pair| pair[0].score.centipawns >= pair[1].score.centipawns)
    );
    for line in lines {
        assert_eq!(line.principal_variation.first(), Some(&line.best_move));
        assert!(line.depth > 0);
        assert!(line.nodes > 0);
        assert_ne!(
            line.pv_end,
            xq_engine::PrincipalVariationEnd::NoCompletedIteration
        );
        let mut replay = Game::new(position.clone());
        for movement in line.principal_variation {
            assert!(replay.position().clone().legal_moves().contains(&movement));
            replay.play(movement).unwrap();
        }
    }
}

#[test]
fn built_in_review_scores_a_real_black_move_from_black_to_move_view() {
    let mut game = starting_game();
    game.play(Move::from_iccs("h2e2").unwrap()).unwrap();
    let played = Move::from_iccs("h9g7").unwrap();
    let config = SearchConfig {
        node_limit: 4_000,
        max_depth: 3,
        ..SearchConfig::default()
    };
    let mut analyzer = BuiltinAnalyzer::new(config);

    let result = review_one_move(&mut analyzer, &game, played, Limit::new(4_000)).unwrap();

    let legal = game.position().clone().legal_moves();
    assert!(legal.contains(&result.best_move));
    assert_eq!(result.played_move, played);
    assert_eq!(result.candidates.len(), 3);
    assert_eq!(result.candidates[0].best_move, result.best_move);
    assert_eq!(
        result.candidates[0].principal_variation.first(),
        Some(&result.best_move)
    );
    assert_eq!(
        result.best_win_probability,
        win_probability(result.best_score)
    );
    assert_eq!(
        result.played_win_probability,
        win_probability(result.played_score)
    );
}

#[test]
fn builtin_review_scores_a_move_that_reaches_the_120_ply_draw() {
    let position = Position::from_fen(
        "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 119 1",
    )
    .unwrap();
    let game = Game::new(position);
    let played = Move::from_iccs("h2e2").unwrap();
    let mut analyzer = BuiltinAnalyzer::new(SearchConfig {
        node_limit: 2_000,
        max_depth: 2,
        ..SearchConfig::default()
    });

    let result = review_one_move(&mut analyzer, &game, played, Limit::new(2_000));

    assert_eq!(result.unwrap().played_score, ReviewScore::centipawns(0));
}

#[test]
fn builtin_review_preserves_repetition_history_for_a_drawn_move() {
    let mut game = starting_game();
    for text in ["h0g2", "h9g7", "g2h0", "g7h9", "h0g2", "h9g7", "g2h0"] {
        game.play(Move::from_iccs(text).unwrap()).unwrap();
    }
    assert_eq!(game.outcome(), None);
    let played = Move::from_iccs("g7h9").unwrap();
    let mut analyzer = BuiltinAnalyzer::new(SearchConfig {
        node_limit: 2_000,
        max_depth: 2,
        ..SearchConfig::default()
    });

    let result = review_one_move(&mut analyzer, &game, played, Limit::new(2_000));

    assert_eq!(result.unwrap().played_score, ReviewScore::centipawns(0));
}

#[test]
fn builtin_review_scores_a_move_that_checkmates_from_the_movers_view() {
    let position = Position::from_fen("3rk4/9/9/9/4P4/9/9/2n1r4/7n1/4K4 b - - 0 1").unwrap();
    let mut game = Game::new(position);
    let played = Move::from_iccs("e2e1").unwrap();
    game.play(played).unwrap();
    assert!(matches!(game.outcome(), Some(xq_core::GameOutcome::Win(_))));

    let initial =
        Game::new(Position::from_fen("3rk4/9/9/9/4P4/9/9/2n1r4/7n1/4K4 b - - 0 1").unwrap());
    let mut analyzer = BuiltinAnalyzer::new(SearchConfig::default());
    let result = review_one_move(&mut analyzer, &initial, played, Limit::new(100)).unwrap();
    assert_eq!(result.played_score.mate_in, Some(1));
    assert_eq!(result.played_win_probability, 1.0);
}

#[test]
fn third_rank_with_less_than_two_percent_loss_is_not_good() {
    let game = starting_game();
    let played = Move::from_iccs("h2e2").unwrap();
    let mut after = game.clone();
    after.play(played).unwrap();
    let limit = Limit::new(100);
    let mut analyzer = FakeAnalyzer::default();
    analyzer.set(
        game.position(),
        limit,
        3,
        vec![
            line("b2e2", 0, None),
            line("b2a2", -1, None),
            line("h2e2", -2, None),
        ],
    );
    analyzer.set(after.position(), limit, 1, vec![line("h9g7", 23, None)]);

    let result = review_one_move(&mut analyzer, &game, played, limit).unwrap();
    assert!(result.loss_percent < 2.0);
    assert_eq!(result.played_rank, Some(3));
    assert_ne!(result.classification, Classification::Good);
    assert_eq!(result.classification, Classification::Unclassified);
}

#[test]
fn two_pass_backend_finishes_quick_scan_before_deepening_and_keeps_completed_points_on_cancel() {
    let first = starting_game();
    let first_move = Move::from_iccs("h2e2").unwrap();
    let second = {
        let mut game = first.clone();
        game.play(first_move).unwrap();
        game
    };
    let second_move = Move::from_iccs("h9g7").unwrap();
    let mut first_after = first.clone();
    first_after.play(first_move).unwrap();
    let mut second_after = second.clone();
    second_after.play(second_move).unwrap();
    let inputs = [
        PlyInput::new(first.clone(), first_move),
        PlyInput::new(second.clone(), second_move),
    ];
    let quick = Limit::new(100);
    let deep = Limit::new(1_000);

    let mut analyzer = FakeAnalyzer::default();
    analyzer.set(first.position(), quick, 3, vec![line("h2e2", 0, None)]);
    analyzer.set(
        first_after.position(),
        quick,
        1,
        vec![line("h9g7", 300, None)],
    );
    analyzer.set(second.position(), quick, 3, vec![line("h9g7", 0, None)]);
    analyzer.set(
        second_after.position(),
        quick,
        1,
        vec![line("h2e2", 0, None)],
    );
    analyzer.set(first.position(), deep, 3, vec![line("h2e2", 200, None)]);
    analyzer.set(
        first_after.position(),
        deep,
        1,
        vec![line("h9g7", 200, None)],
    );

    let mut always_continue = || false;
    let report =
        review_game_two_pass_until(&mut analyzer, &inputs, quick, deep, &mut always_continue)
            .unwrap();
    assert_eq!(
        analyzer
            .calls
            .iter()
            .map(|(_, nodes, _)| *nodes)
            .collect::<Vec<_>>(),
        vec![100, 100, 100, 100, 1_000, 1_000, 20_000, 20_000]
    );
    assert_eq!(report.points.len(), 2);
    assert!(report.points[0].deepened);
    assert!(!report.points[1].deepened);
    assert!(!report.cancelled);

    let mut cancelled_analyzer = FakeAnalyzer::default();
    cancelled_analyzer.set(first.position(), quick, 3, vec![line("h2e2", 0, None)]);
    cancelled_analyzer.set(
        first_after.position(),
        quick,
        1,
        vec![line("h9g7", 300, None)],
    );
    let mut poll_count = 0;
    let mut stop_after_one_point = || {
        poll_count += 1;
        poll_count > 3
    };
    let partial = review_game_two_pass_until(
        &mut cancelled_analyzer,
        &inputs,
        quick,
        deep,
        &mut stop_after_one_point,
    )
    .unwrap();
    assert!(partial.cancelled);
    assert_eq!(partial.points.len(), 1);
}

#[test]
fn incremental_review_emits_all_quick_points_before_deep_points_and_cancel_keeps_progress() {
    let first = starting_game();
    let first_move = Move::from_iccs("h2e2").unwrap();
    let mut second = first.clone();
    second.play(first_move).unwrap();
    let second_move = Move::from_iccs("h9g7").unwrap();
    let mut first_after = first.clone();
    first_after.play(first_move).unwrap();
    let mut second_after = second.clone();
    second_after.play(second_move).unwrap();
    let inputs = vec![
        PlyInput::new(first.clone(), first_move),
        PlyInput::new(second.clone(), second_move),
    ];
    let quick = Limit::new(100);
    let deep = Limit::new(1_000);
    let mut analyzer = FakeAnalyzer::default();
    analyzer.set(first.position(), quick, 3, vec![line("h2e2", 0, None)]);
    analyzer.set(
        first_after.position(),
        quick,
        1,
        vec![line("h9g7", 300, None)],
    );
    analyzer.set(second.position(), quick, 3, vec![line("h9g7", 0, None)]);
    analyzer.set(
        second_after.position(),
        quick,
        1,
        vec![line("h2e2", 0, None)],
    );
    analyzer.set(first.position(), deep, 3, vec![line("h2e2", 200, None)]);
    analyzer.set(
        first_after.position(),
        deep,
        1,
        vec![line("h9g7", 200, None)],
    );

    let mut review = IncrementalReview::new(analyzer, inputs, quick, deep);
    assert!(matches!(
        review.advance().unwrap(),
        Some(ReviewStep::Point {
            pass: ReviewPass::Quick,
            index: 0,
            ..
        })
    ));
    assert!(matches!(
        review.advance().unwrap(),
        Some(ReviewStep::Point {
            pass: ReviewPass::Quick,
            index: 1,
            ..
        })
    ));
    assert!(matches!(
        review.advance().unwrap(),
        Some(ReviewStep::Point {
            pass: ReviewPass::Deep,
            index: 0,
            ..
        })
    ));

    let report = review.cancel();
    assert!(report.cancelled);
    assert_eq!(report.points.len(), 2);
    assert!(report.points[0].deepened);
    assert!(!report.points[1].deepened);
}

/// Counterexample from the frozen level games (level 6, game 14, ply 55): Red is not in check, has
/// 42 legal moves, the game is not over, yet the first search iteration needs more than the
/// 100,000-node review budget, so the builtin analyzer returned no line and the review aborted
/// with NoAnalysisLines.
const NODE_HUNGRY_FEN: &str =
    "2bakab2/9/1c3rn1c/3R4p/pR2p3P/2p6/P1P3P2/6N2/4Knr2/1NBA1AB2 w - - 10 28";

#[test]
fn builtin_analyzer_returns_a_line_for_a_live_position_even_when_the_budget_is_tight() {
    let position = Position::from_fen(NODE_HUNGRY_FEN).unwrap();
    let game = Game::new(position);
    assert_eq!(game.outcome(), None);
    let mut analyzer = BuiltinAnalyzer::new(SearchConfig {
        node_limit: 100_000,
        ..SearchConfig::default()
    });

    let lines = analyzer.analyze_game(&game, Limit::new(100_000), 3);

    assert!(
        !lines.is_empty(),
        "a position with legal moves must produce at least one analysis line"
    );
}

#[test]
fn builtin_review_of_the_node_hungry_position_does_not_abort() {
    let game = Game::new(Position::from_fen(NODE_HUNGRY_FEN).unwrap());
    let played = Move::from_iccs("c0e2").unwrap();
    let mut analyzer = BuiltinAnalyzer::new(SearchConfig {
        node_limit: 100_000,
        ..SearchConfig::default()
    });

    let result = review_one_move(&mut analyzer, &game, played, Limit::new(100_000));

    assert!(result.is_ok(), "{result:?}");
}

#[test]
fn builtin_analyzer_returns_a_line_for_the_node_hungry_position_at_very_small_budgets() {
    let game = Game::new(Position::from_fen(NODE_HUNGRY_FEN).unwrap());
    for budget in [1_000_u64, 10_000] {
        let mut analyzer = BuiltinAnalyzer::new(SearchConfig {
            node_limit: budget,
            ..SearchConfig::default()
        });

        let lines = analyzer.analyze_game(&game, Limit::new(budget), 3);

        assert!(
            !lines.is_empty(),
            "budget {budget}: a live position must produce at least one analysis line"
        );
    }
}

#[test]
fn builtin_analyzer_stops_retrying_when_cancelled() {
    let game = Game::new(Position::from_fen(NODE_HUNGRY_FEN).unwrap());
    let mut analyzer = BuiltinAnalyzer::new(SearchConfig {
        node_limit: 1_000,
        ..SearchConfig::default()
    });
    let mut calls = 0_u32;
    let mut stop = || {
        calls += 1;
        true
    };

    let lines = analyzer.analyze_game_until(&game, Limit::new(1_000), 3, &mut stop);

    assert!(lines.is_empty() || lines.len() <= 3);
    assert!(
        calls < 100_000,
        "cancellation must end the retry loop quickly"
    );
}

/// With a zero configured node budget the retry loop used to compute `0 * 4 == 0` forever, so a
/// `should_stop` that never fires never ended the call. The search runs on a helper thread and
/// is given a wall-clock bound so a regression fails instead of hanging the test run.
#[test]
fn builtin_analyzer_with_zero_node_limit_terminates() {
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let game = Game::new(Position::from_fen(NODE_HUNGRY_FEN).unwrap());
        let mut analyzer = BuiltinAnalyzer::new(SearchConfig {
            node_limit: 0,
            ..SearchConfig::default()
        });
        let lines = analyzer.analyze_game(&game, Limit::new(1_000), 3);
        let _ = sender.send(lines.len());
    });

    let result = receiver.recv_timeout(std::time::Duration::from_secs(60));

    assert!(
        result.is_ok(),
        "a zero node budget must not spin forever in the retry loop"
    );
}

/// Guard test (may be green on first run): the stop callback only starts returning true on the
/// N-th call; the analyzer must then stop retrying promptly instead of walking the whole
/// budget ladder, which is what the weaker assertion in the test above could not detect.
#[test]
fn builtin_analyzer_stops_retrying_soon_after_a_late_cancel() {
    let game = Game::new(Position::from_fen(NODE_HUNGRY_FEN).unwrap());
    let mut analyzer = BuiltinAnalyzer::new(SearchConfig {
        node_limit: 1_000,
        ..SearchConfig::default()
    });
    let stop_from_call = 3_u32;
    let mut calls = 0_u32;
    let mut stop = || {
        calls += 1;
        calls >= stop_from_call
    };

    let _ = analyzer.analyze_game_until(&game, Limit::new(1_000), 3, &mut stop);

    assert!(
        calls >= stop_from_call,
        "the test position must reach the late cancel point (calls {calls})"
    );
    assert!(
        calls <= stop_from_call + 2,
        "after should_stop turns true no further retry rounds may run (calls {calls})"
    );
}
