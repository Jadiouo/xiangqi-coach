use std::io::{self, BufRead, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;
use xq_core::GameOutcome;
use xq_core::Side;
use xq_core::{Game, Move, PieceKind, Position, format_chinese_move, import_record};
use xq_engine::difficulty::{DifficultyRequest, choose_move_with_progress};
use xq_engine::{SearchConfig, SearchLine, Searcher};
use xq_review::{Analyzer, Limit, Line, PlyAnalysis, PlyInput, ReviewError, review_one_move};
use xq_uci::{UciAnalyzer, UciError};

mod locale;
mod spar;

struct ReviewCliError {
    code: &'static str,
    message: String,
    cause: String,
}

impl ReviewCliError {
    fn new(code: &'static str, cause: impl Into<String>) -> Self {
        Self {
            code,
            message: locale::review_error_message(code).to_owned(),
            cause: cause.into(),
        }
    }

    fn with_message(code: &'static str, message: String, cause: impl Into<String>) -> Self {
        Self {
            code,
            message,
            cause: cause.into(),
        }
    }
}

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args
        .first()
        .is_some_and(|arg| matches!(arg.as_str(), "--help" | "-h"))
        && args.len() == 1
    {
        print!("{}", locale::ROOT_HELP);
        return;
    }
    if args.first().is_some_and(|arg| arg == "review") {
        if args[1..]
            .iter()
            .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
        {
            if let Some(argument) = find_unknown_review_argument(&args[1..]) {
                let error = ReviewCliError::with_message(
                    "invalid_arguments",
                    locale::argument_error(locale::ArgumentProblem::UnknownOption, Some(argument)),
                    format!("unknown option {argument}"),
                );
                eprintln!(
                    "{}",
                    serde_json::to_string(&locale::review_error(
                        error.code,
                        &error.message,
                        &error.cause
                    ))
                    .expect("CLI error JSON is serializable")
                );
                std::process::exit(1);
            }
            print!("{}", locale::REVIEW_HELP);
            return;
        }
        if let Err(error) = run_review_cli(&args[1..]) {
            eprintln!(
                "{}",
                serde_json::to_string(&locale::review_error(
                    error.code,
                    &error.message,
                    &error.cause
                ))
                .expect("CLI error JSON is serializable")
            );
            std::process::exit(1);
        }
        return;
    }
    if args.first().is_some_and(|arg| arg == "spar") {
        if args[1..]
            .iter()
            .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
        {
            print!("{}", locale::SPAR_HELP);
            return;
        }
        if let Err(error) = spar::run(&args[1..]) {
            eprintln!(
                "{}",
                serde_json::to_string(&locale::review_error(
                    error.code,
                    &error.message,
                    &error.cause
                ))
                .expect("CLI error JSON is serializable")
            );
            std::process::exit(1);
        }
        return;
    }
    if let Some(argument) = args.first() {
        let (code, message, cause) = if argument.starts_with('-') {
            let argument = args
                .iter()
                .find(|arg| !matches!(arg.as_str(), "--help" | "-h"))
                .unwrap_or(argument);
            (
                "invalid_arguments",
                locale::unexpected_global_argument_error(argument),
                format!("unexpected global argument {argument}"),
            )
        } else {
            (
                "unknown_command",
                locale::unknown_command_error(argument),
                format!("unknown command {argument}"),
            )
        };
        eprintln!(
            "{}",
            serde_json::to_string(&locale::review_error(code, &message, &cause))
                .expect("CLI error JSON is serializable")
        );
        std::process::exit(1);
    }
    let stdin = io::stdin();
    let mut game = Game::new(Position::startpos());
    let mut multipv = 1_usize;
    let mut strategy = "search".to_owned();
    let mut difficulty_level = 10_u8;
    let mut random_seed = 1_u64;
    let mut use_root_alpha = true;
    let mut use_check_extensions = true;
    let mut use_killer_history_ordering = true;
    let mut worker: Option<(JoinHandle<Option<u64>>, Arc<AtomicBool>)> = None;
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let mut words = line.split_whitespace();
        match words.next().unwrap_or("") {
            "uci" => {
                println!("id name xiangqi-coach");
                println!("id author xiangqi-coach contributors");
                println!("option name UCI_Variant type combo default xiangqi var xiangqi");
                println!("option name MultiPV type spin default 1 min 1 max 16");
                println!(
                    "option name Strategy type combo default search var search var random var greedy var difficulty"
                );
                println!("option name DifficultyLevel type spin default 10 min 1 max 10");
                println!(
                    "option name RandomSeed type spin default 1 min 0 max 18446744073709551615"
                );
                println!("option name RootAlpha type check default true");
                println!("option name CheckExtensions type check default true");
                println!("option name KillerHistoryOrdering type check default true");
                println!("uciok");
            }
            "isready" => println!("readyok"),
            "ucinewgame" => {
                stop_worker(&mut worker, &mut random_seed);
                game = Game::new(Position::startpos());
            }
            "setoption" => {
                stop_worker(&mut worker, &mut random_seed);
                let args: Vec<_> = words.collect();
                if args.first() == Some(&"name") && args.get(1) == Some(&"UCI_Variant") {
                    if args.get(2) != Some(&"value") || args.get(3) != Some(&"xiangqi") {
                        let value = args.get(3).copied().unwrap_or("<missing>");
                        println!("info string unsupported variant {value}");
                    }
                } else if args.first() == Some(&"name")
                    && args.get(1) == Some(&"MultiPV")
                    && args.get(2) == Some(&"value")
                {
                    multipv = args
                        .get(3)
                        .and_then(|value| value.parse::<usize>().ok())
                        .unwrap_or(1)
                        .clamp(1, 16);
                } else if args.first() == Some(&"name")
                    && args.get(1) == Some(&"Strategy")
                    && args.get(2) == Some(&"value")
                {
                    if let Some(value) = args.get(3).filter(|value| {
                        matches!(**value, "search" | "random" | "greedy" | "difficulty")
                    }) {
                        strategy = (*value).to_owned();
                    }
                } else if args.first() == Some(&"name")
                    && args.get(1) == Some(&"DifficultyLevel")
                    && args.get(2) == Some(&"value")
                {
                    let value = args.get(3).and_then(|value| value.parse::<u8>().ok());
                    if let Some(value @ 1..=10) = value {
                        difficulty_level = value;
                    } else {
                        println!(
                            "info string invalid DifficultyLevel value {}",
                            args.get(3).copied().unwrap_or("<missing>")
                        );
                    }
                } else if args.first() == Some(&"name")
                    && args.get(1) == Some(&"RandomSeed")
                    && args.get(2) == Some(&"value")
                {
                    random_seed = args
                        .get(3)
                        .and_then(|value| value.parse::<u64>().ok())
                        .unwrap_or(1);
                } else if args.first() == Some(&"name")
                    && matches!(
                        args.get(1),
                        Some(&"RootAlpha" | &"CheckExtensions" | &"KillerHistoryOrdering")
                    )
                {
                    let name = args.get(1).copied().unwrap_or("<missing>");
                    let value = args.get(3).copied().unwrap_or("<missing>");
                    match value {
                        "true" => match name {
                            "RootAlpha" => use_root_alpha = true,
                            "CheckExtensions" => use_check_extensions = true,
                            "KillerHistoryOrdering" => use_killer_history_ordering = true,
                            _ => unreachable!("the option name was filtered above"),
                        },
                        "false" => match name {
                            "RootAlpha" => use_root_alpha = false,
                            "CheckExtensions" => use_check_extensions = false,
                            "KillerHistoryOrdering" => use_killer_history_ordering = false,
                            _ => unreachable!("the option name was filtered above"),
                        },
                        _ => println!("info string invalid boolean option {name} value {value}"),
                    }
                }
            }
            "position" => {
                stop_worker(&mut worker, &mut random_seed);
                match read_position(words.collect()) {
                    Ok(next) => game = next,
                    Err(message) => println!("info string position error: {message}"),
                }
            }
            "go" => {
                stop_worker(&mut worker, &mut random_seed);
                let args: Vec<_> = words.collect();
                if let Some(index) = args.iter().position(|word| *word == "perft") {
                    let depth = args
                        .get(index + 1)
                        .and_then(|n| n.parse::<u8>().ok())
                        .unwrap_or(1);
                    println!("Nodes searched: {}", game.position().perft(depth));
                } else {
                    if let Some(outcome) = game.outcome() {
                        let label = match outcome {
                            GameOutcome::Draw => "draw",
                            GameOutcome::Win(Side::Red) => "red",
                            GameOutcome::Win(Side::Black) => "black",
                        };
                        println!("info string outcome {label}");
                        println!("bestmove 0000");
                        let _ = io::stdout().flush();
                        continue;
                    }
                    if strategy == "random" || strategy == "greedy" {
                        let movement = strategy_move(&game, &strategy, &mut random_seed);
                        println!("info depth 0 score cp 0 nodes 0");
                        println!(
                            "bestmove {}",
                            movement
                                .map_or_else(|| "0000".to_owned(), |movement| movement.to_iccs())
                        );
                        let _ = io::stdout().flush();
                        continue;
                    }
                    let nodes = args
                        .iter()
                        .position(|word| *word == "nodes")
                        .and_then(|index| args.get(index + 1))
                        .and_then(|value| value.parse::<u64>().ok())
                        .unwrap_or(100_000);
                    let depth = args
                        .iter()
                        .position(|word| *word == "depth")
                        .and_then(|index| args.get(index + 1))
                        .and_then(|value| value.parse::<u8>().ok())
                        .unwrap_or(SearchConfig::default().max_depth);
                    let stop = Arc::new(AtomicBool::new(false));
                    let worker_stop = Arc::clone(&stop);
                    let search_game = game.clone();
                    let line_count = multipv;
                    let root_alpha = use_root_alpha;
                    let check_extensions = use_check_extensions;
                    let killer_history_ordering = use_killer_history_ordering;
                    let selected_strategy = strategy.clone();
                    let selected_level = difficulty_level;
                    let seed = random_seed;
                    let handle = std::thread::spawn(move || {
                        let config = SearchConfig {
                            node_limit: nodes,
                            max_depth: depth,
                            use_root_alpha: root_alpha,
                            use_check_extensions: check_extensions,
                            use_killer_history_ordering: killer_history_ordering,
                            ..SearchConfig::default()
                        };
                        let next_rng_state = if selected_strategy == "difficulty" {
                            let decision = choose_move_with_progress(
                                &search_game,
                                DifficultyRequest {
                                    level: selected_level,
                                    rng_state: seed,
                                    search_config: config,
                                    node_limit: nodes,
                                },
                                || worker_stop.load(Ordering::Relaxed),
                                |completed_depth, completed_nodes, lines| {
                                    print_multipv_info(
                                        completed_depth,
                                        completed_nodes,
                                        lines,
                                        line_count,
                                    );
                                    let _ = io::stdout().flush();
                                },
                            );
                            match decision {
                                Ok(decision) => {
                                    if selected_level == 10
                                        && let Some(result) = decision.search_result
                                    {
                                        print_search_info(&result);
                                    }
                                    if let Some(movement) = decision.selected_move {
                                        println!(
                                            "info string difficulty-selected {} level {}",
                                            movement.to_iccs(),
                                            selected_level
                                        );
                                        println!("bestmove {}", movement.to_iccs());
                                    } else {
                                        println!("bestmove 0000");
                                    }
                                    Some(decision.rng_state)
                                }
                                Err(_) => {
                                    println!("info string invalid difficulty level");
                                    println!("bestmove 0000");
                                    None
                                }
                            }
                        } else if line_count > 1 {
                            let searcher = Searcher::new(config);
                            let lines = searcher.search_multipv_with_progress(
                                &search_game,
                                line_count,
                                || worker_stop.load(Ordering::Relaxed),
                                |completed_depth, nodes, lines| {
                                    print_multipv_info(completed_depth, nodes, lines, line_count);
                                    let _ = io::stdout().flush();
                                },
                            );
                            println!(
                                "bestmove {}",
                                lines.first().map_or_else(
                                    || "0000".to_owned(),
                                    |line| line.best_move.to_iccs()
                                )
                            );
                            None
                        } else {
                            let searcher = Searcher::new(config);
                            let result = searcher.search_game_until(&search_game, || {
                                worker_stop.load(Ordering::Relaxed)
                            });
                            print_search_info(&result);
                            println!(
                                "bestmove {}",
                                result.best_move.map_or_else(
                                    || "0000".to_owned(),
                                    |movement| movement.to_iccs()
                                )
                            );
                            None
                        };
                        let _ = io::stdout().flush();
                        next_rng_state
                    });
                    worker = Some((handle, stop));
                }
            }
            "stop" => stop_worker(&mut worker, &mut random_seed),
            "quit" => {
                stop_worker(&mut worker, &mut random_seed);
                break;
            }
            "" => {}
            _ => println!("info string unknown command"),
        }
        let _ = io::stdout().flush();
    }
    stop_worker(&mut worker, &mut random_seed);
}

