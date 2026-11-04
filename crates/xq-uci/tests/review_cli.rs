#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);

fn review_command(record: &std::path::Path, engine: &std::path::Path) -> std::process::Output {
    review_command_with_timeout(record, engine, "30000")
}

fn review_command_with_timeout(
    record: &std::path::Path,
    engine: &std::path::Path,
    timeout_ms: &str,
) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_xq-uci"))
        .args([
            "review",
            "--record",
            record.to_str().unwrap(),
            "--engine",
            engine.to_str().unwrap(),
            "--nodes",
            "20",
            "--deep-nodes",
            "40",
            "--timeout-ms",
            timeout_ms,
        ])
        .output()
        .unwrap()
}

fn command_output(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_xq-uci"))
        .args(args)
        .output()
        .unwrap()
}

fn stderr_error(output: &std::process::Output) -> serde_json::Value {
    serde_json::from_slice(&output.stderr).expect("stderr should contain a JSON error object")
}

#[test]
fn review_cli_localizes_argument_error_and_preserves_its_code_and_cause() {
    let output = command_output(&[
        "review",
        "--record",
        "game.pgn",
        "--engine",
        "engine",
        "--nodes",
        "not-a-number",
    ]);
    assert_eq!(output.status.code(), Some(1));
    let error = stderr_error(&output);
    assert_eq!(error["error"]["code"], "invalid_arguments");
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("--nodes")
    );
    assert!(error["error"]["message"].as_str().unwrap().contains("整數"));
    assert!(
        error["error"]["cause"]
            .as_str()
            .unwrap()
            .contains("invalid integer for --nodes")
    );
}

#[test]
fn global_help_succeeds_and_lists_available_modes() {
    let output = command_output(&["--help"]);
    assert_eq!(output.status.code(), Some(0));
    let help = String::from_utf8_lossy(&output.stdout);
    assert!(help.contains("用法"), "{help}");
    assert!(help.contains("review"), "{help}");
    assert!(help.contains("UCI"), "{help}");
    assert!(output.stderr.is_empty());
}

#[test]
fn no_arguments_preserves_uci_protocol_mode() {
    use std::io::Write;
    let mut child = Command::new(env!("CARGO_BIN_EXE_xq-uci"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"uci\nquit\n")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("uciok"), "{stdout}");
    assert!(output.stderr.is_empty());
}

#[test]
fn unknown_subcommand_fails_with_localized_structured_error() {
    let output = command_output(&["revie"]);
    assert_eq!(output.status.code(), Some(1));
    let error = stderr_error(&output);
    assert_eq!(error["error"]["code"], "unknown_command");
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("revie")
    );
    assert!(error["error"]["message"].as_str().unwrap().contains("命令"));
    assert!(error["error"]["cause"].as_str().unwrap().contains("revie"));
}

#[test]
fn unexpected_global_option_fails_before_reading_stdin() {
    let output = command_output(&["--nodes"]);
    assert_eq!(output.status.code(), Some(1));
    let error = stderr_error(&output);
    assert_eq!(error["error"]["code"], "invalid_arguments");
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("--nodes")
    );
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("命令列")
    );
    assert!(
        error["error"]["cause"]
            .as_str()
            .unwrap()
            .contains("--nodes")
    );
}

#[test]
fn review_help_succeeds_and_documents_required_options_and_defaults() {
    let output = command_output(&["review", "--help"]);
    assert_eq!(output.status.code(), Some(0));
    let help = String::from_utf8_lossy(&output.stdout);
    for expected in [
        "用法",
        "--record",
        "--engine",
        "--nodes",
        "1000",
        "--deep-nodes",
        "10000",
        "--timeout-ms",
        "30000",
    ] {
        assert!(help.contains(expected), "missing {expected} in:\n{help}");
    }
    assert!(output.stderr.is_empty());
}

#[test]
fn help_with_unknown_arguments_is_rejected_instead_of_short_circuiting() {
    for args in [
        vec!["--help", "--bogus"],
        vec!["review", "--bogus", "--help"],
        vec!["review", "--help", "--bogus"],
        vec!["review", "--help", "--record", "--bogus"],
    ] {
        let output = command_output(&args);
        assert_eq!(output.status.code(), Some(1), "args={args:?}");
        let error = stderr_error(&output);
        assert_eq!(error["error"]["code"], "invalid_arguments");
        assert!(
            error["error"]["message"]
                .as_str()
                .unwrap()
                .contains("--bogus")
        );
    }
}

