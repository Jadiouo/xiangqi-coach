use std::env;
use std::fs;
use std::path::PathBuf;

use xq_core::{Game, GameOutcome, format_iccs_move, import_record};

fn main() {
    let args: Vec<_> = env::args().collect();
    if args.len() != 3 || args[1] != "--input-dir" {
        eprintln!("usage: ccpd-mate-candidates --input-dir UTF8_PGN_DIRECTORY");
        std::process::exit(2);
    }
    let root = PathBuf::from(&args[2]);
    let mut paths: Vec<_> = match fs::read_dir(&root) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "pgn"))
            .collect(),
        Err(error) => {
            eprintln!("cannot read input directory: {error}");
            std::process::exit(2);
        }
    };
    paths.sort();

    println!("audit\tfile\tstatus\tgame_plies\tmate1_count\tmate2_count\tmate3_count");
    println!("candidate\tfile\ttarget\tgame_ply\tfirst_move\tfen");
    for path in paths {
        analyze_file(&path);
    }
}

fn analyze_file(path: &PathBuf) {
    let filename = path.file_name().unwrap_or_default().to_string_lossy();
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => {
            println!(
                "audit\t{filename}\tread-error:{}\t0\t0\t0\t0",
                clean(&error.to_string())
            );
            return;
        }
    };
    let record = import_record(&text);
    if let Some(error) = record.error {
        println!(
            "audit\t{filename}\tparse-error:{}:{}\t{}\t0\t0\t0",
            error.step,
            clean(&format!("{:?}", error.kind)),
            record.moves.len()
        );
        return;
    }
    if record.moves.is_empty() {
        println!("audit\t{filename}\tempty-record\t0\t0\t0\t0");
        return;
    }

    let mut game = Game::new(record.initial_position.clone());
    for (index, movement) in record.moves.iter().enumerate() {
        if game.play(*movement).is_err() {
            println!(
                "audit\t{filename}\treplay-error-at-{}\t{}\t0\t0\t0",
                index + 1,
                record.moves.len()
            );
            return;
        }
    }
    let winner = match game.outcome() {
        Some(GameOutcome::Win(side))
            if game.position().is_in_check(game.position().side_to_move()) =>
        {
            side
        }
        Some(GameOutcome::Win(_)) => {
            println!(
                "audit\t{filename}\tterminal-without-check\t{}\t0\t0\t0",
                record.moves.len()
            );
            return;
        }
        Some(GameOutcome::Draw) => {
            println!("audit\t{filename}\tdraw\t{}\t0\t0\t0", record.moves.len());
            return;
        }
        None => {
            println!(
                "audit\t{filename}\tnot-terminal\t{}\t0\t0\t0",
                record.moves.len()
            );
            return;
        }
    };

    let mut counts = [0; 3];
    for target in 1..=3 {
        let span = 2 * target - 1;
        if record.moves.len() < span {
            continue;
        }
        let cut = record.moves.len() - span;
        let mut candidate = Game::new(record.initial_position.clone());
        let mut valid_prefix = true;
        for movement in &record.moves[..cut] {
            if candidate.play(*movement).is_err() {
                valid_prefix = false;
                break;
            }
        }
        if !valid_prefix || candidate.position().side_to_move() != winner {
            continue;
        }
        let Some(first_move) = format_iccs_move(candidate.position(), record.moves[cut]).ok()
        else {
            continue;
        };
        println!(
            "candidate\t{filename}\t{target}\t{}\t{first_move}\t{}",
            cut + 1,
            candidate.position().to_fen()
        );
        counts[target - 1] += 1;
    }
    println!(
        "audit\t{filename}\tcheckmate\t{}\t{}\t{}\t{}",
        record.moves.len(),
        counts[0],
        counts[1],
        counts[2]
    );
}

fn clean(text: &str) -> String {
    text.chars()
        .map(|character| {
            if matches!(character, '\t' | '\n' | '\r') {
                ' '
            } else {
                character
            }
        })
        .collect()
}
