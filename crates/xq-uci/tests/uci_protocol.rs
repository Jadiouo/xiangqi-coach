use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use xq_core::{Game, Position};
use xq_engine::SearchConfig;
use xq_engine::difficulty::{DifficultyRequest, choose_move};

fn run(commands: &str) -> String {
    let mut child = Command::new(env!("CARGO_BIN_EXE_xq-uci"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("start xq-uci");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(commands.as_bytes())
        .unwrap();
    let output = child.wait_with_output().expect("read xq-uci output");
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap()
}

fn run_until_bestmove(commands: &str) -> String {
    let mut child = Command::new(env!("CARGO_BIN_EXE_xq-uci"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("start xq-uci");
    let mut input = child.stdin.take().expect("child stdin");
    input
        .write_all(commands.as_bytes())
        .expect("send UCI commands");
    input.flush().expect("flush UCI commands");
    let stdout = child.stdout.take().expect("child stdout");
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut output = String::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(remaining) {
            Ok(line) => {
                let finished = line.starts_with("bestmove ");
                output.push_str(&line);
                output.push('\n');
                if finished {
                    break;
                }
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("timed out waiting for UCI bestmove: {error}; output={output}");
            }
        }
    }
    input.write_all(b"quit\n").expect("stop UCI process");
    drop(input);
    assert!(child.wait().expect("wait for xq-uci").success());
    output
}

#[test]
fn uci_handshake_names_engine_and_returns_uciok() {
    let output = run("uci\nquit\n");
    assert!(output.contains("id name xiangqi-coach"));
    assert!(output.contains("option name UCI_Variant type combo default xiangqi var xiangqi"));
    assert!(output.contains("uciok"));
}

#[test]
fn difficulty_strategy_and_level_options_are_advertised() {
    let output = run("uci\nquit\n");
    assert!(output.contains("option name Strategy type combo default search var search var random var greedy var difficulty"));
    assert!(output.contains("option name DifficultyLevel type spin default 10 min 1 max 10"));
}

#[test]
fn difficulty_reports_clean_multipv_and_identifies_its_selected_bestmove() {
    let output = run_until_bestmove(
        "uci\nsetoption name Strategy value difficulty\nsetoption name DifficultyLevel value 9\nsetoption name MultiPV value 2\nsetoption name RandomSeed value 48271\nposition startpos moves h2e2 h9g7\ngo depth 1 nodes 100000\n",
    );
    let selection = output
        .lines()
        .find_map(|line| line.strip_prefix("info string difficulty-selected "))
        .expect("difficulty mode identifies the selected move");
    assert!(selection.ends_with(" level 9"));
    let selected = selection.split_whitespace().next().unwrap();
    let bestmove = output
        .lines()
        .find_map(|line| line.strip_prefix("bestmove "))
        .expect("difficulty mode returns bestmove");
    assert_eq!(bestmove, selected);
    let info: Vec<_> = output
        .lines()
        .filter(|line| line.starts_with("info multipv "))
        .collect();
    let baseline = run_until_bestmove(
        "uci\nsetoption name MultiPV value 3\nposition startpos moves h2e2 h9g7\ngo depth 1 nodes 16384\n",
    );
    let baseline_info: Vec<_> = baseline
        .lines()
        .filter(|line| line.starts_with("info multipv "))
        .take(2)
        .collect();
    assert!(
        !info.is_empty(),
        "completed clean analysis is reported: {output}"
    );
    assert_eq!(info, baseline_info, "analysis scores stay unmodified");
    assert!(info.iter().all(|line| line.contains(" pv ")));
    let reported_nodes = info[0]
        .split_whitespace()
        .collect::<Vec<_>>()
        .windows(2)
        .find(|pair| pair[0] == "nodes")
        .and_then(|pair| pair[1].parse::<u64>().ok())
        .expect("MultiPV reports completed analysis nodes");
    assert!(
        reported_nodes <= 16_384,
        "profile cap applies to total search"
    );
    let pv_move = info[0].split_whitespace().last().unwrap();
    assert_ne!(
        selected, pv_move,
        "the selected weak move is separately identified when it differs from clean PV"
    );
}

#[test]
fn difficulty_level_ten_matches_the_current_default_single_pv_search() {
    let difficulty = run_until_bestmove(
        "uci\nsetoption name Strategy value difficulty\nsetoption name DifficultyLevel value 10\nsetoption name MultiPV value 3\nsetoption name RandomSeed value 48271\nposition startpos moves h2e2 h9g7\ngo depth 2 nodes 10000\n",
    );
    let baseline = run_until_bestmove(
        "uci\nsetoption name MultiPV value 1\nposition startpos moves h2e2 h9g7\ngo depth 2 nodes 10000\n",
    );
    let search_output = |output: &str| {
        output
            .lines()
            .filter(|line| line.starts_with("info depth ") || line.starts_with("bestmove "))
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    assert_eq!(search_output(&difficulty), search_output(&baseline));
    assert!(difficulty.contains("info string difficulty-selected "));
}

#[test]
fn difficulty_rejects_invalid_levels_without_changing_the_previous_level() {
    let output = run(
        "uci\nsetoption name Strategy value difficulty\nsetoption name DifficultyLevel value 9\nsetoption name DifficultyLevel value 0\nsetoption name DifficultyLevel value 11\nposition startpos\ngo nodes 0\nquit\n",
    );
    assert!(output.contains("info string invalid DifficultyLevel value 0"));
    assert!(output.contains("info string invalid DifficultyLevel value 11"));
    assert!(output.contains("difficulty-selected "));
    assert!(output.contains(" level 9"));
    assert!(
        !output.contains("info depth "),
        "zero-node fallback invents no score"
    );
}

#[test]
fn difficulty_seed_repeats_and_is_committed_before_a_new_game_or_seed_change() {
    let commands = "uci\nsetoption name Strategy value difficulty\nsetoption name DifficultyLevel value 1\nsetoption name RandomSeed value 48271\nposition startpos\ngo nodes 0\nucinewgame\nposition startpos\ngo nodes 0\nquit\n";
    let first = run(commands);
    let second = run(commands);
    let moves = |output: &str| {
        output
            .lines()
            .filter_map(|line| line.strip_prefix("bestmove "))
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    assert_eq!(moves(&first).len(), 2, "both searches finish before reset");
    assert_eq!(moves(&first), moves(&second));
    assert_eq!(first.matches("difficulty-selected ").count(), 2);

    let game = Game::new(Position::startpos());
    let config = SearchConfig {
        node_limit: 0,
        ..SearchConfig::default()
    };
    let first_expected = choose_move(
        &game,
        DifficultyRequest {
            level: 1,
            rng_state: 48_271,
            search_config: config.clone(),
            node_limit: 0,
        },
        || false,
    )
    .unwrap();
    let second_expected = choose_move(
        &game,
        DifficultyRequest {
            level: 1,
            rng_state: first_expected.rng_state,
            search_config: config,
            node_limit: 0,
        },
        || false,
    )
    .unwrap();
    assert_eq!(
        moves(&first)[0],
        first_expected.selected_move.unwrap().to_iccs()
    );
    assert_eq!(
        moves(&first)[1],
        second_expected.selected_move.unwrap().to_iccs()
    );

    let reset_seed = run(
        "setoption name Strategy value difficulty\nsetoption name DifficultyLevel value 1\nsetoption name RandomSeed value 48271\nposition startpos\ngo nodes 0\nsetoption name RandomSeed value 99\nucinewgame\nposition startpos\ngo nodes 0\nquit\n",
    );
    let reset_moves = moves(&reset_seed);
    let reset_expected = choose_move(
        &game,
        DifficultyRequest {
            level: 1,
            rng_state: 99,
            search_config: SearchConfig {
                node_limit: 0,
                ..SearchConfig::default()
            },
            node_limit: 0,
        },
        || false,
    )
    .unwrap();
    assert_eq!(
        reset_moves[1],
        reset_expected.selected_move.unwrap().to_iccs()
    );
}

#[test]
fn accepts_the_xiangqi_variant_selected_by_a_gui_or_match_runner() {
    let output =
        run("uci\nsetoption name UCI_Variant value xiangqi\nposition startpos\ngo perft 1\nquit\n");
    assert!(output.contains("Nodes searched: 44"));
    assert!(!output.contains("unsupported variant"));
}

#[test]
fn rejects_variants_the_engine_does_not_implement() {
    let output = run("uci\nsetoption name UCI_Variant value chess\nquit\n");
    assert!(output.contains("info string unsupported variant chess"));
}

#[test]
fn go_nodes_after_position_returns_a_coordinate_bestmove() {
    let output = run("position startpos moves h2e2 h9g7\ngo nodes 10000\nquit\n");
    let bestmove = output
        .lines()
        .find_map(|line| line.strip_prefix("bestmove "))
        .unwrap();
    let mut position = xq_core::Position::startpos();
    position
        .make_move(xq_core::Move::from_iccs("h2e2").unwrap())
        .unwrap();
    position
        .make_move(xq_core::Move::from_iccs("h9g7").unwrap())
        .unwrap();
    assert!(
        position
            .make_move(xq_core::Move::from_iccs(bestmove).unwrap())
            .is_ok()
    );
}

#[test]
fn perft_command_reports_the_standard_start_position_depth_two_count() {
    let output = run("position startpos\ngo perft 2\nquit\n");
    assert!(output.contains("Nodes searched: 1920"));
}

#[test]
fn position_fen_is_accepted_and_perft_matches_start_position() {
    let output = run(
        "position fen rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1\ngo perft 1\nquit\n",
    );
    assert!(output.contains("Nodes searched: 44"));
}

#[test]
fn stop_returns_bestmove_within_one_hundred_milliseconds() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_xq-uci"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("start xq-uci");
    let start = Instant::now();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"position startpos\ngo nodes 10000\nstop\nquit\n")
        .unwrap();
    let output = child.wait_with_output().expect("read xq-uci output");
    assert!(output.status.success());
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .any(|line| line.starts_with("bestmove "))
    );
    assert!(
        start.elapsed() < Duration::from_millis(100),
        "stop took {:?}",
        start.elapsed()
    );
}

#[test]
fn difficulty_stop_returns_one_selected_legal_move_without_partial_analysis() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_xq-uci"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("start xq-uci");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            b"setoption name Strategy value difficulty\nsetoption name DifficultyLevel value 9\nposition startpos\ngo depth 32 nodes 1000000\nstop\nquit\n",
        )
        .unwrap();
    let output = String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap();
    let selected = output
        .lines()
        .find_map(|line| line.strip_prefix("info string difficulty-selected "))
        .expect("stopped difficulty search reports its selected fallback or completed move");
    let selected_move = selected.split_whitespace().next().unwrap();
    let bestmoves: Vec<_> = output
        .lines()
        .filter_map(|line| line.strip_prefix("bestmove "))
        .collect();
    assert_eq!(bestmoves, [selected_move]);
    assert!(output.contains(" level 9"));
    assert!(
        Position::startpos()
            .make_move(xq_core::Move::from_iccs(selected_move).unwrap())
            .is_ok(),
        "stop fallback remains legal"
    );
}