#[test]
fn malformed_record_returns_review_for_legal_prefix_with_partial_diagnostic() {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir =
        std::env::temp_dir().join(format!("xq-review-cli-partial-{}-{id}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let record = dir.join("partial.iccs");
    let engine = dir.join("fake-uci.sh");
    fs::write(&record, "h2e2 zzzz i0h0\n").unwrap();
    write_executable(
        &engine,
        r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    uci) printf 'id name Prefix Fake\noption name MultiPV type spin default 1 min 1 max 8\nuciok\n' ;;
    isready) printf 'readyok\n' ;;
    'position fen '*) position_line=$line ;;
    'setoption name MultiPV value '*) multi=${line##*value } ;;
    'go nodes '*)
      case "$position_line" in
        *moves*) printf 'info depth 1 multipv 1 score cp 0 pv a6a5\nbestmove a6a5\n' ;;
        *)
          printf 'info depth 1 multipv 1 score cp 0 pv a3a4\n'
          if [ "$multi" -ge 2 ]; then printf 'info depth 1 multipv 2 score cp -10 pv c3c4\n'; fi
          if [ "$multi" -ge 3 ]; then printf 'info depth 1 multipv 3 score cp -20 pv e3e4\n'; fi
          printf 'bestmove a3a4\n' ;;
      esac ;;
    quit) exit 0 ;;
  esac
done
"#,
    );

    let output = review_command(&record, &engine);
    assert_eq!(output.status.code(), Some(1));
    let report: serde_json::Value =
        serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
            panic!(
                "partial JSON on stdout: {error}; stderr={}",
                String::from_utf8_lossy(&output.stderr)
            )
        });
    assert_eq!(report["import_status"], "partial");
    assert_eq!(report["source"]["imported_plies"], 1);
    assert_eq!(report["plies"].as_array().unwrap().len(), 1);
    assert_eq!(report["plies"][0]["played_move"], "h2e2");
    assert!(!output.stdout.windows(5).any(|window| window == b"i0h0"));
    assert_eq!(report["import_diagnostic"]["step"], 2);
    assert_eq!(report["import_diagnostic"]["token"], "zzzz");
    assert!(
        report["import_diagnostic"]["message"]
            .as_str()
            .unwrap()
            .contains("第 2 手")
    );
    let stderr = stderr_error(&output);
    assert!(
        stderr["error"]["message"]
            .as_str()
            .unwrap()
            .contains("第 2 手")
    );
    assert!(stderr["error"]["cause"].as_str().unwrap().contains("zzzz"));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn dhtmlxq_out_of_range_move_returns_cli_review_for_legal_prefix() {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "xq-review-cli-dpxq-partial-{}-{id}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    let record = dir.join("partial.dpxq");
    let engine = dir.join("fake-uci.sh");
    fs::write(&record, "[DhtmlXQ_movelist]77479900[/DhtmlXQ_movelist]\n").unwrap();
    write_executable(
        &engine,
        r#"#!/bin/sh
multi=1
while IFS= read -r line; do
  case "$line" in
    uci) printf 'id name Dhtml Prefix Fake\noption name MultiPV type spin default 1 min 1 max 8\nuciok\n' ;;
    isready) printf 'readyok\n' ;;
    'position fen '*) position_line=$line ;;
    'setoption name MultiPV value '*) multi=${line##*value } ;;
    'go nodes '*)
      case "$position_line" in
        *moves*) printf 'info depth 1 multipv 1 score cp 0 pv a6a5\nbestmove a6a5\n' ;;
        *)
          printf 'info depth 1 multipv 1 score cp 0 pv a3a4\n'
          if [ "$multi" -ge 2 ]; then printf 'info depth 1 multipv 2 score cp -10 pv c3c4\n'; fi
          if [ "$multi" -ge 3 ]; then printf 'info depth 1 multipv 3 score cp -20 pv e3e4\n'; fi
          printf 'bestmove a3a4\n' ;;
      esac ;;
    quit) exit 0 ;;
  esac
