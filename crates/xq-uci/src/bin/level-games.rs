//! Self-play game generator for the TEST_PLAN 6.4 level-estimator validation.
//!
//! One invocation plays one game at one difficulty level on both sides from a fixed opening
//! prefix, then reviews the plies of one chosen "user" side with the built-in analyzer
//! (quick pass only). It is deterministic: the move RNG is seeded from (level, index), there
//! is no clock and no entropy. Output (stdout, tab separated):
//!   G level index opening_id user_side result plies moves...
//!   P level index ply move loss_percent classification reason
//!   S level index ply move error      (a user ply the analyzer could not review)
//! `ply` is the 1-based ply number; only engine-played plies of the user side are reviewed.

use xq_core::{Game, GameOutcome, Move, Position, Side};
use xq_engine::SearchConfig;
use xq_engine::difficulty::{DifficultyRequest, choose_move};
use xq_review::{BuiltinAnalyzer, Limit, review_one_move};

const PLY_CAP: usize = 400;

fn arg(args: &[String], name: &str) -> String {
    let at = args
        .iter()
        .position(|value| value == name)
        .unwrap_or_else(|| panic!("missing {name}"));
    args.get(at + 1)
        .unwrap_or_else(|| panic!("missing value for {name}"))
        .clone()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let level: u8 = arg(&args, "--level").parse().unwrap();
    let index: u64 = arg(&args, "--index").parse().unwrap();
    let opening_id = arg(&args, "--opening-id");
    let opening = arg(&args, "--opening");
    let user = match arg(&args, "--user").as_str() {
        "red" => Side::Red,
        "black" => Side::Black,
        other => panic!("bad --user {other}"),
    };
    let play_nodes: u64 = arg(&args, "--play-nodes").parse().unwrap();
    let review_nodes: u64 = arg(&args, "--review-nodes").parse().unwrap();

    let mut game = Game::new(Position::startpos());
    let mut moves: Vec<Move> = Vec::new();
    for token in opening.split_whitespace() {
        let movement = Move::from_iccs(token).expect("opening move parses");
        game.play(movement).expect("opening move is legal");
        moves.push(movement);
    }
    let mut rng_state = 0x9E37_79B9_7F4A_7C15_u64 ^ ((u64::from(level) << 32) | index);
    let mut reviewed: Vec<(usize, Move, xq_review::PlyAnalysis)> = Vec::new();
    let mut skipped: Vec<(usize, Move, String)> = Vec::new();
    let mut analyzer = BuiltinAnalyzer::new(SearchConfig {
        node_limit: review_nodes,
        ..SearchConfig::default()
    });
    while game.outcome().is_none() && moves.len() < PLY_CAP {
        let decision = choose_move(
            &game,
            DifficultyRequest {
                level,
                rng_state,
                search_config: SearchConfig {
                    node_limit: play_nodes,
                    ..SearchConfig::default()
                },
                node_limit: play_nodes,
            },
            || false,
        )
        .expect("valid level");
        let Some(movement) = decision.selected_move else {
            break;
        };
        rng_state = decision.rng_state;
        let mover = game.position().side_to_move();
        if mover == user {
            match review_one_move(&mut analyzer, &game, movement, Limit::new(review_nodes)) {
                Ok(result) => reviewed.push((moves.len() + 1, movement, result)),
                // The analyzer found no completed search line for this position; the ply is
                // reported as skipped instead of aborting the whole game.
                Err(error) => skipped.push((moves.len() + 1, movement, format!("{error:?}"))),
            }
        }
        game.play(movement).expect("engine move is legal");
        moves.push(movement);
    }
    let result = match game.outcome() {
        Some(GameOutcome::Win(Side::Red)) => "red",
        Some(GameOutcome::Win(Side::Black)) => "black",
        Some(GameOutcome::Draw) => "draw",
        None => "cap",
    };
    let side = if user == Side::Red { "red" } else { "black" };
    println!(
        "G\t{level}\t{index}\t{opening_id}\t{side}\t{result}\t{}\t{}",
        moves.len(),
        moves
            .iter()
            .map(|movement| movement.to_iccs())
            .collect::<Vec<_>>()
            .join(" ")
    );
    for (ply, movement, error) in skipped {
        println!(
            "S\t{level}\t{index}\t{ply}\t{}\t{error}",
            movement.to_iccs()
        );
    }
    for (ply, movement, analysis) in reviewed {
        println!(
            "P\t{level}\t{index}\t{ply}\t{}\t{:.4}\t{:?}\t{}",
            movement.to_iccs(),
            analysis.loss_percent,
            analysis.classification,
            analysis
                .reason
                .as_ref()
                .map_or("none".to_owned(), |reason| format!("{:?}", reason.kind))
        );
    }
}
