use std::fs;
use std::process::Command;

#[test]
fn extracts_positions_before_actual_one_two_and_three_move_checkmates() {
    let root = std::env::temp_dir().join(format!("ccpd-mate-candidates-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let pgn = root.join("00000001.pgn");
    fs::write(
        &pgn,
        "[Game \"Chinese Chess\"]\n[Result \"1-0\"]\n[FEN \"5k3/9/9/9/R4n3/6N2/9/9/9/3RK4 w - - 0 1\"]\n\n1. a5f5 1-0\n",
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_ccpd-mate-candidates"))
        .arg("--input-dir")
        .arg(&root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(
        stdout.contains("audit\t00000001.pgn\tcheckmate\t1\t1\t0"),
        "{stdout}"
    );
    assert!(
        stdout.contains(
            "candidate\t00000001.pgn\t1\t1\ta5f5\t5k3/9/9/9/R4n3/6N2/9/9/9/3RK4 w - - 0 1"
        ),
        "{stdout}"
    );
    assert!(!stdout.contains("candidate\t00000001.pgn\t2\t"), "{stdout}");
    let _ = fs::remove_dir_all(root);
}