#[test]
fn multipv_three_emits_three_distinct_info_lines() {
    let output = run_until_bestmove(
        "uci\nsetoption name MultiPV value 3\nposition startpos\ngo depth 1 nodes 5000\n",
    );
    let lines: Vec<_> = output
        .lines()
        .filter(|line| line.starts_with("info multipv "))
        .collect();
    assert_eq!(lines.len(), 3);
    assert!(lines[0].contains("multipv 1"));
    assert!(lines[1].contains("multipv 2"));
    assert!(lines[2].contains("multipv 3"));
}

#[test]
fn multipv_three_emits_three_info_lines_for_each_completed_depth() {
    let output = run_until_bestmove(
        "uci\nsetoption name MultiPV value 3\nposition startpos\ngo depth 3 nodes 100000\n",
    );
    let mut ranks_by_depth = std::collections::BTreeMap::<u8, Vec<u8>>::new();
    for line in output
        .lines()
        .filter(|line| line.starts_with("info multipv "))
    {
        let fields: Vec<_> = line.split_whitespace().collect();
        let rank = fields[2].parse::<u8>().expect("MultiPV rank is numeric");
        assert_eq!(fields[3], "depth", "MultiPV depth is present: {line}");
        let depth = fields[4].parse::<u8>().expect("depth is numeric");
        ranks_by_depth.entry(depth).or_default().push(rank);
    }
    assert!(
        ranks_by_depth.len() > 1,
        "expected multiple completed depths, got {ranks_by_depth:?}\n{output}"
    );
    for (depth, ranks) in ranks_by_depth {
        assert_eq!(
            ranks,
            [1, 2, 3],
            "depth {depth} must emit three ranked lines"
        );
    }
}