done
"#,
    );

    let output = review_command(&record, &engine);
    assert_eq!(output.status.code(), Some(1));
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["import_status"], "partial");
    assert_eq!(report["source"]["format"], "dhtml_xq");
    assert_eq!(report["source"]["imported_plies"], 1);
    assert_eq!(report["plies"].as_array().unwrap().len(), 1);
    assert_eq!(report["plies"][0]["played_move"], "h2e2");
    assert_eq!(report["import_diagnostic"]["step"], 2);
    assert_eq!(report["import_diagnostic"]["token"], "9900");
    assert_eq!(report["import_diagnostic"]["token_utf8_hex"], "39393030");
    assert_eq!(
        report["import_diagnostic"]["raw_chunk_bytes_hex"],
        "39393030"
    );
    assert!(
        report["import_diagnostic"]["message"]
            .as_str()
            .unwrap()
            .contains("第 2 手")
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn dhtmlxq_compact_utf8_boundary_keeps_visible_token_and_raw_chunk_hex_in_cli_json() {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "xq-review-cli-dpxq-utf8-{}-{id}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    let record = dir.join("partial.dpxq");
    let engine = dir.join("fake-uci.sh");
    fs::write(&record, "[DhtmlXQ_movelist]7747abcé[/DhtmlXQ_movelist]\n").unwrap();
    write_executable(
        &engine,
        r#"#!/bin/sh
multi=1
while IFS= read -r line; do
  case "$line" in
    uci) printf 'id name Dhtml UTF8 Fake\noption name MultiPV type spin default 1 min 1 max 8\nuciok\n' ;;
    isready) printf 'readyok\n' ;;
    'position fen '*) position_line=$line ;;
    'setoption name MultiPV value '*) multi=${line##*value } ;;
    'go nodes '*)
      case "$position_line" in
        *moves*) printf 'info depth 1 multipv 1 score cp 0 pv a6a5\nbestmove a6a5\n' ;;
        *)
          printf 'info depth 1 multipv 1 score cp 0 pv a3a4\n'
          if [ "$multi" -ge 2 ]; then printf 'info depth 1 multipv 2 score cp -10 pv c3c4\n'; fi
          if [ "$multi" -ge 3 ]; then printf 'info depth 1 multipv 3 score cp -20 pv e3e4\n'; fi
          printf 'bestmove a3a4\n' ;;
      esac ;;
    quit) exit 0 ;;
  esac
done
"#,
    );

    let output = review_command(&record, &engine);
    assert_eq!(output.status.code(), Some(1));
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["import_status"], "partial");
    assert_eq!(report["source"]["imported_plies"], 1);
    assert_eq!(report["plies"].as_array().unwrap().len(), 1);
    assert_eq!(report["import_diagnostic"]["step"], 2);
    assert_eq!(report["import_diagnostic"]["token"], "abcé");
    assert_eq!(report["import_diagnostic"]["token_utf8_hex"], "616263c3a9");
    assert_eq!(
        report["import_diagnostic"]["raw_chunk_bytes_hex"],
        "616263c3"
    );
    fs::remove_dir_all(dir).unwrap();
}

fn write_executable(path: &std::path::Path, body: &str) {
    fs::write(path, body).unwrap();
    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).unwrap();
}

#[test]
fn review_cli_outputs_source_scores_and_unmodified_short_pvs_for_imported_game() {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("xq-review-cli-{}-{id}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let record = dir.join("game.iccs");
    fs::write(&record, "h2e2 h9g7 h0g2 i9h9 i0h0 b9c7\n").unwrap();
    let engine = dir.join("fake-uci.sh");
    fs::write(
        &engine,
        r#"#!/bin/sh
multi=1
while IFS= read -r line; do
  case "$line" in
    uci) printf 'id name Deterministic Fake\noption name MultiPV type spin default 1 min 1 max 8\nuciok\n' ;;
    isready) printf 'readyok\n' ;;
    'setoption name MultiPV value '*) multi=${line##*value } ;;
    'position fen '* )
      count=$(printf '%s\n' "$line" | awk '{for(i=1;i<=NF;i++) if($i=="moves") print NF-i}')
      if [ -z "$count" ]; then count=0; fi
      if [ $((count % 2)) -eq 1 ]; then moves='a6a5 c6c5 e6e5'; else moves='a3a4 c3c4 e3e4'; fi ;;
    'go nodes '*)
      set -- $moves
      i=1
      while [ "$i" -le "$multi" ]; do
        eval "move=\$$i"
        printf 'info depth 1 multipv %s score cp %s pv %s\n' "$i" "$((60 - i * 10))" "$move"
        i=$((i + 1))
      done
      printf 'bestmove %s\n' "$(printf '%s\n' $moves | head -1)" ;;
    quit) exit 0 ;;
  esac