fn find_unknown_review_argument(args: &[String]) -> Option<&str> {
    let mut index = 0;
    while index < args.len() {
        let argument = args[index].as_str();
        let consumes_value = match argument {
            "--record" | "--engine" | "--nodes" | "--deep-nodes" | "--timeout-ms" => true,
            "--help" | "-h" => false,
            _ => return Some(argument),
        };
        let has_value = consumes_value
            && args
                .get(index + 1)
                .is_some_and(|value| !value.starts_with('-'));
        index += 1 + usize::from(has_value);
    }
    None
}

fn run_review_cli(args: &[String]) -> Result<(), ReviewCliError> {
    let mut record_path = None;
    let mut engine_path = None;
    let mut quick_nodes = 1_000_u64;
    let mut deep_nodes = 10_000_u64;
    let mut timeout_ms = 30_000_u64;
    let mut index = 0;
    while index < args.len() {
        let (target, option) = match args[index].as_str() {
            "--record" => (&mut record_path, "--record"),
            "--engine" => (&mut engine_path, "--engine"),
            "--nodes" => {
                quick_nodes = parse_cli_value(args, index, "--nodes")?;
                index += 2;
                continue;
            }
            "--deep-nodes" => {
                deep_nodes = parse_cli_value(args, index, "--deep-nodes")?;
                index += 2;
                continue;
            }
            "--timeout-ms" => {
                timeout_ms = parse_cli_value(args, index, "--timeout-ms")?;
                index += 2;
                continue;
            }
            other => {
                return Err(ReviewCliError::with_message(
                    "invalid_arguments",
                    locale::argument_error(locale::ArgumentProblem::UnknownOption, Some(other)),
                    format!("unknown option {other}"),
                ));
            }
        };
        *target = Some(
            args.get(index + 1)
                .ok_or_else(|| {
                    ReviewCliError::with_message(
                        "invalid_arguments",
                        locale::argument_error(locale::ArgumentProblem::MissingValue, Some(option)),
                        format!("missing value for {option}"),
                    )
                })?
                .clone(),
        );
        index += 2;
    }
    let record_path = record_path.ok_or_else(|| {
        ReviewCliError::with_message(
            "invalid_arguments",
            locale::argument_error(locale::ArgumentProblem::MissingRequired, Some("--record")),
            "required option --record is missing",
        )
    })?;
    let engine_path = engine_path.ok_or_else(|| {
        ReviewCliError::with_message(
            "invalid_arguments",
            locale::argument_error(locale::ArgumentProblem::MissingRequired, Some("--engine")),
            "required option --engine is missing",
        )
    })?;
    if quick_nodes == 0 || deep_nodes == 0 || timeout_ms == 0 {
        return Err(ReviewCliError::with_message(
            "invalid_arguments",
            locale::argument_error(locale::ArgumentProblem::MustBePositive, None),
            "node limits and timeout must be greater than zero",
        ));
    }

    let record_text = std::fs::read_to_string(&record_path).map_err(|error| {
        ReviewCliError::with_message(
            "record_read_failed",
            locale::record_read_error(&record_path),
            format!("cannot read record {record_path}: {error}"),
        )
    })?;
    let imported = import_record(&record_text);
    let import_diagnostic = imported.error.as_ref().map(|error| {
        (
            error.step,
            error.token.clone(),
            error.message_zh(),
            format!(
                "record import failed at step {} token {:?}: {}",
                error.step,
                error.token,
                error.message_zh()
            ),
            error.raw_source_bytes().map(|bytes| {
                bytes
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            }),
        )
    });
    if imported.moves.is_empty()
        && imported
            .warnings
            .contains(&xq_core::ImportWarning::VariationsNotImported)
    {
        return Err(ReviewCliError::with_message(
            "record_import_failed",
            locale::empty_mainline_after_variation(),
            "record has no mainline: variations_not_imported begins at record 1",
        ));
    }
    if let Some((step, token, message, cause, _raw_bytes_hex)) = &import_diagnostic
        && imported.moves.is_empty()
    {
        return Err(ReviewCliError::with_message(
            "record_import_failed",
            locale::record_import_error(*step, token, message),
            cause.clone(),
        ));
    }
    if imported.moves.is_empty() {
        return Err(ReviewCliError::with_message(
            "record_import_failed",
            locale::empty_record_error(),
            "record contains no legal mainline moves",
        ));
    }
    let (format, format_label) = locale::format_metadata(imported.format);
    let mut game = Game::new(imported.initial_position.clone());
    let mut plies = Vec::with_capacity(imported.moves.len());
    for movement in &imported.moves {
        plies.push(PlyInput::new(game.clone(), *movement));
        game.play(*movement).map_err(|error| {
            ReviewCliError::new(
                "record_replay_failed",
                format!("record replay failed: {error}"),
            )
        })?;
    }

    let mut analyzer = UciAnalyzer::with_args(
        &engine_path,
        std::iter::empty::<&std::ffi::OsStr>(),
        Duration::from_millis(timeout_ms),
    )
    .map_err(|error| {
        ReviewCliError::with_message(
            "engine_start_failed",
            locale::engine_start_error(&engine_path),
            format!("cannot start UCI engine: {error}"),
        )
    })?;
    let analyzer_name = analyzer.name();
    let mut quick_results = Vec::with_capacity(plies.len());
    for (index, input) in plies.iter().enumerate() {
        quick_results.push(
            analyze_checked_ply(
                &mut analyzer,
                &input.game,
                input.played_move,
                Limit::new(quick_nodes),
            )
            .map_err(|error| engine_analysis_cli_error(index + 1, "quick", error))?,
        );
    }
    let mut deep_results = vec![None; plies.len()];
    for (index, input) in plies.iter().enumerate() {
        if quick_results[index].loss_percent > 5.0 {
            deep_results[index] = Some(
                analyze_checked_ply(
                    &mut analyzer,
                    &input.game,
                    input.played_move,
                    Limit::new(deep_nodes),
                )
                .map_err(|error| engine_analysis_cli_error(index + 1, "deep", error))?,
            );
        }
    }

    let mut output_plies = Vec::with_capacity(plies.len());
    let mut notations = Vec::with_capacity(plies.len());
    let mut boards = vec![imported.initial_position.board_ascii()];
    for (index, input) in plies.iter().enumerate() {
        let quick_result = &quick_results[index];
        let (side, side_label) = locale::side_metadata(input.game.position().side_to_move());
        let final_result = deep_results[index].as_ref().unwrap_or(quick_result);
        notations.push(
            format_chinese_move(input.game.position(), input.played_move).map_err(|error| {
                ReviewCliError::new(
                    "record_replay_failed",
                    format!("notation failed: {error:?}"),
                )
            })?,
        );
        let mut after = input.game.clone();
        after.play(input.played_move).map_err(|error| {
            ReviewCliError::new(
                "record_replay_failed",
                format!("record replay failed: {error}"),
            )
        })?;
        boards.push(after.position().board_ascii());
        output_plies.push(serde_json::json!({
            "ply": index + 1,
            "side": side,
            "side_label": side_label,
            "played_move": input.played_move.to_iccs(),
            "quick": {
                "result": ply_review_json(quick_result),
                "candidates": candidate_lines_json(&quick_result.candidates),
                "candidate_count": quick_result.candidates.len(),
            },
            "final": {
                "deepened": deep_results[index].is_some(),
                "result": ply_review_json(final_result),
                "candidates": candidate_lines_json(&final_result.candidates),
                "candidate_count": final_result.candidates.len(),
            },
        }));
    }
    let output = serde_json::json!({
        "import_status": if import_diagnostic.is_some() { "partial" } else { "complete" },
        "import_diagnostic": import_diagnostic.as_ref().map(|(step, token, message, _cause, raw_bytes_hex)| {
            let token_utf8_hex = token.as_bytes().iter().map(|byte| format!("{byte:02x}")).collect::<String>();
            let raw_chunk_bytes_hex = raw_bytes_hex.as_ref().unwrap_or(&token_utf8_hex);
            serde_json::json!({
                "code": "record_import_failed",
                "step": step,
                "token": token,
                "token_utf8_hex": token_utf8_hex,
                "raw_chunk_bytes_hex": raw_chunk_bytes_hex,
                "message": locale::record_import_error(*step, token, message),
            })
        }),
        "source": {
            "path": record_path,
            "format": format,
            "format_label": format_label,
            "imported_plies": imported.moves.len(),
            "is_standard_start": imported.is_standard_start,
            "warnings": imported.warnings.iter().map(|warning| locale::warning_metadata(*warning)).collect::<Vec<_>>(),
        },
        "schema_version": 1,
        "schema_ids": {
            "format": "iccs|chinese|pgn|dhtml_xq|unknown",
            "side": "red|black",
            "classification": "unclassified|good|unique_move|inaccuracy|doubtful_move|mistake|blunder|missed_mate",
            "warning": "variations_not_imported",
        },
        "start_fen": imported.initial_position.to_fen(),
        "result": match game.outcome() {
            Some(GameOutcome::Win(Side::Red)) => "red_win",
            Some(GameOutcome::Win(Side::Black)) => "black_win",
            Some(GameOutcome::Draw) => "draw",
            None => "unknown",
        },
        "moves": imported.moves.iter().map(|movement| movement.to_iccs()).collect::<Vec<_>>(),
        "notations": notations,
        "boards": boards,
        "analyzer": analyzer_name,
        "limits": { "quick_nodes": quick_nodes, "deep_nodes": deep_nodes, "timeout_ms": timeout_ms },
        "cancelled": false,
        "plies": output_plies,
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&output)
            .map_err(|error| { ReviewCliError::new("output_failed", error.to_string()) })?
    );
    if let Some((step, token, message, cause, _raw_bytes_hex)) = import_diagnostic {
        return Err(ReviewCliError::with_message(
            "record_import_failed",
            locale::record_import_error(step, &token, &message),
            cause,
        ));
    }
    Ok(())
}

