//! Native producer of the review data cached by `web/scripts/make-samples.ts`
//! (`docs/samples/data/*.json`).
//!
//! It drives the same `ReviewWorkerSession` the web worker uses (same Rust code, same
//! `BuiltinAnalyzer` configuration, node budgets instead of clocks), so the numbers equal what
//! the wasm build produces in node, only much faster. Output format is exactly what the script
//! reads: `{ gameLevel, opening, moves, finals: [{ classification, lossPercent, bestMove, reason }] }`.
//!
//! Usage (heavy: run it under the shared lock and a memory cap, see AGENTS/CLAUDE rules):
//!   cargo run -q --release -j4 -p xq-wasm --example make_samples_data -- <out_dir> [plies]
//! Writes sample-beginner.json (level 4), sample-intermediate.json (6), sample-proficient.json (8),
//! one thread per sample.

use std::path::PathBuf;
use std::thread;

use serde_json::{Value, json};
use xq_wasm::ReviewWorkerSession;

const START: &str = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";
const QUICK_NODES: u32 = 100_000;
const SAMPLES: [(&str, u32); 3] = [
    ("sample-beginner", 4),
    ("sample-intermediate", 6),
    ("sample-proficient", 8),
];

fn produce(level: u32, plies: usize) -> Value {
    let tsv = include_str!("../../xq-review/tests/fixtures/level-games/games.tsv");
    let row: Vec<&str> = tsv
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| line.split('\t').collect::<Vec<_>>())
        .find(|cols| cols.get(1) == Some(&level.to_string().as_str()) && cols.get(2) == Some(&"0"))
        .expect("frozen game");
    let moves: Vec<&str> = row[7].split(' ').take(plies).collect();
    let mut session =
        ReviewWorkerSession::new(START, &moves.join(" "), QUICK_NODES).expect("review session");
    let mut finals: Vec<Value> = vec![Value::Null; moves.len()];
    loop {
        let event: Value = serde_json::from_str(&session.step().expect("step")).expect("json");
        if event["done"].as_bool() == Some(true) {
            break;
        }
        let index = event["index"].as_u64().expect("index") as usize;
        let f = &event["point"]["final"];
        finals[index] = json!({
            "classification": f["classification"],
            "lossPercent": f["lossPercent"],
            "bestMove": f["bestMove"],
            "reason": f["reason"],
        });
    }
    json!({ "gameLevel": level, "opening": row[3], "moves": moves, "finals": finals })
}

fn main() {
    let mut args = std::env::args().skip(1);
    let out_dir = PathBuf::from(args.next().expect("output directory"));
    let plies: usize = args.next().map_or(60, |text| text.parse().expect("plies"));
    std::fs::create_dir_all(&out_dir).expect("create output directory");
    let handles: Vec<_> = SAMPLES
        .iter()
        .map(|&(name, level)| {
            let path = out_dir.join(format!("{name}.json"));
            thread::spawn(move || {
                let started = std::time::Instant::now();
                let data = produce(level, plies);
                std::fs::write(&path, serde_json::to_string_pretty(&data).unwrap()).unwrap();
                eprintln!("{name}: {:.1}s", started.elapsed().as_secs_f64());
            })
        })
        .collect();
    for handle in handles {
        handle.join().expect("sample thread");
    }
}