done
"#,
    )
    .unwrap();
    let mut permissions = fs::metadata(&engine).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&engine, permissions).unwrap();

    let output = review_command(&record, &engine);
    assert!(
        output.status.success(),
        "review command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["schema_version"], 1);
    assert_eq!(report["source"]["format"], "iccs");
    assert_eq!(report["source"]["format_label"], "座標記譜");
    assert_eq!(report["source"]["path"], record.to_str().unwrap());
    assert_eq!(report["analyzer"], "Deterministic Fake");
    assert_eq!(report["plies"].as_array().unwrap().len(), 6);
    let first = &report["plies"][0];
    assert_eq!(first["side"], "red");
    assert_eq!(first["side_label"], "紅方");
    assert_eq!(first["quick"]["result"]["classification"], "doubtful_move");
    assert_eq!(first["quick"]["result"]["classification_label"], "疑問手");
    assert_eq!(first["played_move"], "h2e2");
    assert_eq!(first["quick"]["result"]["best_score"]["centipawns"], 50);
    assert_eq!(
        first["quick"]["candidates"][0]["principal_variation"],
        serde_json::json!(["a3a4"])
    );
    assert_eq!(
        first["quick"]["candidates"][0]["six_move_target_met"],
        false
    );
    assert_eq!(
        first["quick"]["candidates"][0]["pv_status"],
        "short_unconfirmed"
    );
    assert!(first["final"]["result"]["loss_percent"].is_number());

    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn review_cli_translates_import_variation_warning_into_a_stable_zh_tw_message() {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "xq-review-cli-variation-warning-{}-{id}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    let record = dir.join("branched.dpxq");
    let engine = dir.join("fake-uci.sh");
    fs::write(
        &record,
        "[DhtmlXQ_movelist]77479EZK000070622RXP0002[/DhtmlXQ_movelist]\n",
    )
    .unwrap();
    write_executable(
        &engine,
        r#"#!/bin/sh
multi=1
while IFS= read -r line; do
  case "$line" in
    uci) printf 'id name Warning Fake\noption name MultiPV type spin default 1 min 1 max 8\nuciok\n' ;;
    isready) printf 'readyok\n' ;;
    'position fen '*) position_line=$line ;;
    'setoption name MultiPV value '*) multi=${line##*value } ;;
    'go nodes '*)
      case "$position_line" in
        *moves*) printf 'info depth 1 multipv 1 score cp 0 pv a6a5\nbestmove a6a5\n' ;;
        *)
          printf 'info depth 1 multipv 1 score cp 0 pv a3a4\n'
          if [ "$multi" -ge 2 ]; then printf 'info depth 1 multipv 2 score cp -10 pv c3c4\n'; fi
          if [ "$multi" -ge 3 ]; then printf 'info depth 1 multipv 3 score cp -20 pv e3e4\n'; fi
          printf 'bestmove a3a4\n' ;;
      esac ;;
    quit) exit 0 ;;
  esac
