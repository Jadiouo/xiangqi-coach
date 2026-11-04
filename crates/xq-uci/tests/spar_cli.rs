#![cfg(unix)]
//! `xq-uci spar`: the built-in engine against an external UCI engine (TEST_PLAN 5.4).
//! The "external engine" here is a wrapper that runs this crate's own UCI mode, so the tests need
//! no Pikafish. Pikafish itself is only used for the recorded run in docs/STRENGTH.md.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);

fn temp_dir(label: &str) -> std::path::PathBuf {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("xq-spar-{label}-{}-{id}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_executable(path: &std::path::Path, body: &str) {
    fs::write(path, body).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn self_engine(dir: &std::path::Path) -> std::path::PathBuf {
    let path = dir.join("self-engine.sh");
    write_executable(
        &path,
        &format!("#!/bin/sh\nexec '{}'\n", env!("CARGO_BIN_EXE_xq-uci")),
    );
    path
}

fn spar(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_xq-uci"))
        .arg("spar")
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn spar_plays_each_opening_with_both_colors_and_summarizes() {
    let dir = temp_dir("basic");
    let engine = self_engine(&dir);
    let openings = dir.join("openings.txt");
    fs::write(&openings, "# comment\nh2e2 h9g7\nc3c4 c6c5\n").unwrap();
    let run = || {
        spar(&[
            "--engine",
            engine.to_str().unwrap(),
            "--openings",
            openings.to_str().unwrap(),
            "--nodes",
            "60",
            "--engine-nodes",
            "3000",
            "--max-plies",
            "20",
        ])
    };
    let output = run();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["schema_version"], 1);
    assert_eq!(report["engine"], "xiangqi-coach");
    assert_eq!(report["builtin_nodes"], 60);
    assert_eq!(report["engine_nodes"], 3000);
    let games = report["games"].as_array().unwrap();
    assert_eq!(games.len(), 4, "2 openings x 2 colors");
    let sides: Vec<_> = games
        .iter()
        .map(|g| {
            (
                g["opening"].as_u64().unwrap(),
                g["builtin_side"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(sides, [(0, "red"), (0, "black"), (1, "red"), (1, "black")]);
    for game in games {
        let moves = game["moves"].as_array().unwrap();
        assert!(moves.len() <= 20);
        assert_eq!(game["plies"].as_u64().unwrap() as usize, moves.len());
        assert!(
            ["builtin_win", "engine_win", "draw", "unfinished"]
                .contains(&game["result"].as_str().unwrap())
        );
    }
    let first_opening: Vec<_> = games[0]["moves"].as_array().unwrap()[..2]
        .iter()
        .map(|m| m.as_str().unwrap())
        .collect();
    assert_eq!(
        first_opening,
        ["h2e2", "h9g7"],
        "the opening is played first"
    );
    let count = |name: &str| games.iter().filter(|g| g["result"] == name).count() as u64;
    let summary = &report["summary"];
    assert_eq!(summary["games"], 4);
    assert_eq!(summary["builtin_wins"], count("builtin_win"));
    assert_eq!(summary["engine_wins"], count("engine_win"));
    assert_eq!(summary["draws"], count("draw"));
    assert_eq!(summary["unfinished"], count("unfinished"));
    // Same inputs, same engines: the whole report is reproducible.
    let again: serde_json::Value = serde_json::from_slice(&run().stdout).unwrap();
    assert_eq!(report["games"], again["games"]);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn spar_without_openings_plays_one_game_per_color_from_the_start() {
    let dir = temp_dir("noopen");
    let engine = self_engine(&dir);
    let output = spar(&[
        "--engine",
        engine.to_str().unwrap(),
        "--nodes",
        "30",
        "--engine-nodes",
        "3000",
        "--max-plies",
        "10",
    ]);
    assert!(output.status.success());
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let games = report["games"].as_array().unwrap();
    assert_eq!(games.len(), 2);
    assert!(
        games
            .iter()
            .all(|g| g["result"] == "unfinished" && g["plies"] == 10)
    );
    assert_eq!(report["summary"]["unfinished"], 2);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn spar_reports_a_missing_engine_and_a_bad_opening_as_structured_errors() {
    let dir = temp_dir("errors");
    let output = spar(&["--engine", dir.join("missing").to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(1));
    let error: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"]["code"], "engine_start_failed");

    let engine = self_engine(&dir);
    let openings = dir.join("bad.txt");
    fs::write(&openings, "h2e2 a0a0\n").unwrap();
    let output = spar(&[
        "--engine",
        engine.to_str().unwrap(),
        "--openings",
        openings.to_str().unwrap(),
    ]);
    assert_eq!(output.status.code(), Some(1));
    let error: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"]["code"], "openings_invalid");
    assert!(error["error"]["cause"].as_str().unwrap().contains("a0a0"));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn spar_fails_closed_when_the_engine_answers_with_an_illegal_move() {
    let dir = temp_dir("illegal");
    let engine = dir.join("liar.sh");
    write_executable(
        &engine,
        r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    uci) printf 'id name Liar\noption name MultiPV type spin default 1 min 1 max 8\nuciok\n' ;;
    isready) printf 'readyok\n' ;;
    'go nodes '*) printf 'info depth 1 multipv 1 score cp 0 pv a0a1\nbestmove a0a1\n' ;;
    quit) exit 0 ;;
  esac
done
"#,
    );
    let output = spar(&[
        "--engine",
        engine.to_str().unwrap(),
        "--nodes",
        "30",
        "--max-plies",
        "6",
    ]);
    assert_eq!(output.status.code(), Some(1));
    let error: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"]["code"], "engine_analysis_failed");
    assert!(output.stdout.is_empty(), "no partial report on failure");
    fs::remove_dir_all(dir).unwrap();
}
