//! `xq-uci spar`: the built-in engine against an external UCI engine (TEST_PLAN 5.4).
//! Process, file and report I/O live here, never in `xq-core` or `xq-engine`.

use std::time::Duration;

use xq_core::{Game, GameOutcome, Move, Position, Side};
use xq_engine::{SearchConfig, Searcher};
use xq_review::Limit;
use xq_uci::UciAnalyzer;

use super::{ReviewCliError, engine_analysis_cli_error, locale, parse_cli_value};

struct SparOptions {
    engine: String,
    openings: Option<String>,
    builtin_nodes: u64,
    engine_nodes: u64,
    max_plies: u64,
    timeout_ms: u64,
}

fn invalid(option: &str, problem: locale::ArgumentProblem) -> ReviewCliError {
    ReviewCliError::with_message(
        "invalid_arguments",
        locale::argument_error(problem, Some(option)),
        format!("invalid {option}"),
    )
}

fn parse_options(args: &[String]) -> Result<SparOptions, ReviewCliError> {
    let mut engine = None;
    let mut openings = None;
    let mut builtin_nodes = 10_000;
    let mut engine_nodes = 100;
    let mut max_plies = 300;
    let mut timeout_ms = 30_000;
    let mut index = 0;
    while index < args.len() {
        let option = args[index].as_str();
        match option {
            "--engine" | "--openings" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| invalid(option, locale::ArgumentProblem::MissingValue))?
                    .clone();
                if option == "--engine" {
                    engine = Some(value);
                } else {
                    openings = Some(value);
                }
            }
            "--nodes" => builtin_nodes = parse_cli_value(args, index, option)?,
            "--engine-nodes" => engine_nodes = parse_cli_value(args, index, option)?,
            "--max-plies" => max_plies = parse_cli_value(args, index, option)?,
            "--timeout-ms" => timeout_ms = parse_cli_value(args, index, option)?,
            other => {
                return Err(ReviewCliError::with_message(
                    "invalid_arguments",
                    locale::argument_error(locale::ArgumentProblem::UnknownOption, Some(other)),
                    format!("unknown option {other}"),
                ));
            }
        }
        index += 2;
    }
    let engine =
        engine.ok_or_else(|| invalid("--engine", locale::ArgumentProblem::MissingRequired))?;
    if builtin_nodes == 0 || engine_nodes == 0 || max_plies == 0 || timeout_ms == 0 {
        return Err(ReviewCliError::with_message(
            "invalid_arguments",
            locale::argument_error(locale::ArgumentProblem::MustBePositive, None),
            "node limits, max plies and timeout must be greater than zero",
        ));
    }
    Ok(SparOptions {
        engine,
        openings,
        builtin_nodes,
        engine_nodes,
        max_plies,
        timeout_ms,
    })
}

/// One opening per line, ICCS moves separated by spaces; `#` starts a comment line.
fn read_openings(path: Option<&str>) -> Result<Vec<Vec<Move>>, ReviewCliError> {
    let Some(path) = path else {
        return Ok(vec![Vec::new()]);
    };
    let text = std::fs::read_to_string(path).map_err(|error| {
        ReviewCliError::with_message(
            "openings_read_failed",
            locale::spar_openings_read_error(path),
            format!("cannot read openings {path}: {error}"),
        )
    })?;
    let mut openings = Vec::new();
    for (number, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut game = Game::new(Position::startpos());
        let mut moves = Vec::new();
        for token in line.split_whitespace() {
            let problem = Move::from_iccs(token)
                .map_err(|error| format!("{error:?}"))
                .and_then(|movement| {
                    game.play(movement).map_err(|error| error.to_string())?;
                    moves.push(movement);
                    Ok(())
                });
            if let Err(problem) = problem {
                return Err(ReviewCliError::with_message(
                    "openings_invalid",
                    locale::spar_openings_invalid(number + 1, token),
                    format!("openings line {} move {token}: {problem}", number + 1),
                ));
            }
        }
        openings.push(moves);
    }
    if openings.is_empty() {
        return Ok(vec![Vec::new()]);
    }
    Ok(openings)
}