done
"#,
    );

    let output = review_command(&record, &engine);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report["source"]["warnings"],
        serde_json::json!([{
            "code": "variations_not_imported",
            "message": "棋譜含有變著，但目前未匯入變著。"
        }])
    );
    assert_eq!(report["source"]["imported_plies"], 1);
    assert_eq!(report["plies"].as_array().unwrap().len(), 1);
    assert_eq!(report["plies"][0]["played_move"], "h2e2");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn review_cli_rejects_variation_only_legacy_record_without_reporting_a_move() {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "xq-review-cli-variation-only-{}-{id}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    let record = dir.join("variation-only.dpxq");
    let absent_engine = dir.join("must-not-start");
    fs::write(
        &record,
        "[DhtmlXQ_movelist]77479EZK9999[/DhtmlXQ_movelist]\n",
    )
    .unwrap();

    let output = review_command(&record, &absent_engine);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let error = stderr_error(&output);
    assert_eq!(error["error"]["code"], "record_import_failed");
    assert!(error["error"]["message"].as_str().unwrap().contains("變著"));
    assert!(error["error"]["message"].as_str().unwrap().contains("主線"));
    assert!(
        error["error"]["cause"]
            .as_str()
            .unwrap()
            .contains("variations_not_imported")
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn review_cli_rejects_empty_dhtmlxq_and_header_only_pgn_before_starting_engine() {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "xq-review-cli-empty-record-{}-{id}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    let absent_engine = dir.join("must-not-start");
    let mut failures = Vec::new();
    for (name, contents) in [
        ("empty.dpxq", "[DhtmlXQ_movelist][/DhtmlXQ_movelist]\n"),
        (
            "headers-only.pgn",
            "[Event \"No moves\"]\n[Site \"test\"]\n",
        ),
    ] {
        let record = dir.join(name);
        fs::write(&record, contents).unwrap();
        let output = review_command(&record, &absent_engine);
        let error = serde_json::from_slice::<serde_json::Value>(&output.stderr).ok();
        if output.status.code() != Some(1)
            || !output.stdout.is_empty()
            || error.as_ref().is_none_or(|error| {
                error["error"]["code"] != "record_import_failed"
                    || !error["error"]["message"]
                        .as_str()
                        .unwrap_or_default()
                        .contains("沒有可覆盤的合法著法")
            })
        {
            failures.push((name, output.status.code(), output.stdout, output.stderr));
        }
    }
    assert!(
        failures.is_empty(),
        "unexpected empty-record results: {failures:?}"
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn review_cli_returns_nonzero_for_import_and_engine_startup_errors() {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir =
        std::env::temp_dir().join(format!("xq-review-cli-errors-{}-{id}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let record = dir.join("game.txt");
    let absent_engine = dir.join("absent-engine");

    fs::write(&record, "zzzz").unwrap();
    let import_error = review_command(&record, &absent_engine);
    assert_eq!(import_error.status.code(), Some(1));
    let error = stderr_error(&import_error);
    assert_eq!(error["error"]["code"], "record_import_failed");
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("第 1 手")
    );
    assert!(error["error"]["message"].as_str().unwrap().contains("zzzz"));
    assert!(!error["error"]["cause"].as_str().unwrap().is_empty());

    fs::remove_file(&record).unwrap();
    let read_error = review_command(&record, &absent_engine);
    assert_eq!(read_error.status.code(), Some(1));
    let error = stderr_error(&read_error);
    assert_eq!(error["error"]["code"], "record_read_failed");
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("棋譜檔")
    );
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("game.txt")
    );
    assert!(
        error["error"]["cause"]
            .as_str()
            .unwrap()
            .contains("No such file")
    );

    fs::write(&record, "h2e2\n").unwrap();
    let engine_error = review_command(&record, &absent_engine);
    assert_eq!(engine_error.status.code(), Some(1));
    let error = stderr_error(&engine_error);
    assert_eq!(error["error"]["code"], "engine_start_failed");
    assert!(error["error"]["message"].as_str().unwrap().contains("引擎"));
    assert!(
        error["error"]["cause"]
            .as_str()
            .unwrap()
            .contains("cannot start UCI engine")
    );

    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn review_cli_uses_candidates_from_the_same_pass_without_researching() {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "xq-review-cli-snapshot-{}-{id}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    let record = dir.join("one-ply.iccs");
    let engine = dir.join("changing-uci.sh");
    let calls_path = dir.join("go-count");
    fs::write(&record, "h2e2\n").unwrap();
    write_executable(
        &engine,
        &format!(
            r#"#!/bin/sh
calls=0
while IFS= read -r line; do
  case "$line" in
    uci) printf 'id name Changing Fake\noption name MultiPV type spin default 1 min 1 max 8\nuciok\n' ;;
    isready) printf 'readyok\n' ;;
    'setoption name MultiPV value '*) multi=$(printf '%s\n' "$line" | awk '{{print $NF}}') ;;
    'position fen '*) history=$(printf '%s\n' "$line" | awk '{{for(i=1;i<=NF;i++) if($i=="moves") print NF-i}}')
      if [ -z "$history" ]; then side=red; else side=black; fi ;;
    'go nodes '*)
      calls=$((calls + 1))
      printf '%s\n' "$calls" > '{}'
      if [ "$side" = black ]; then
        printf 'info depth 1 multipv 1 score cp -60 pv a6a5\nbestmove a6a5\n'
      elif [ "$calls" -eq 1 ]; then
        printf 'info depth 1 multipv 1 score cp 60 pv h2e2\n'
        printf 'info depth 1 multipv 2 score cp 40 pv c3c4\n'
        printf 'info depth 1 multipv 3 score cp 20 pv e3e4\nbestmove h2e2\n'
      else
        printf 'info depth 1 multipv 1 score cp 30 pv c3c4\n'
        printf 'info depth 1 multipv 2 score cp 20 pv h2e2\n'
        printf 'info depth 1 multipv 3 score cp 10 pv e3e4\nbestmove c3c4\n'
      fi ;;
    quit) exit 0 ;;
  esac
done
"#,
            calls_path.display()
        ),
    );

    let output = review_command(&record, &engine);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let quick = &report["plies"][0]["quick"];
    assert_eq!(
        quick["result"]["best_move"],
        quick["candidates"][0]["best_move"]
    );
    assert_eq!(
        quick["result"]["best_score"]["centipawns"],
        quick["candidates"][0]["score"]["centipawns"]
    );
    let final_pass = &report["plies"][0]["final"];
    assert_eq!(final_pass["deepened"], false);
    assert_eq!(
        final_pass["result"]["best_move"],
        final_pass["candidates"][0]["best_move"]
    );
    assert_eq!(
        final_pass["result"]["best_score"]["centipawns"],
        final_pass["candidates"][0]["score"]["centipawns"]
    );
    assert_eq!(final_pass["candidates"], quick["candidates"]);
    assert_eq!(fs::read_to_string(&calls_path).unwrap().trim(), "2");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn review_cli_keeps_deep_result_and_deep_candidates_from_one_snapshot() {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("xq-review-cli-deep-{}-{id}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let record = dir.join("one-ply.iccs");
    let engine = dir.join("deep-uci.sh");
    let calls_path = dir.join("go-count");
    fs::write(&record, "h2e2\n").unwrap();
    write_executable(
        &engine,
        &format!(
            r#"#!/bin/sh
calls=0
while IFS= read -r line; do
  case "$line" in
    uci) printf 'id name Deep Fake\noption name MultiPV type spin default 1 min 1 max 8\nuciok\n' ;;
    isready) printf 'readyok\n' ;;
    'setoption name MultiPV value '*) multi=$(printf '%s\n' "$line" | awk '{{print $NF}}') ;;
    'position fen '*) history=$(printf '%s\n' "$line" | awk '{{for(i=1;i<=NF;i++) if($i=="moves") print NF-i}}')
      if [ -z "$history" ]; then side=red; else side=black; fi ;;
    'go nodes '*)
      calls=$((calls + 1))
      printf '%s\n' "$calls" > '{}'
      if [ "$side" = black ]; then
        if [ "$calls" -eq 2 ]; then score=0; else score=-30; fi
        printf 'info depth 1 multipv 1 score cp %s pv a6a5\nbestmove a6a5\n' "$score"
      elif [ "$calls" -eq 1 ]; then
        printf 'info depth 1 multipv 1 score cp 200 pv h2e2\n'
        printf 'info depth 1 multipv 2 score cp 0 pv c3c4\n'
        printf 'info depth 1 multipv 3 score cp -10 pv e3e4\nbestmove h2e2\n'
      else
        printf 'info depth 1 multipv 1 score cp 30 pv c3c4\n'
        printf 'info depth 1 multipv 2 score cp 10 pv h2e2\n'
        printf 'info depth 1 multipv 3 score cp 0 pv e3e4\nbestmove c3c4\n'
      fi ;;
    quit) exit 0 ;;
  esac
