use super::*;

#[test]
fn repeated_game_history_marks_only_the_real_third_occurrence_as_terminal() {
    let mut root = Game::new(Position::startpos());
    let history = ["b0c2", "b9c7", "c2b0", "c7b9"];
    for text in history {
        root.play(Move::from_iccs(text).expect("valid cycle move"))
            .expect("cycle move is legal");
    }
    assert_eq!(root.outcome(), None);

    let variation = ["b0c2", "b9c7", "c2b0", "c7b9"];
    let moves = variation
        .iter()
        .map(|text| Move::from_iccs(text).expect("valid variation move"))
        .collect::<Vec<_>>();
    let line = Line {
        best_move: moves[0],
        score: xq_review::ReviewScore::centipawns(0),
        principal_variation: moves,
        depth: 3,
        nodes: 1_000,
        pv_end: xq_review::PvEnd::DepthLimit,
    };
    let mut candidates = prepare_continuations(&root, &history.map(str::to_owned), 2, &[line]);
    let candidate = candidates.pop().expect("candidate line exists");

    assert!(candidate.terminal);
    assert_eq!(candidate.status, "terminal");
    assert_eq!(candidate.replay_audit["failedIndex"], Value::Null);
    assert_eq!(candidate.replay_audit["failure"], Value::Null);
    assert_eq!(
        candidate.replay_audit["replayedPv"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    assert_eq!(candidate.replay_audit["rootHistoryLength"], 4);
    assert_eq!(candidate.replay_audit["resultOutcome"], "Draw");
    assert_eq!(candidate.replay_audit["resultHistoryLength"], 8);
}