#[test]
fn terminal_position_reports_its_outcome_before_returning_no_move() {
    let output =
        run("position fen 3rk4/9/9/9/4P4/9/9/2n6/4r2n1/4K4 w - - 0 1\ngo nodes 100\nquit\n");
    assert!(output.contains("info string outcome black"));
    assert!(output.contains("bestmove 0000"));
}

#[test]
fn greedy_strategy_captures_the_most_valuable_available_piece() {
    let output = run(
        "setoption name Strategy value greedy\nposition fen 4k4/9/9/9/p7n/9/9/9/9/R2K4R w - - 0 1\ngo nodes 100\nquit\n",
    );
    assert!(output.contains("bestmove i0i5"));
}

#[test]
fn random_strategy_repeats_for_the_same_caller_seed_and_position() {
    let commands = "setoption name Strategy value random\nsetoption name RandomSeed value 48271\nposition startpos moves h2e2 h9g7\ngo nodes 100\nquit\n";
    let first = run(commands);
    let second = run(commands);
    let bestmove = |output: &str| -> String {
        output
            .lines()
            .find(|line| line.starts_with("bestmove "))
            .unwrap()
            .to_owned()
    };
    assert_eq!(bestmove(&first), bestmove(&second));
    let other = run(&commands.replace("48271", "5"));
    assert_ne!(bestmove(&first), bestmove(&other));
}

