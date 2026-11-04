use xq_core::{Game, GameOutcome, Move, Position};
use xq_engine::{SearchConfig, Searcher, prove_shortest_mates};

#[test]
fn fixed_node_search_returns_the_same_move_and_score() {
    let position = Position::startpos();
    let config = SearchConfig {
        node_limit: 1_000,
        ..SearchConfig::default()
    };

    let first = Searcher::new(config.clone()).search(&position);
    let second = Searcher::new(config).search(&position);

    assert_eq!(first.best_move, second.best_move);
    assert_eq!(first.score, second.score);
    assert!(first.nodes <= 1_000);
    assert!(first.best_move.is_some());
}

#[test]
fn search_respects_a_draw_already_present_in_game_history() {
    let mut game = Game::new(Position::startpos());
    for _ in 0..2 {
        for movement in ["h0g2", "h9g7", "g2h0", "g7h9"] {
            game.play(Move::from_iccs(movement).unwrap()).unwrap();
        }
    }
    assert_eq!(game.outcome(), Some(GameOutcome::Draw));

    let result = Searcher::new(SearchConfig::default()).search_game(&game);
    assert_eq!(result.best_move, None);
}

#[test]
fn evaluation_reports_a_nonzero_mobility_difference_when_sides_differ() {
    let mut position = Position::startpos();
    position
        .make_move(Move::from_iccs("h0g2").unwrap())
        .unwrap();
    let evaluation = xq_engine::evaluate(&position);
    assert_ne!(evaluation.mobility, 0);
    assert_eq!(
        evaluation.material + evaluation.position + evaluation.mobility + evaluation.king_safety,
        evaluation.total
    );
}

#[test]
fn evaluation_is_symmetric_after_red_black_swap_and_vertical_flip() {
    let mut position = Position::startpos();
    for movement in ["h2e2", "h9g7"] {
        position
            .make_move(Move::from_iccs(movement).unwrap())
            .unwrap();
    }
    let transformed = swap_sides_and_flip(&position);
    assert_eq!(
        xq_engine::evaluate(&position).total,
        xq_engine::evaluate(&transformed).total
    );
}

#[test]
fn evaluation_is_symmetric_after_left_right_mirror() {
    let mut left = Position::startpos();
    for movement in ["h2e2", "h9g7"] {
        left.make_move(Move::from_iccs(movement).unwrap()).unwrap();
    }
    let mut right = Position::startpos();
    for movement in ["b2e2", "b9c7"] {
        right.make_move(Move::from_iccs(movement).unwrap()).unwrap();
    }
    assert_eq!(
        xq_engine::evaluate(&left).total,
        xq_engine::evaluate(&right).total
    );
}

#[test]
fn transposition_table_toggle_preserves_the_fixed_depth_score() {
    let position = Position::startpos();
    let without = SearchConfig {
        node_limit: 2_000,
        max_depth: 2,
        ..SearchConfig::default()
    };
    let with = SearchConfig {
        use_transposition_table: true,
        ..without.clone()
    };
    let result_without = Searcher::new(without).search(&position);
    let result_with = Searcher::new(with).search(&position);
    assert_eq!(result_with.score, result_without.score);
}

#[test]
fn caller_stop_callback_interrupts_search_and_keeps_a_legal_fallback() {
    let mut calls = 0;
    let result = Searcher::new(SearchConfig {
        node_limit: 1_000_000,
        ..SearchConfig::default()
    })
    .search_game_until(&Game::new(Position::startpos()), || {
        calls += 1;
        calls >= 4
    });
    assert!(result.best_move.is_some());
    assert!(result.nodes < 1_000_000);
}

#[test]
fn multipv_returns_distinct_ranked_lines_with_the_same_top_move() {
    let position = Position::startpos();
    let config = SearchConfig {
        node_limit: 5_000,
        max_depth: 1,
        ..SearchConfig::default()
    };
    let searcher = Searcher::new(config);
    let best = searcher.search(&position).best_move.unwrap();
    let lines = searcher.search_multipv(&Game::new(position), 3);
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0].best_move, best);
    assert!(lines.windows(2).all(|pair| pair[0].score >= pair[1].score));
    assert_ne!(lines[0].best_move, lines[1].best_move);
    assert_ne!(lines[1].best_move, lines[2].best_move);
}

#[test]
fn search_avoids_a_pawn_capture_that_loses_the_rook_to_a_recapture() {
    let position = Position::from_fen("4k4/4r4/9/4p4/9/9/9/9/4R4/3K5 w - - 0 1").unwrap();
    let result = Searcher::new(SearchConfig {
        node_limit: 10_000,
        max_depth: 1,
        ..SearchConfig::default()
    })
    .search(&position);
    assert_ne!(result.best_move, Some(Move::from_iccs("e1e6").unwrap()));
}