/// Routes `xq-review`'s ply logic through the checked UCI calls, so the review rules
/// live in one place while an engine failure still keeps its original cause.
struct CheckedAnalyzer<'a> {
    inner: &'a mut UciAnalyzer,
    failure: Option<UciError>,
}

impl Analyzer for CheckedAnalyzer<'_> {
    fn analyze(&mut self, pos: &Position, limit: Limit, multipv: usize) -> Vec<Line> {
        self.inner.analyze(pos, limit, multipv)
    }

    fn analyze_game(&mut self, game: &Game, limit: Limit, multipv: usize) -> Vec<Line> {
        match self.inner.analyze_game_checked(game, limit, multipv) {
            Ok(lines) => lines,
            Err(error) => {
                self.failure.get_or_insert(error);
                Vec::new()
            }
        }
    }

    fn name(&self) -> String {
        self.inner.name()
    }
}

fn analyze_checked_ply(
    analyzer: &mut UciAnalyzer,
    game: &Game,
    played_move: Move,
    limit: Limit,
) -> Result<PlyAnalysis, String> {
    let mut probe = game.position().clone();
    if probe.legal_moves().is_empty() || game.outcome().is_some() {
        return Err("cannot analyze a terminal position".to_owned());
    }
    let mut checked = CheckedAnalyzer {
        inner: analyzer,
        failure: None,
    };
    review_one_move(&mut checked, game, played_move, limit).map_err(|error| {
        match (checked.failure.take(), error) {
            (Some(cause), _) => format!("engine: {cause}"),
            (None, ReviewError::IllegalPlayedMove) => "record move became illegal".to_owned(),
            (None, other) => format!("review failed: {other:?}"),
        }
    })
}

