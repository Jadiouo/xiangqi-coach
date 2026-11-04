use std::fs;
use std::process::Command;

fn source_row(source_name: &str) -> serde_json::Value {
    serde_json::json!({
        "source_name": source_name,
        "source_license": "CC-BY-4.0",
        "source_pgn_url": format!("https://example.invalid/{source_name}.pgn"),
        "source_pgn_sha256": "test-sha256",
        "source_revision": "test-revision",
        "pgn": "[Game \"Chinese Chess\"]\n[Event \"測試開局\"]\n[ECCO \"C44\"]\n[FEN \"rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1\"]\n\n1. 炮二平五 馬８進７ 2. 馬二進三 車９平８ 3. 車一平二 卒７進１ 4. 車二進六 馬２進３"
    })
}

#[test]
fn extracts_four_to_eight_legal_plies_and_keeps_provenance_and_deduplication() {
    let temp = std::env::temp_dir().join(format!("xq-openings-{}", std::process::id()));
    fs::create_dir_all(&temp).unwrap();
    let input = temp.join("input.jsonl");
    let candidates = temp.join("candidates.jsonl");
    let match_tsv = temp.join("openings.tsv");
    let rejections = temp.join("rejections.jsonl");
    let lines = [source_row("sample-1"), source_row("sample-2")]
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
        .join("\n");
    fs::write(&input, format!("{lines}\n")).unwrap();

    let binary = std::env::var("CARGO_BIN_EXE_opening-data")
        .expect("opening-data helper binary must be defined");
    let result = Command::new(binary)
        .args([&input, &candidates, &match_tsv, &rejections])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let rows = fs::read_to_string(&candidates)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 10);
    for (row, cutoff) in rows[..5].iter().zip(4..=8) {
        assert_eq!(row["cutoff_ply"], cutoff);
        assert_eq!(row["validation"]["replay"], "passed");
        assert_eq!(row["validation"]["duplicate"], false);
        assert_eq!(row["source_license"], "CC-BY-4.0");
        assert_eq!(row["source_pgn_sha256"], "test-sha256");
        assert_eq!(row["ecco"], "C44");
        assert!(row["fen"].as_str().unwrap().contains(" "));
    }
    assert_eq!(rows[0]["iccs_prefix"], "h2e2 h9g7 h0g2 i9h9");
    let root_moves = rows[0]["root_legal_moves"].as_array().unwrap();
    assert!(root_moves.iter().any(|movement| movement == "a3a4"));
    assert!(!root_moves.iter().any(|movement| movement == "j2a2"));
    assert!(
        rows[5..]
            .iter()
            .all(|row| row["validation"]["duplicate"] == true)
    );

    let runner_rows = fs::read_to_string(&match_tsv).unwrap();
    assert_eq!(runner_rows.lines().count(), 6);
    assert!(runner_rows.starts_with("opening_id\tsource_ref\ticcs_prefix\n"));
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn reports_an_invalid_source_fen_without_calling_it_a_legal_prefix_error() {
    let temp = std::env::temp_dir().join(format!("xq-openings-invalid-fen-{}", std::process::id()));
    fs::create_dir_all(&temp).unwrap();
    let input = temp.join("input.jsonl");
    let candidates = temp.join("candidates.jsonl");
    let match_tsv = temp.join("openings.tsv");
    let rejections = temp.join("rejections.jsonl");
    let mut row = source_row("invalid-fen");
    row["pgn"] = row["pgn"]
        .as_str()
        .unwrap()
        .replace(
            "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR",
            "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBA1ABNR",
        )
        .into();
    fs::write(
        &input,
        format!("{}\n", serde_json::to_string(&row).unwrap()),
    )
    .unwrap();

    let binary = std::env::var("CARGO_BIN_EXE_opening-data")
        .expect("opening-data helper binary must be defined");
    let result = Command::new(binary)
        .args([&input, &candidates, &match_tsv, &rejections])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let rejected = fs::read_to_string(&rejections).unwrap();
    assert!(rejected.contains("invalid_source_fen"), "{rejected}");
    assert!(!rejected.contains("source_parse_error_after_legal_prefix"));
    assert_eq!(fs::read_to_string(&candidates).unwrap(), "");
    assert_eq!(fs::read_to_string(&match_tsv).unwrap().lines().count(), 1);
    fs::remove_dir_all(temp).unwrap();
}