#[test]
fn capture_ordering_keeps_fixed_depth_score_stable_and_reports_a_legal_move() {
    let position = Position::from_fen("4k4/4r4/9/4p4/9/9/9/9/4R4/3K5 w - - 0 1").unwrap();
    let plain = SearchConfig {
        node_limit: 10_000,
        max_depth: 2,
        use_move_ordering: false,
        ..SearchConfig::default()
    };
    let ordered = SearchConfig {
        use_move_ordering: true,
        ..plain.clone()
    };
    let a = Searcher::new(plain).search(&position);
    let b = Searcher::new(ordered).search(&position);
    assert_eq!(a.score, b.score);
    assert!(position.clone().make_move(b.best_move.unwrap()).is_ok());
}

#[test]
fn search_while_in_check_returns_a_legal_evasion() {
    let position = Position::from_fen("4k4/9/9/9/9/4r4/9/9/9/4K4 w - - 0 1").unwrap();
    assert!(position.is_in_check(xq_core::Side::Red));
    let mut legal_position = position.clone();
    let legal = legal_position.legal_moves();
    let mut legal_tokens: Vec<_> = legal.iter().map(|movement| movement.to_iccs()).collect();
    legal_tokens.sort();
    assert_eq!(legal_tokens, ["e0d0", "e0f0"]);

    let result = Searcher::new(SearchConfig {
        node_limit: 100_000,
        max_depth: 2,
        ..SearchConfig::default()
    })
    .search(&position);
    assert!(legal.contains(&result.best_move.expect("checked position has an evasion")));
}

#[test]
fn unique_legal_evasion_returns_immediately_without_search_nodes() {
    let position = Position::from_fen("4k4/9/9/9/9/4r4/9/2n6/9/4K4 w - - 0 1").unwrap();
    assert!(position.is_in_check(xq_core::Side::Red));
    let mut legal_position = position.clone();
    let legal = legal_position.legal_moves();
    assert_eq!(legal.len(), 1);
    assert_eq!(legal[0].to_iccs(), "e0f0");

    let result = Searcher::new(SearchConfig::default()).search(&position);
    assert_eq!(result.best_move, Some(legal[0]));
    assert_eq!(result.nodes, 0);
    assert_eq!(result.depth, 0);
}

#[test]
fn search_reports_the_number_of_attacker_moves_to_mate() {
    let position = Position::from_fen("1n3k3/9/3N5/9/9/9/R8/7N1/3K5/7C1 w - - 0 1").unwrap();
    let mut game = Game::new(position.clone());
    game.play(Move::from_iccs("a3f3").unwrap()).unwrap();
    assert_eq!(game.outcome(), Some(GameOutcome::Win(xq_core::Side::Red)));

    let result = Searcher::new(SearchConfig {
        node_limit: 10_000,
        max_depth: 1,
        ..SearchConfig::default()
    })
    .search(&position);
    assert_eq!(result.mate_in, Some(1));
}

#[test]
fn transposition_table_toggle_preserves_mate_score_and_distance() {
    let position = Position::from_fen("1n3k3/9/3N5/9/9/9/R8/7N1/3K5/7C1 w - - 0 1").unwrap();
    let plain = SearchConfig {
        node_limit: 10_000,
        max_depth: 1,
        use_transposition_table: false,
        ..SearchConfig::default()
    };
    let cached = SearchConfig {
        use_transposition_table: true,
        ..plain.clone()
    };
    let a = Searcher::new(plain).search(&position);
    let b = Searcher::new(cached).search(&position);
    assert_eq!((a.score, a.mate_in), (b.score, b.mate_in));
    assert_eq!(b.mate_in, Some(1));
}

#[test]
fn transposition_table_toggle_preserves_positive_and_negative_mate_results() {
    let cases = [
        ("1n3k3/9/3N5/9/9/9/R8/7N1/3K5/7C1 w - - 0 1", 1, 1),
        ("5k3/9/9/9/R4n3/6N2/9/9/9/3RK4 b - - 0 1", -1, 2),
    ];
    for (fen, expected_sign, distance) in cases {
        let position = Position::from_fen(fen).unwrap();
        let mut results = Vec::new();
        for use_transposition_table in [false, true] {
            let result = Searcher::new(SearchConfig {
                node_limit: 1_000_000,
                max_depth: 4,
                use_transposition_table,
                ..SearchConfig::default()
            })
            .search(&position);
            assert_eq!(result.depth, 4);
            assert_eq!(result.score.signum(), expected_sign);
            assert_eq!(result.mate_in, Some(distance));
            assert!(
                position
                    .clone()
                    .make_move(result.best_move.unwrap())
                    .is_ok()
            );
            results.push((result.score, result.mate_in));
        }
        assert_eq!(results[0], results[1]);
    }
}