#[test]
fn composite_search_options_are_advertised_and_invalid_values_are_rejected() {
    let handshake = run("uci\nquit\n");
    assert!(handshake.contains("option name RootAlpha type check default true"));
    assert!(handshake.contains("option name CheckExtensions type check default true"));
    assert!(handshake.contains("option name KillerHistoryOrdering type check default true"));
    assert!(!handshake.contains("option name NullMove"));
    assert!(!handshake.contains("option name LateMoveReductions"));

    let invalid = run(
        "setoption name RootAlpha value maybe\nsetoption name CheckExtensions value maybe\nsetoption name KillerHistoryOrdering value maybe\nquit\n",
    );
    assert!(invalid.contains("info string invalid boolean option RootAlpha value maybe"));
    assert!(invalid.contains("info string invalid boolean option CheckExtensions value maybe"));
    assert!(
        invalid.contains("info string invalid boolean option KillerHistoryOrdering value maybe")
    );
}

#[test]
fn killer_history_option_controls_the_single_line_search() {
    let prefix = "uci\nsetoption name RootAlpha value true\nsetoption name CheckExtensions value true\nposition fen 4k4/4r4/9/4p4/9/9/9/9/4R4/3K5 w - - 0 1\n";
    let off = run_until_bestmove(&format!(
        "{prefix}setoption name KillerHistoryOrdering value false\ngo depth 5 nodes 100000\n"
    ));
    let on = run_until_bestmove(&format!(
        "{prefix}setoption name KillerHistoryOrdering value true\ngo depth 5 nodes 100000\n"
    ));
    let result = |text: &str| {
        let line = text
            .lines()
            .find(|line| line.starts_with("info depth 5 "))
            .expect("single-line search must complete depth 5");
        let fields: Vec<_> = line.split_whitespace().collect();
        let score = fields
            .iter()
            .position(|field| *field == "cp")
            .and_then(|index| fields.get(index + 1))
            .unwrap()
            .parse::<i32>()
            .unwrap();
        let nodes = fields
            .iter()
            .position(|field| *field == "nodes")
            .and_then(|index| fields.get(index + 1))
            .unwrap()
            .parse::<u64>()
            .unwrap();
        let bestmove = text
            .lines()
            .find_map(|line| line.strip_prefix("bestmove "))
            .unwrap();
        (score, nodes, bestmove.to_owned())
    };
    let before = result(&off);
    let after = result(&on);
    assert_eq!((after.0, after.2), (before.0, before.2));
    assert!(
        after.1 < before.1,
        "UCI option must reach the real search path"
    );
}