fn parse_cli_value(args: &[String], index: usize, option: &str) -> Result<u64, ReviewCliError> {
    args.get(index + 1)
        .ok_or_else(|| {
            ReviewCliError::with_message(
                "invalid_arguments",
                locale::argument_error(locale::ArgumentProblem::MissingValue, Some(option)),
                format!("missing value for {option}"),
            )
        })?
        .parse::<u64>()
        .map_err(|_| {
            ReviewCliError::with_message(
                "invalid_arguments",
                locale::argument_error(locale::ArgumentProblem::InvalidInteger, Some(option)),
                format!("invalid integer for {option}"),
            )
        })
}

fn engine_analysis_cli_error(ply: usize, pass: &str, cause: String) -> ReviewCliError {
    let failure = if cause.contains("Timeout") {
        locale::EngineFailure::Timeout
    } else if cause.contains("Protocol") || cause.contains("invalid bestmove") {
        locale::EngineFailure::Protocol
    } else if cause.contains("EngineExited") {
        locale::EngineFailure::Exited
    } else if cause.contains("Cancelled") {
        locale::EngineFailure::Cancelled
    } else if cause.contains("Io(") {
        locale::EngineFailure::Io
    } else {
        locale::EngineFailure::Other
    };
    ReviewCliError::with_message(
        "engine_analysis_failed",
        locale::engine_analysis_error(ply, pass, failure),
        format!("engine {pass} analysis failed at ply {ply}: {cause}"),
    )
}