done
"#,
            calls_path.display()
        ),
    );

    let output = review_command(&record, &engine);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let final_pass = &report["plies"][0]["final"];
    assert_eq!(final_pass["deepened"], true);
    assert_eq!(
        final_pass["result"]["best_move"],
        final_pass["candidates"][0]["best_move"]
    );
    assert_eq!(
        final_pass["result"]["best_score"]["centipawns"],
        final_pass["candidates"][0]["score"]["centipawns"]
    );
    assert_eq!(final_pass["result"]["best_move"], "c3c4");
    assert_eq!(fs::read_to_string(&calls_path).unwrap().trim(), "4");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn review_cli_requests_only_available_legal_candidate_count() {
    let fixtures = [
        (
            "one",
            "3k5/9/9/9/9/9/9/9/4A4/3K5 b - - 0 1",
            1,
            vec!["d9e9"],
            "d0e0",
        ),
        (
            "two",
            "3k5/9/9/9/9/9/9/9/3A5/3K5 b - - 0 1",
            2,
            vec!["d9e9", "d9d8"],
            "d1e2",
        ),
    ];
    for (label, fen, expected_count, expected_moves, child_move) in fixtures {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "xq-review-cli-legal-count-{label}-{}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let record = dir.join("fen.pgn");
        let engine = dir.join("few-legal-moves.sh");
        fs::write(&record, format!("[FEN \"{fen}\"]\nd9e9\n")).unwrap();
        write_executable(
            &engine,
            &format!(
                r#"#!/bin/sh
multi=1
child_move='{child_move}'
while IFS= read -r line; do
  case "$line" in
    uci) printf 'id name Few Moves Fake\noption name MultiPV type spin default 1 min 1 max 8\nuciok\n' ;;
    isready) printf 'readyok\n' ;;
    'setoption name MultiPV value '*) multi=$(printf '%s\n' "$line" | awk '{{print $NF}}') ;;
    'position fen '*)
      case "$line" in *' moves '*) position_kind=child ;; *) position_kind=root ;; esac ;;
    'go nodes '*)
      if [ "$position_kind" = child ]; then
        printf 'info depth 1 multipv 1 score cp 0 pv %s\nbestmove %s\n' "$child_move" "$child_move"
      else
        printf 'info depth 1 multipv 1 score cp 20 pv d9e9\n'
        if [ "$multi" -ge 2 ]; then printf 'info depth 1 multipv 2 score cp 10 pv d9d8\n'; fi
        printf 'bestmove d9e9\n'
      fi ;;
    quit) exit 0 ;;
  esac