#[test]
fn uci_default_matches_explicit_adopted_search_options() {
    let default_output = run_until_bestmove("uci\nposition startpos\ngo depth 2 nodes 10000\n");
    let explicit_output = run_until_bestmove(
        "uci\nsetoption name RootAlpha value true\nsetoption name CheckExtensions value true\nsetoption name KillerHistoryOrdering value true\nposition startpos\ngo depth 2 nodes 10000\n",
    );
    let search_lines = |output: &str| {
        output
            .lines()
            .filter(|line| line.starts_with("info depth ") || line.starts_with("bestmove "))
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        search_lines(&default_output),
        search_lines(&explicit_output)
    );
}

#[test]
fn explicit_composite_with_killer_off_preserves_the_frozen_m4_snapshot() {
    let output = run_until_bestmove(
        "uci\nsetoption name RootAlpha value true\nsetoption name CheckExtensions value true\nsetoption name KillerHistoryOrdering value false\nposition startpos\ngo depth 2 nodes 10000\n",
    );
    assert!(output.contains("info depth 2 score cp 7 nodes 2530"));
    assert!(output.lines().any(|line| line == "bestmove b2b6"));
}

#[test]
fn composite_search_options_run_the_single_line_search_path() {
    let baseline = run_until_bestmove(
        "uci\nsetoption name RootAlpha value false\nsetoption name CheckExtensions value false\nposition startpos\ngo depth 2 nodes 200000\n",
    );
    let output = run_until_bestmove(
        "uci\nsetoption name RootAlpha value true\nsetoption name CheckExtensions value true\nposition startpos\ngo depth 2 nodes 200000\n",
    );
    let bestmove = output
        .lines()
        .find_map(|line| line.strip_prefix("bestmove "))
        .expect("single line search returns bestmove");
    let mut position = xq_core::Position::startpos();
    assert!(
        position
            .make_move(xq_core::Move::from_iccs(bestmove).unwrap())
            .is_ok()
    );
    assert!(
        output.contains("info depth 2"),
        "candidate must complete depth 2: {output}"
    );
    let depth_two_nodes = |text: &str| {
        text.lines()
            .find(|line| line.starts_with("info depth 2 "))
            .and_then(|line| {
                let fields: Vec<_> = line.split_whitespace().collect();
                fields
                    .iter()
                    .position(|field| *field == "nodes")
                    .and_then(|index| fields.get(index + 1))
                    .and_then(|value| value.parse::<u64>().ok())
            })
            .expect("completed depth reports its node count")
    };
    assert!(
        depth_two_nodes(&output) < depth_two_nodes(&baseline),
        "both UCI options must affect the real single-line search path"
    );
}

#[test]
fn single_pv_info_line_names_the_best_move_so_strict_uci_clients_can_read_it() {
    let output = run_until_bestmove("uci\nposition startpos moves h2e2 h9g7\ngo nodes 200\n");
    let info = output
        .lines()
        .rfind(|line| line.starts_with("info depth "))
        .expect("a completed depth is reported");
    let bestmove = output
        .lines()
        .find_map(|line| line.strip_prefix("bestmove "))
        .expect("bestmove");
    assert!(
        info.ends_with(&format!(" pv {bestmove}")),
        "info line {info:?} must end with the best move {bestmove}"
    );
}