fn candidate_lines_json(lines: &[xq_review::Line]) -> serde_json::Value {
    serde_json::Value::Array(
        lines
            .iter()
            .map(|line| {
                let pv = line
                    .principal_variation
                    .iter()
                    .map(|movement| movement.to_iccs())
                    .collect::<Vec<_>>();
                serde_json::json!({
                    "best_move": line.best_move.to_iccs(),
                    "score": { "centipawns": line.score.centipawns, "mate_in": line.score.mate_in },
                    "principal_variation": pv,
                    "depth": line.depth,
                    "nodes": line.nodes,
                    "pv_end": xq_review::pv_end_id(line.pv_end),
                    "pv_length": line.principal_variation.len(),
                    "six_move_target_met": line.principal_variation.len() >= 6,
                    "pv_status": if line.principal_variation.len() >= 6 { "at_least_six_moves" } else { "short_unconfirmed" },
                })
            })
            .collect(),
    )
}

fn ply_review_json(review: &xq_review::PlyAnalysis) -> serde_json::Value {
    let (classification, classification_label) =
        locale::classification_metadata(review.classification);
    serde_json::json!({
        "best_move": review.best_move.to_iccs(),
        "played_move": review.played_move.to_iccs(),
        "played_rank": review.played_rank,
        "best_score": { "centipawns": review.best_score.centipawns, "mate_in": review.best_score.mate_in },
        "played_score": { "centipawns": review.played_score.centipawns, "mate_in": review.played_score.mate_in },
        "best_win_probability": review.best_win_probability,
        "played_win_probability": review.played_win_probability,
        "loss_percent": review.loss_percent,
        "classification": classification,
        "classification_label": classification_label,
        "reason": review.reason.as_ref().map(|reason| serde_json::json!({
            "kind": match reason.kind {
                xq_review::ReasonKind::WalkedIntoMate => "walked_into_mate",
                xq_review::ReasonKind::MissedMate => "missed_mate",
                xq_review::ReasonKind::DroppedMaterial => "dropped_material",
                xq_review::ReasonKind::MissedMaterial => "missed_material",
                xq_review::ReasonKind::SentPiece => "sent_piece",
                xq_review::ReasonKind::CannonMount => "cannon_mount",
                xq_review::ReasonKind::AbandonedProtection => "abandoned_protection",
                xq_review::ReasonKind::CheckCapture => "check_capture",
                xq_review::ReasonKind::PositionType => "position_type",
            },
            "moves": reason.moves,
        })),
        "comparison": review.comparison.as_ref().map(comparison_json),
    })
}

