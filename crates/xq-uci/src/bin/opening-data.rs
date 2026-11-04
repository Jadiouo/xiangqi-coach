use serde_json::{Value, json};
use std::collections::HashMap;
use std::error::Error;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use xq_core::{Game, STARTPOS_FEN, import_record};

fn required_text<'a>(row: &'a Value, field: &str) -> Result<&'a str, String> {
    row.get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing string field `{field}`"))
}

fn main() {
    if let Err(error) = run() {
        eprintln!("opening-data: {error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 4 {
        return Err(
            "usage: opening-data INPUT.jsonl CANDIDATES.jsonl RUNNER.tsv REJECTIONS.jsonl".into(),
        );
    }
    let input = BufReader::new(File::open(&args[0])?);
    let mut candidates = BufWriter::new(File::create(&args[1])?);
    let mut runner = BufWriter::new(File::create(&args[2])?);
    let mut rejections = BufWriter::new(File::create(&args[3])?);
    writeln!(runner, "opening_id\tsource_ref\ticcs_prefix")?;

    let mut seen = HashMap::<String, String>::new();
    let mut candidate_count = 0usize;
    let mut rejected_count = 0usize;
    for (line_index, line) in input.lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let source = match serde_json::from_str::<Value>(&line) {
            Ok(source) => source,
            Err(error) => {
                write_rejection(
                    &mut rejections,
                    json!({
                        "schema_version": "m4-openings-v1",
                        "input_line": line_index + 1,
                        "reason": format!("invalid_json: {error}"),
                    }),
                )?;
                rejected_count += 1;
                continue;
            }
        };
        let source_name = match required_text(&source, "source_name") {
            Ok(value) => value.to_string(),
            Err(error) => {
                write_rejection(
                    &mut rejections,
                    json!({
                        "schema_version": "m4-openings-v1",
                        "input_line": line_index + 1,
                        "reason": error,
                        "source": source,
                    }),
                )?;
                rejected_count += 1;
                continue;
            }
        };
        let pgn = match required_text(&source, "pgn") {
            Ok(value) => value,
            Err(error) => {
                reject_source(&mut rejections, &source, &source_name, &error)?;
                rejected_count += 1;
                continue;
            }
        };
        let imported = import_record(pgn);
        if imported.format.is_none() || imported.format != Some(xq_core::NotationFormat::Pgn) {
            reject_source(
                &mut rejections,
                &source,
                &source_name,
                "not_pgn_or_unrecognized",
            )?;
            rejected_count += 1;
            continue;
        }
        if imported.initial_position.to_fen() != STARTPOS_FEN {
            reject_source(
                &mut rejections,
                &source,
                &source_name,
                "non_standard_initial_fen",
            )?;
            rejected_count += 1;
            continue;
        }
        if let Some(error) = &imported.error {
            let error_reason = match (error.kind, error.step) {
                (xq_core::ImportErrorKind::InvalidPosition, 0) => "invalid_source_fen",
                (xq_core::ImportErrorKind::GameOver, _) => {
                    "source_continues_after_terminal_position"
                }
                _ => "source_parse_error_after_legal_prefix",
            };
            write_rejection(
                &mut rejections,
                json!({
                    "schema_version": "m4-openings-v1",
                    "source_name": source_name,
                    "source_pgn_url": source.get("source_pgn_url"),
                    "reason": error_reason,
                    "step": error.step,
                    "token": error.token,
                    "kind": format!("{:?}", error.kind),
                    "message_zh": error.message_zh(),
                }),
            )?;
            rejected_count += 1;
        }

        let mut game = Game::new(imported.initial_position.clone());
        let max_cutoff = imported.moves.len().min(8);
        let mut ended_at = None;
        for (index, movement) in imported.moves.iter().copied().enumerate() {
            let ply = index + 1;
            if game.play(movement).is_err() {
                ended_at = Some(ply);
                break;
            }
            if (4..=8).contains(&ply) {
                let id = format!("{source_name}-ply{ply}");
                if game.outcome().is_some() {
                    write_rejection(
                        &mut rejections,
                        rejection_row(&source, &source_name, ply, "terminal_position"),
                    )?;
                    rejected_count += 1;
                    ended_at = Some(ply);
                    break;
                }
                let fen = game.position().to_fen();
                let key = fen.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
                let root_legal_moves = {
                    let mut position = game.position().clone();
                    position
                        .legal_moves()
                        .iter()
                        .map(|movement| movement.to_iccs())
                        .collect::<Vec<_>>()
                };
                let iccs_prefix = imported.moves[..ply]
                    .iter()
                    .map(|movement| movement.to_iccs())
                    .collect::<Vec<_>>()
                    .join(" ");
                let duplicate_of = seen.get(&key).cloned();
                let duplicate = duplicate_of.is_some();
                if !duplicate {
                    seen.insert(key.clone(), id.clone());
                    let source_ref = source
                        .get("source_pgn_url")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    writeln!(runner, "{id}\t{source_ref}\t{iccs_prefix}")?;
                }
                let row = json!({
                    "schema_version": "m4-openings-v1",
                    "opening_id": id,
                    "source_name": source_name,
                    "source_license": source.get("source_license"),
                    "source_pgn_url": source.get("source_pgn_url"),
                    "source_pgn_sha256": source.get("source_pgn_sha256"),
                    "source_revision": source.get("source_revision"),
                    "ecco": imported.metadata.get("ECCO"),
                    "source_game_result": imported.metadata.get("Result"),
                    "source_headers": imported.metadata,
                    "cutoff_ply": ply,
                    "iccs_prefix": iccs_prefix,
                    "fen": fen,
                    "position_key": key,
                    "red_to_move_after_cutoff": game.position().side_to_move() == xq_core::Side::Red,
                    "root_legal_moves": root_legal_moves,
                    "reference_balance": Value::Null,
                    "validation": {
                        "replay": "passed",
                        "duplicate": duplicate,
                        "duplicate_of": duplicate_of,
                        "acceptance_reason": if duplicate { "duplicate_board_and_side" } else { "pending_external_balance" },
                    }
                });
                serde_json::to_writer(&mut candidates, &row)?;
                writeln!(candidates)?;
                candidate_count += 1;
            }
            if game.outcome().is_some() {
                ended_at = Some(ply);
                break;
            }
        }
        for cutoff in 4..=8 {
            if cutoff > max_cutoff && ended_at.is_none() {
                write_rejection(
                    &mut rejections,
                    rejection_row(&source, &source_name, cutoff, "insufficient_legal_plies"),
                )?;
                rejected_count += 1;
            } else if ended_at.is_some_and(|ply| cutoff >= ply) && cutoff > max_cutoff {
                write_rejection(
                    &mut rejections,
                    rejection_row(&source, &source_name, cutoff, "game_ended_before_cutoff"),
                )?;
                rejected_count += 1;
            }
        }
    }
    candidates.flush()?;
    runner.flush()?;
    rejections.flush()?;
    eprintln!(
        "candidate rows: {candidate_count}; rejection rows: {rejected_count}; unique board+side: {}",
        seen.len()
    );
    Ok(())
}

fn rejection_row(source: &Value, source_name: &str, cutoff_ply: usize, reason: &str) -> Value {
    json!({
        "schema_version": "m4-openings-v1",
        "source_name": source_name,
        "source_pgn_url": source.get("source_pgn_url"),
        "source_pgn_sha256": source.get("source_pgn_sha256"),
        "cutoff_ply": cutoff_ply,
        "reason": reason,
    })
}

fn reject_source(
    writer: &mut impl Write,
    source: &Value,
    source_name: &str,
    reason: &str,
) -> Result<(), Box<dyn Error>> {
    write_rejection(
        writer,
        json!({
            "schema_version": "m4-openings-v1",
            "source_name": source_name,
            "source_pgn_url": source.get("source_pgn_url"),
            "source_pgn_sha256": source.get("source_pgn_sha256"),
            "reason": reason,
        }),
    )
}

fn write_rejection(writer: &mut impl Write, row: Value) -> Result<(), Box<dyn Error>> {
    serde_json::to_writer(&mut *writer, &row)?;
    writeln!(writer)?;
    Ok(())
}
