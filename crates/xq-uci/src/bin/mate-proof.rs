use std::process::ExitCode;
use xq_core::{Game, Position};
use xq_engine::prove_shortest_mates;

fn main() -> ExitCode {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 3 {
        eprintln!("usage: mate-proof '<FEN>' <max-attacker-moves> <node-limit>");
        return ExitCode::from(2);
    }
    let max_depth = match args[1].parse::<u8>() {
        Ok(value) => value,
        Err(error) => {
            eprintln!("invalid max-attacker-moves: {error}");
            return ExitCode::from(2);
        }
    };
    let node_limit = match args[2].parse::<u64>() {
        Ok(value) => value,
        Err(error) => {
            eprintln!("invalid node-limit: {error}");
            return ExitCode::from(2);
        }
    };
    let position = match Position::from_fen(&args[0]) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("invalid FEN: {error}");
            return ExitCode::from(2);
        }
    };
    let proof = prove_shortest_mates(&Game::new(position), max_depth, node_limit);
    println!("complete\t{}", proof.complete);
    println!("nodes\t{}", proof.nodes);
    println!("root_branches_checked\t{}", proof.root_branches_checked);
    for mate in &proof.forced_mates {
        println!(
            "mate\t{}\t{}",
            mate.first_move.to_iccs(),
            mate.in_attack_moves
        );
    }
    let unique = proof
        .unique_for_target(max_depth)
        .map_or_else(|| "-".to_owned(), |m| m.to_iccs());
    println!("unique\t{unique}");
    if proof.complete {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(3)
    }
}