fn comparison_json(comparison: &xq_review::MoveComparison) -> serde_json::Value {
    let steps = |steps: &[xq_review::LineStep]| {
        steps
            .iter()
            .map(|step| {
                serde_json::json!({
                    "iccs": step.mv.to_iccs(),
                    "notation": step.notation,
                    "side": if step.side == xq_core::Side::Red { "red" } else { "black" },
                    "captured": step.captured.map(|piece| serde_json::json!({
                        "side": if piece.side == xq_core::Side::Red { "red" } else { "black" },
                        "kind": format!("{:?}", piece.kind).to_lowercase(),
                    })),
                })
            })
            .collect::<Vec<_>>()
    };
    serde_json::json!({
        "played_line": steps(&comparison.played_line),
        "best_line": steps(&comparison.best_line),
        "played_complete": comparison.played_complete,
        "best_complete": comparison.best_complete,
        "played_settled": comparison.played_settled,
        "best_settled": comparison.best_settled,
    })
}

fn print_multipv_info(depth: u8, nodes: u64, lines: &[SearchLine], max_lines: usize) {
    for (index, line) in lines.iter().take(max_lines).enumerate() {
        if let Some(mate) = line.mate_in {
            let mate = if line.score < 0 {
                -i32::from(mate)
            } else {
                i32::from(mate)
            };
            println!(
                "info multipv {} depth {} score mate {} nodes {} pv {}",
                index + 1,
                depth,
                mate,
                nodes,
                line.best_move.to_iccs()
            );
        } else {
            println!(
                "info multipv {} depth {} score cp {} nodes {} pv {}",
                index + 1,
                depth,
                line.score,
                nodes,
                line.best_move.to_iccs()
            );
        }
    }
}