fn side_id(side: Side) -> &'static str {
    match side {
        Side::Red => "red",
        Side::Black => "black",
    }
}

pub fn run(args: &[String]) -> Result<(), ReviewCliError> {
    let options = parse_options(args)?;
    let openings = read_openings(options.openings.as_deref())?;
    let config = SearchConfig {
        node_limit: options.builtin_nodes,
        ..SearchConfig::default()
    };
    let mut engine_name = String::new();
    let mut games = Vec::new();
    for (opening_index, opening) in openings.iter().enumerate() {
        for builtin_side in [Side::Red, Side::Black] {
            let mut analyzer = UciAnalyzer::with_args(
                &options.engine,
                std::iter::empty::<&std::ffi::OsStr>(),
                Duration::from_millis(options.timeout_ms),
            )
            .map_err(|error| {
                ReviewCliError::with_message(
                    "engine_start_failed",
                    locale::engine_start_error(&options.engine),
                    format!("cannot start UCI engine: {error}"),
                )
            })?;
            engine_name = analyzer.name();
            let mut game = Game::new(Position::startpos());
            for movement in opening {
                game.play(*movement).expect("opening validated above");
            }
            let mut played: Vec<String> = opening.iter().map(|m| m.to_iccs()).collect();
            while game.outcome().is_none() && (played.len() as u64) < options.max_plies {
                let mover = game.position().side_to_move();
                let movement = if mover == builtin_side {
                    Searcher::new(config.clone())
                        .search_game_until(&game, || false)
                        .best_move
                        .ok_or_else(|| {
                            ReviewCliError::new(
                                "engine_analysis_failed",
                                format!(
                                    "built-in engine returned no move at ply {}",
                                    played.len() + 1
                                ),
                            )
                        })?
                } else {
                    analyzer
                        .analyze_game_checked(&game, Limit::new(options.engine_nodes), 1)
                        .map_err(|error| {
                            engine_analysis_cli_error(played.len() + 1, "spar", format!("{error}"))
                        })?
                        .first()
                        .map(|line| line.best_move)
                        .ok_or_else(|| {
                            engine_analysis_cli_error(
                                played.len() + 1,
                                "spar",
                                "Protocol: no analysis lines".to_owned(),
                            )
                        })?
                };
                game.play(movement).map_err(|error| {
                    ReviewCliError::new("engine_analysis_failed", format!("illegal move: {error}"))
                })?;
                played.push(movement.to_iccs());
            }
            let result = match game.outcome() {
                Some(GameOutcome::Win(winner)) if winner == builtin_side => "builtin_win",
                Some(GameOutcome::Win(_)) => "engine_win",
                Some(GameOutcome::Draw) => "draw",
                None => "unfinished",
            };
            games.push(serde_json::json!({
                "opening": opening_index,
                "builtin_side": side_id(builtin_side),
                "plies": played.len(),
                "moves": played,
                "result": result,
            }));
        }
    }
    let count = |name: &str| games.iter().filter(|game| game["result"] == name).count();
    let (wins, draws, losses, unfinished) = (
        count("builtin_win"),
        count("draw"),
        count("engine_win"),
        count("unfinished"),
    );
    let completed = wins + draws + losses;
    let report = serde_json::json!({
        "schema_version": 1,
        "engine": engine_name,
        "builtin_nodes": options.builtin_nodes,
        "engine_nodes": options.engine_nodes,
        "max_plies": options.max_plies,
        "timeout_ms": options.timeout_ms,
        "games": games,
        "summary": {
            "games": games.len(),
            "builtin_wins": wins,
            "draws": draws,
            "engine_wins": losses,
            "unfinished": unfinished,
            "builtin_score": if completed == 0 { serde_json::Value::Null }
                else { serde_json::json!((wins as f64 + 0.5 * draws as f64) / completed as f64) },
        },
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&report)
            .map_err(|error| ReviewCliError::new("output_failed", error.to_string()))?
    );
    Ok(())
}
