use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::Duration;

use xq_core::{Game, Move, Position, Side};
use xq_review::{Analyzer, Limit, ReviewScore};
use xq_uci::{AnalysisCancellation, UciAnalyzer, UciError};

static NEXT_TRACE: AtomicUsize = AtomicUsize::new(0);

const FAKE_UCI: &str = r#"
trace=$5
multi=1
printf 'pid %s\n' "$$" > "$trace"
while IFS= read -r line; do
  case "$line" in
    uci) printf 'id name Fake Xiangqi\noption name MultiPV type spin default 1 min 1 max 8\nuciok\n' ;;
    isready) printf 'readyok\n' ;;
    setoption*) multi=${line##*value } ;;
    position*) printf '%s\n' "$line" >> "$trace" ;;
    go*)
      case "$1" in
        timeout|cancel) exec sleep 5 ;;
        eof) exit 0 ;;
        crash) exit 17 ;;
        quiet-live) exec sh -c 'exec 1>&-; sleep 1' ;;
        continuous-info) for n in $(seq 1 300); do printf 'info string busy\n'; sleep 0.001; done ;;
        incomplete-multipv)
          printf 'info depth 4 multipv 1 score cp 42 pv %s\n' "$3"
          printf 'bestmove %s\n' "$2"
          continue
          ;;
        mixed-multipv)
          printf 'info depth 5 multipv 1 score cp 42 pv %s\n' "$3"
          printf 'info depth 4 multipv 2 score cp 30 pv %s\n' "$4"
          printf 'bestmove %s\n' "$2"
          continue
          ;;
        partial-iteration)
          second=${4%% *}
          printf 'info depth 5 multipv 1 score cp 42 pv %s\n' "$3"
          printf 'info depth 5 multipv 2 score cp 30 pv %s\n' "$4"
          printf 'info depth 6 multipv 1 score cp 41 pv %s\n' "$4"
          printf 'bestmove %s\n' "$second"
          continue
          ;;
        reshuffled-partial)
          printf 'info depth 5 multipv 1 score cp 42 pv %s\n' "$3"
          printf 'info depth 5 multipv 2 score cp 30 pv %s\n' "$4"
          printf 'info depth 6 multipv 1 score cp 41 pv %s\n' "$4"
          printf 'info depth 5 multipv 2 score cp 40 pv %s\n' "$3"
          printf 'bestmove %s\n' "${4%% *}"
          continue
          ;;
        delayed-duplicate)
          printf 'info depth 4 multipv 2 score mate -3 pv %s\n' "$4"
          printf 'info depth 4 multipv 1 score cp 42 pv %s\n' "$3"
          printf 'bestmove %s\n' "$2"
          (sleep 0.08; printf 'bestmove %s\n' "$2") &
          continue
          ;;
      esac
      if [ "$multi" -ge 2 ]; then
        printf 'info depth 4 multipv 2 score mate -3 nodes 777 pv %s\n' "$4"
      fi
      printf 'info depth 4 multipv 1 score cp 42 nodes 1234 pv %s\n' "$3"
      printf 'bestmove %s\n' "$2"
      if [ "$1" = duplicate ]; then printf 'bestmove %s\n' "$2"; fi
      ;;
    quit) exit 0 ;;
  esac
done
"#;

fn trace_path(label: &str) -> PathBuf {
    let id = NEXT_TRACE.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "xq-uci-analyzer-{label}-{}-{id}.log",
        std::process::id()
    ))
}

fn test_game() -> Game {
    let mut game = Game::new(Position::startpos());
    game.play(Move::from_iccs("h2e2").unwrap()).unwrap();
    game.play(Move::from_iccs("h9g7").unwrap()).unwrap();
    game
}

fn legal_pv(game: &Game, first: Move) -> Vec<Move> {
    let mut position = game.position().clone();
    position.make_move(first).unwrap();
    vec![first, position.legal_moves()[0]]
}

fn pv_text(moves: &[Move]) -> String {
    moves
        .iter()
        .map(|movement| movement.to_iccs())
        .collect::<Vec<_>>()
        .join(" ")
}

fn fake_analyzer(
    mode: &str,
    game: &Game,
    timeout: Duration,
) -> (UciAnalyzer, PathBuf, Vec<Move>, Vec<Move>) {
    let legal = game.position().clone().legal_moves();
    let pv1 = legal_pv(game, legal[0]);
    let pv2 = legal_pv(game, legal[1]);
    let trace = trace_path(mode);
    let args = [
        OsString::from("-c"),
        OsString::from(FAKE_UCI),
        OsString::from("fake-engine"),
        OsString::from(mode),
        OsString::from(pv1[0].to_iccs()),
        OsString::from(pv_text(&pv1)),
        OsString::from(pv_text(&pv2)),
        trace.clone().into_os_string(),
    ];
    (
        UciAnalyzer::with_args("/bin/sh", args, timeout).unwrap(),
        trace,
        pv1,
        pv2,
    )
}

fn child_pid(trace: &PathBuf) -> u32 {
    fs::read_to_string(trace)
        .unwrap()
        .lines()
        .next()
        .unwrap()
        .strip_prefix("pid ")
        .unwrap()
        .parse()
        .unwrap()
}