fn print_search_info(result: &xq_engine::SearchResult) {
    let pv = result.best_move.map_or_else(String::new, |movement| {
        format!(" pv {}", movement.to_iccs())
    });
    if let Some(mate) = result.mate_in {
        let mate = if result.score < 0 {
            -i32::from(mate)
        } else {
            i32::from(mate)
        };
        println!(
            "info depth {} score mate {} nodes {}{pv}",
            result.depth, mate, result.nodes
        );
    } else {
        println!(
            "info depth {} score cp {} nodes {}{pv}",
            result.depth, result.score, result.nodes
        );
    }
}

fn strategy_move(game: &Game, strategy: &str, random_seed: &mut u64) -> Option<Move> {
    let mut position = game.position().clone();
    let mut moves = position.legal_moves();
    moves.sort_by_key(|movement| movement.to_iccs());
    if moves.is_empty() {
        return None;
    }
    if strategy == "random" {
        let count = moves.len() as u64;
        loop {
            let word = splitmix64_next(random_seed);
            if let Some(index) = bounded_random_index(word, count, 1_u128 << 64) {
                return Some(moves[index]);
            }
        }
    }
    let value = |kind: PieceKind| match kind {
        PieceKind::King => 0,
        PieceKind::Advisor | PieceKind::Elephant => 120,
        PieceKind::Horse | PieceKind::Cannon => 300,
        PieceKind::Rook => 600,
        PieceKind::Pawn => 70,
    };
    moves.into_iter().max_by_key(|movement| {
        let capture = position
            .piece_at(movement.to)
            .map_or(0, |piece| value(piece.kind));
        (capture, std::cmp::Reverse(movement.to_iccs()))
    })
}