done
"#,
            ),
        );

        let output = review_command(&record, &engine);
        assert!(
            output.status.success(),
            "fixture {label}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let candidates = &report["plies"][0]["quick"]["candidates"];
        assert_eq!(candidates.as_array().unwrap().len(), expected_count);
        assert_eq!(
            report["plies"][0]["quick"]["candidate_count"],
            expected_count
        );
        assert_eq!(
            candidates
                .as_array()
                .unwrap()
                .iter()
                .map(|line| line["best_move"].as_str().unwrap())
                .collect::<Vec<_>>(),
            expected_moves
        );
        fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn review_cli_preserves_engine_exit_cause_after_successful_handshake() {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("xq-review-cli-exit-{}-{id}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let record = dir.join("one-ply.iccs");
    fs::write(&record, "h2e2\n").unwrap();
    let cases = [
        (
            "exit",
            "EngineExited",
            "引擎已結束",
            r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    uci) printf 'id name Exit Fake\noption name MultiPV type spin default 1 min 1 max 8\nuciok\n' ;;
    isready) printf 'readyok\n' ;;
    'go nodes '*) exit 17 ;;
    quit) exit 0 ;;
  esac
done
"#,
        ),
        (
            "protocol",
            "invalid bestmove",
            "UCI 回應無效",
            r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    uci) printf 'id name Protocol Fake\noption name MultiPV type spin default 1 min 1 max 8\nuciok\n' ;;
    isready) printf 'readyok\n' ;;
    'go nodes '*) printf 'bestmove invalid\n' ;;
    quit) exit 0 ;;
  esac
done
"#,
        ),
        (
            "timeout",
            "Timeout",
            "分析逾時",
            r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    uci) printf 'id name Timeout Fake\noption name MultiPV type spin default 1 min 1 max 8\nuciok\n' ;;
    isready) printf 'readyok\n' ;;
    'go nodes '*) sleep 2 ;;
    quit) exit 0 ;;
  esac
done
"#,
        ),
    ];
    for (label, expected_cause, expected_message, script) in cases {
        let engine = dir.join(format!("{label}-during-search.sh"));
        write_executable(&engine, script);
        let output = review_command_with_timeout(&record, &engine, "100");
        assert_eq!(output.status.code(), Some(1), "{label}");
        let error = stderr_error(&output);
        assert_eq!(error["error"]["code"], "engine_analysis_failed");
        assert!(error["error"]["message"].as_str().unwrap().contains("分析"));
        assert!(
            error["error"]["message"]
                .as_str()
                .unwrap()
                .contains("第 1 手")
        );
        assert!(
            error["error"]["message"]
                .as_str()
                .unwrap()
                .contains(expected_message),
            "expected localized {expected_message} for {label}, got {error}"
        );
        assert!(
            error["error"]["cause"]
                .as_str()
                .unwrap()
                .contains(expected_cause),
            "expected {expected_cause} for {label}, got {error}"
        );
    }
    fs::remove_dir_all(dir).unwrap();
}

