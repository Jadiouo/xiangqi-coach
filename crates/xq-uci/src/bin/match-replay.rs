use std::io::{self, BufRead};
use xq_core::{Game, GameOutcome, Move, Position, Side};

fn main() {
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else {
            std::process::exit(2)
        };
        let Some((game_id, moves)) = line.split_once('\t') else {
            eprintln!("expected game_id<TAB>moves");
            std::process::exit(2)
        };
        let mut game = Game::new(Position::startpos());
        let mut failed = false;
        for token in moves.split_whitespace() {
            match Move::from_iccs(token).and_then(|movement| game.play(movement)) {
                Ok(()) => {}
                Err(error) => {
                    eprintln!("{game_id}: illegal {token}: {error}");
                    failed = true;
                    break;
                }
            }
        }
        if failed {
            std::process::exit(1);
        }
        let outcome = match game.outcome() {
            Some(GameOutcome::Win(Side::Red)) => "red",
            Some(GameOutcome::Win(Side::Black)) => "black",
            Some(GameOutcome::Draw) => "draw",
            None => {
                eprintln!("{game_id}: sequence is not terminal");
                std::process::exit(1);
            }
        };
        println!("{game_id}\t{outcome}\t{}", game.history_len());
    }
}