fn splitmix64_next(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut value = *state;
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn bounded_random_index(word: u64, count: u64, domain: u128) -> Option<usize> {
    if count == 0 || domain == 0 || u128::from(word) >= domain {
        return None;
    }
    let limit = domain - domain % u128::from(count);
    (u128::from(word) < limit).then_some((word % count) as usize)
}

fn stop_worker(
    worker: &mut Option<(JoinHandle<Option<u64>>, Arc<AtomicBool>)>,
    random_seed: &mut u64,
) {
    if let Some((handle, stop)) = worker.take() {
        stop.store(true, Ordering::Relaxed);
        if let Ok(Some(next_seed)) = handle.join() {
            *random_seed = next_seed;
        }
    }
}

fn read_position(args: Vec<&str>) -> Result<Game, String> {
    let moves_index = args
        .iter()
        .position(|word| *word == "moves")
        .unwrap_or(args.len());
    let mut game = match args.first().copied() {
        Some("startpos") => Game::new(Position::startpos()),
        Some("fen") if args.len() >= 7 => {
            let fen = args[1..moves_index].join(" ");
            Game::new(Position::from_fen(&fen).map_err(|error| error.to_string())?)
        }
        _ => return Err("expected startpos or fen".to_owned()),
    };
    if moves_index < args.len() {
        for token in &args[moves_index + 1..] {
            let movement = Move::from_iccs(token).map_err(|error| error.to_string())?;
            game.play(movement).map_err(|error| error.to_string())?;
        }
    }
    Ok(game)
}

#[cfg(test)]
mod tests {
    use super::bounded_random_index;
    use super::locale::classification_metadata;
    use xq_review::Classification;

    #[test]
    fn bounded_random_rejection_is_uniform_over_a_small_full_domain() {
        let mut counts = [0_usize; 3];
        for word in 0..256 {
            if let Some(index) = bounded_random_index(word, 3, 256) {
                counts[index] += 1;
            }
        }
        assert_eq!(counts, [85, 85, 85]);
    }

    #[test]
    fn classification_ids_and_traditional_chinese_labels_cover_every_variant() {
        let mappings = [
            (Classification::Unclassified, ("unclassified", "未分類")),
            (Classification::Good, ("good", "好棋")),
            (Classification::UniqueMove, ("unique_move", "唯一著")),
            (Classification::Inaccuracy, ("inaccuracy", "緩著")),
            (Classification::DoubtfulMove, ("doubtful_move", "疑問手")),
            (Classification::Mistake, ("mistake", "失誤")),
            (Classification::Blunder, ("blunder", "大漏著")),
            (Classification::MissedMate, ("missed_mate", "錯過殺棋")),
        ];
        for (classification, expected) in mappings {
            assert_eq!(classification_metadata(classification), expected);
        }
    }
}