#[test]
fn interrupted_first_iteration_does_not_report_a_completed_depth_or_mate() {
    let position = Position::startpos();
    let mut move_probe = position.clone();
    let legal_moves = move_probe.legal_moves();
    let result = Searcher::new(SearchConfig {
        node_limit: 1,
        max_depth: 8,
        ..SearchConfig::default()
    })
    .search(&position);

    assert!(legal_moves.contains(&result.best_move.unwrap()));
    assert_eq!(result.depth, 0);
    assert_eq!(result.mate_in, None);
}

#[test]
fn exhaustive_mate_proof_checks_every_legal_root_move() {
    let position = Position::from_fen("1n3k3/9/3N5/9/9/9/R8/7N1/3K5/7C1 w - - 0 1").unwrap();
    let game = Game::new(position.clone());
    let mut probe = position.clone();
    let root_moves = probe.legal_moves().len();

    let proof = prove_shortest_mates(&game, 1, 100_000);

    assert!(proof.complete);
    assert_eq!(proof.root_branches_checked, root_moves);
    assert!(proof.forced_mates.iter().any(|mate| {
        mate.first_move == Move::from_iccs("a3f3").unwrap() && mate.in_attack_moves == 1
    }));
    assert_eq!(proof.forced_mates.len(), 2);
    assert_eq!(proof.unique_for_target(1), None);
}

#[test]
fn capped_mate_proof_never_claims_uniqueness() {
    let position = Position::from_fen("1n3k3/9/3N5/9/9/9/R8/7N1/3K5/7C1 w - - 0 1").unwrap();
    let game = Game::new(position);
    let proof = prove_shortest_mates(&game, 1, 1);

    assert!(!proof.complete);
    assert_eq!(proof.unique_for_target(1), None);
}

#[test]
fn mate_proof_accepts_an_already_terminal_game_with_repetition_history() {
    let mut game = Game::new(Position::startpos());
    let cycle = ["h0g2", "h9g7", "g2h0", "g7h9"];
    for _ in 0..2 {
        for text in cycle {
            game.play(Move::from_iccs(text).unwrap()).unwrap();
        }
    }
    assert_eq!(game.outcome(), Some(GameOutcome::Draw));

    let proof = prove_shortest_mates(&game, 1, 100_000);

    assert!(proof.complete);
    assert!(proof.forced_mates.is_empty());
    assert_eq!(proof.root_branches_checked, 0);
}

#[test]
fn mate_proof_accepts_terminal_clock_and_no_move_games() {
    let clock_draw = Game::new(
        Position::from_fen(
            "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 120 1",
        )
        .unwrap(),
    );
    assert_eq!(clock_draw.outcome(), Some(GameOutcome::Draw));
    let clock_proof = prove_shortest_mates(&clock_draw, 1, 100_000);
    assert!(clock_proof.complete);
    assert!(clock_proof.forced_mates.is_empty());

    let source = Position::from_fen("1n3k3/9/3N5/9/9/9/R8/7N1/3K5/7C1 w - - 0 1").unwrap();
    for (move_text, black_in_check) in [("a3f3", true), ("a3a9", false)] {
        let mut game = Game::new(source.clone());
        game.play(Move::from_iccs(move_text).unwrap()).unwrap();
        assert_eq!(game.outcome(), Some(GameOutcome::Win(xq_core::Side::Red)));
        assert_eq!(
            game.position().is_in_check(xq_core::Side::Black),
            black_in_check
        );
        let proof = prove_shortest_mates(&game, 1, 100_000);
        assert!(proof.complete);
        assert!(proof.forced_mates.is_empty());
    }
}

fn swap_sides_and_flip(position: &Position) -> Position {
    let fields: Vec<_> = position
        .to_fen()
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    let mut ranks: Vec<_> = fields[0].split('/').collect();
    ranks.reverse();
    let placement = ranks
        .into_iter()
        .map(|rank| {
            rank.chars()
                .map(|symbol| {
                    if symbol.is_ascii_uppercase() {
                        symbol.to_ascii_lowercase()
                    } else if symbol.is_ascii_lowercase() {
                        symbol.to_ascii_uppercase()
                    } else {
                        symbol
                    }
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/");
    let side = if fields[1] == "w" { "b" } else { "w" };
    Position::from_fen(&format!("{placement} {side} {}", fields[2..].join(" "))).unwrap()
}