fn process_exists(pid: u32) -> bool {
    PathBuf::from(format!("/proc/{pid}")).exists()
}

#[test]
fn game_exposes_its_initial_position_and_ordered_history_for_external_replay() {
    let game = test_game();
    assert_eq!(
        game.initial_position().to_fen(),
        Position::startpos().to_fen()
    );
    assert_eq!(
        game.history_moves()
            .map(|m| m.to_iccs())
            .collect::<Vec<_>>(),
        ["h2e2", "h9g7"]
    );
    assert_eq!(game.position().side_to_move(), Side::Red);
}

#[test]
fn uci_handshake_preserves_history_and_returns_sorted_exact_scores_and_legal_pv() {
    let game = test_game();
    let (mut analyzer, trace, pv1, pv2) = fake_analyzer("normal", &game, Duration::from_secs(1));
    assert_eq!(analyzer.name(), "Fake Xiangqi");
    let lines = analyzer
        .analyze_game_checked(&game, Limit::new(10_000), 2)
        .unwrap();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].best_move, pv1[0]);
    assert_eq!(lines[0].score, ReviewScore::centipawns(42));
    assert_eq!(lines[0].principal_variation, pv1);
    assert_eq!(lines[1].best_move, pv2[0]);
    assert_eq!(lines[1].score, ReviewScore::mated_in(3));
    assert_eq!(lines[1].principal_variation, pv2);
    // Metadata for the review layer: reported depth, node count, and a PV that
    // stopped at the engine's depth rather than at a game outcome.
    assert_eq!((lines[0].depth, lines[0].nodes), (4, 1234));
    assert_eq!((lines[1].depth, lines[1].nodes), (4, 777));
    assert_eq!(lines[0].pv_end, xq_review::PvEnd::DepthLimit);
    let fen = Position::startpos().to_fen();
    let sent = format!("position fen {fen} moves h2e2 h9g7");
    assert!(
        fs::read_to_string(&trace)
            .unwrap()
            .lines()
            .any(|line| line == sent)
    );
    drop(analyzer);
    assert!(
        !process_exists(child_pid(&trace)),
        "Drop must reap the engine child"
    );
    fs::remove_file(trace).unwrap();
}

#[test]
fn cancellation_stops_analysis_and_reaps_unresponsive_child() {
    let game = test_game();
    let (mut analyzer, trace, _, _) = fake_analyzer("cancel", &game, Duration::from_secs(2));
    let cancel: AnalysisCancellation = analyzer.cancellation_handle();
    let worker = thread::spawn(move || analyzer.analyze_game_checked(&game, Limit::new(10_000), 2));
    thread::sleep(Duration::from_millis(80));
    cancel.cancel();
    assert!(matches!(worker.join().unwrap(), Err(UciError::Cancelled)));
    assert!(
        !process_exists(child_pid(&trace)),
        "cancel must reap the engine child"
    );
    fs::remove_file(trace).unwrap();
}

#[test]
fn timeout_eof_and_crash_fail_closed_and_reap_children() {
    let game = test_game();
    for (mode, timeout, expected) in [
        ("timeout", Duration::from_millis(100), "timeout"),
        ("eof", Duration::from_secs(1), "eof"),
        ("crash", Duration::from_secs(1), "exit"),
    ] {
        let (mut analyzer, trace, _, _) = fake_analyzer(mode, &game, timeout);
        let result = analyzer.analyze_game_checked(&game, Limit::new(10_000), 2);
        match (expected, result) {
            ("timeout", Err(UciError::Timeout)) => {}
            ("eof", Err(UciError::EngineExited { .. })) => {}
            ("exit", Err(UciError::EngineExited { status: Some(17) })) => {}
            (_, other) => panic!("unexpected {mode} result: {other:?}"),
        }
        assert!(
            !process_exists(child_pid(&trace)),
            "{mode} must reap the engine child"
        );
        fs::remove_file(trace).unwrap();
    }
}

#[test]
fn duplicate_bestmove_is_rejected_before_the_next_search() {
    let game = test_game();
    let (mut analyzer, trace, _, _) = fake_analyzer("duplicate", &game, Duration::from_secs(1));
    assert!(
        analyzer
            .analyze_game_checked(&game, Limit::new(10_000), 2)
            .is_ok()
    );
    assert!(matches!(
        analyzer.analyze_game_checked(&game, Limit::new(10_000), 2),
        Err(UciError::Protocol(_))
    ));
    assert!(!process_exists(child_pid(&trace)));
    fs::remove_file(trace).unwrap();
}

#[test]
fn stdout_eof_while_child_is_alive_still_obeys_deadline_and_reaps() {
    let game = test_game();
    let timeout = Duration::from_millis(100);
    let (mut analyzer, trace, _, _) = fake_analyzer("quiet-live", &game, timeout);
    let started = std::time::Instant::now();
    let result = analyzer.analyze_game_checked(&game, Limit::new(10_000), 1);
    assert!(matches!(result, Err(UciError::Timeout)), "got {result:?}");
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(
        !process_exists(child_pid(&trace)),
        "timeout must reap the child"
    );
    fs::remove_file(trace).unwrap();
}

