use std::process::Command;

#[test]
fn mate_proof_cli_reports_complete_root_classification() {
    let output = Command::new(env!("CARGO_BIN_EXE_mate-proof"))
        .args(["1n3k3/9/3N5/9/9/9/R8/7N1/3K5/7C1 w - - 0 1", "1", "100000"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("complete\ttrue"), "{stdout}");
    assert!(stdout.contains("mate\ta3f3\t1"), "{stdout}");
    assert!(stdout.contains("mate\ta3a9\t1"), "{stdout}");
    assert!(stdout.contains("unique\t-"), "{stdout}");
}