const NOTE_FAKE_ENGINE: &str = r#"#!/bin/sh
multi=1
position_kind=root
while IFS= read -r line; do
  case "$line" in
    uci) printf 'id name Note Fake\noption name MultiPV type spin default 1 min 1 max 8\nuciok\n' ;;
    isready) printf 'readyok\n' ;;
    'setoption name MultiPV value '*) multi=${line##*value } ;;
    'position fen '*)
      case "$line" in *' moves '*) position_kind=child ;; *) position_kind=root ;; esac ;;
    'go nodes '*)
      if [ "$position_kind" = child ]; then
        printf 'info depth 6 multipv 1 score cp 0 nodes 900 pv a6a5\nbestmove a6a5\n'
      else
        printf 'info depth 6 multipv 1 score mate 2 nodes 1234 pv a3a4 a6a5\n'
        if [ "$multi" -ge 2 ]; then printf 'info depth 6 multipv 2 score cp 0 nodes 1100 pv h2e2\n'; fi
        if [ "$multi" -ge 3 ]; then printf 'info depth 6 multipv 3 score cp -5 nodes 1000 pv b2c2\n'; fi
        printf 'bestmove a3a4\n'
      fi ;;
    quit) exit 0 ;;
  esac
done
"#;

/// Engine for the one-move mate record: mate in one, then two quiet alternatives.
const NOTE_FAKE_ENGINE_ANY: &str = r#"#!/bin/sh
multi=1
while IFS= read -r line; do
  case "$line" in
    uci) printf 'id name Any Fake\noption name MultiPV type spin default 1 min 1 max 8\nuciok\n' ;;
    isready) printf 'readyok\n' ;;
    'setoption name MultiPV value '*) multi=${line##*value } ;;
    'go nodes '*)
      printf 'info depth 1 multipv 1 score mate 1 pv b0b9\n'
      if [ "$multi" -ge 2 ]; then printf 'info depth 1 multipv 2 score cp 0 pv a8a9\n'; fi
      if [ "$multi" -ge 3 ]; then printf 'info depth 1 multipv 3 score cp -5 pv a8a7\n'; fi
      printf 'bestmove b0b9\n' ;;
    quit) exit 0 ;;
  esac
done
"#;

fn note_fixture(label: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "xq-review-cli-note-{label}-{}-{id}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    let record = dir.join("one.iccs");
    fs::write(&record, "h2e2\n").unwrap();
    let engine = dir.join("note-fake.sh");
    write_executable(&engine, NOTE_FAKE_ENGINE);
    (dir, record, engine)
}

#[test]
fn review_cli_json_carries_everything_the_note_generator_needs() {
    let (dir, record, engine) = note_fixture("inputs");
    let output = review_command(&record, &engine);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report["start_fen"],
        "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1"
    );
    assert_eq!(report["moves"], serde_json::json!(["h2e2"]));
    assert_eq!(
        report["result"], "unknown",
        "an unfinished game has no result"
    );
    assert_eq!(report["notations"], serde_json::json!(["炮二平五"]));
    let boards = report["boards"].as_array().unwrap();
    assert_eq!(
        boards.len(),
        2,
        "one board before each ply plus the final one"
    );
    assert_eq!(
        boards[0],
        "rnbakabnr..........c.....c.p.p.p.p.p..................P.P.P.P.P.C.....C..........RNBAKABNR"
    );
    assert_ne!(boards[0], boards[1]);
    assert_eq!(boards[1].as_str().unwrap().len(), 90);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn review_cli_json_reports_candidate_depth_nodes_pv_end_and_mate_reason() {
    let (dir, record, engine) = note_fixture("reason");
    let output = review_command(&record, &engine);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let result = &report["plies"][0]["final"]["result"];
    assert_eq!(result["classification"], "missed_mate");
    assert_eq!(
        result["reason"],
        serde_json::json!({ "kind": "missed_mate", "moves": 2 })
    );
    let first = &report["plies"][0]["final"]["candidates"][0];
    assert_eq!(first["depth"], 6);
    assert_eq!(first["nodes"], 1234);
    assert_eq!(first["pv_end"], "depth_limit");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn review_cli_json_reports_the_recorded_result_of_a_finished_game() {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir =
        std::env::temp_dir().join(format!("xq-review-cli-result-{}-{id}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    // Red to move can capture the black king's last defender and mate: use a one-move mate FEN.
    let record = dir.join("mate.pgn");
    fs::write(
        &record,
        "[FEN \"4k4/R8/9/9/9/9/9/9/9/1R1K5 w - - 0 1\"]\n1. b0b9\n",
    )
    .unwrap();
    let engine = dir.join("note-fake.sh");
    write_executable(&engine, NOTE_FAKE_ENGINE_ANY);
    let output = review_command(&record, &engine);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["result"], "red_win");
    fs::remove_dir_all(dir).unwrap();
}