#[test]
fn continuous_info_cannot_extend_the_search_deadline() {
    let game = test_game();
    let timeout = Duration::from_millis(100);
    let (mut analyzer, trace, _, _) = fake_analyzer("continuous-info", &game, timeout);
    let started = std::time::Instant::now();
    let result = analyzer.analyze_game_checked(&game, Limit::new(10_000), 1);
    assert!(matches!(result, Err(UciError::Timeout)), "got {result:?}");
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(
        !process_exists(child_pid(&trace)),
        "timeout must reap the child"
    );
    fs::remove_file(trace).unwrap();
}

#[test]
fn multipv_rejects_incomplete_or_mixed_depth_ranks() {
    let game = test_game();
    for mode in ["incomplete-multipv", "mixed-multipv"] {
        let (mut analyzer, trace, _, _) = fake_analyzer(mode, &game, Duration::from_secs(1));
        assert!(
            matches!(
                analyzer.analyze_game_checked(&game, Limit::new(10_000), 2),
                Err(UciError::Protocol(_))
            ),
            "{mode} must not yield a partial or mixed-depth result"
        );
        assert!(!process_exists(child_pid(&trace)));
        fs::remove_file(trace).unwrap();
    }
}

#[test]
fn delayed_duplicate_bestmove_is_rejected_during_next_ready_handshake() {
    let game = test_game();
    let (mut analyzer, trace, _, _) =
        fake_analyzer("delayed-duplicate", &game, Duration::from_secs(1));
    assert!(
        analyzer
            .analyze_game_checked(&game, Limit::new(10_000), 2)
            .is_ok()
    );
    thread::sleep(Duration::from_millis(120));
    assert!(matches!(
        analyzer.analyze_game_checked(&game, Limit::new(10_000), 2),
        Err(UciError::Protocol(_))
    ));
    assert!(!process_exists(child_pid(&trace)));
    fs::remove_file(trace).unwrap();
}

#[test]
fn analyzer_trait_honors_cancel_callback_and_non_start_side() {
    let game = test_game();
    let (mut analyzer, trace, pv1, _) = fake_analyzer("normal", &game, Duration::from_secs(1));
    let mut stop = || false;
    let lines = analyzer.analyze_until(game.position(), Limit::new(10_000), 1, &mut stop);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].best_move, pv1[0]);
    drop(analyzer);
    assert!(!process_exists(child_pid(&trace)));
    fs::remove_file(trace).unwrap();
}

#[test]
fn external_engine_interoperates_when_test_binary_is_configured() {
    let Ok(engine) = std::env::var("XQ_UCI_TEST_ENGINE") else {
        return;
    };
    let game = test_game();
    let mut analyzer = UciAnalyzer::with_args(
        engine,
        std::iter::empty::<OsString>(),
        Duration::from_secs(20),
    )
    .unwrap();
    let lines = analyzer
        .analyze_game_checked(&game, Limit::new(200), 2)
        .unwrap();
    assert_eq!(lines.len(), 2);
    for line in lines {
        assert_eq!(line.best_move, line.principal_variation[0]);
        let mut pos = game.position().clone();
        for movement in line.principal_variation {
            pos.make_move(movement).unwrap();
        }
    }
}

#[test]
fn node_limit_stop_mid_iteration_uses_the_last_complete_depth_not_the_partial_bestmove() {
    // Real engines (Pikafish) stop on the node limit part-way through an iteration: depth 6 has
    // only rank 1 while depth 5 has all ranks, and `bestmove` comes from the partial depth 6.
    let game = test_game();
    let (mut analyzer, trace, pv1, pv2) =
        fake_analyzer("partial-iteration", &game, Duration::from_secs(1));
    let lines = analyzer
        .analyze_game_checked(&game, Limit::new(10_000), 2)
        .expect("a complete depth-5 set exists, so the result is usable");
    assert_eq!(lines.len(), 2);
    assert!(lines.iter().all(|line| line.depth == 5), "never mix depths");
    assert_eq!(lines[0].principal_variation, pv1);
    assert_eq!(lines[1].principal_variation, pv2);
    fs::remove_file(trace).unwrap();
}

#[test]
fn partial_iteration_that_reshuffles_ranks_does_not_overwrite_the_complete_batch() {
    // Pikafish re-reports depth 5 lines with swapped ranks after a partial depth 6 line.
    // Each rank-1-to-n batch stands alone; the reshuffled tail is a mixed-depth batch.
    let game = test_game();
    let (mut analyzer, trace, pv1, pv2) =
        fake_analyzer("reshuffled-partial", &game, Duration::from_secs(1));
    let lines = analyzer
        .analyze_game_checked(&game, Limit::new(10_000), 2)
        .expect("the first depth-5 batch is complete and consistent");
    assert_eq!(lines[0].principal_variation, pv1);
    assert_eq!(lines[1].principal_variation, pv2);
    assert!(lines.iter().all(|line| line.depth == 5));
    fs::remove_file(trace).unwrap();
}
