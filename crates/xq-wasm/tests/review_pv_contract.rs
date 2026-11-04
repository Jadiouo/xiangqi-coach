use serde_json::Value;
use xq_core::{Game, Move, Position};
use xq_wasm::ReviewWorkerSession;

#[test]
fn nonterminal_review_lines_include_six_actual_continuation_plies() {
    let mut fixture = Game::new(Position::startpos());
    for text in ["h2e2", "b7b3", "b0c2", "c9a7", "h0g2", "h7h4"] {
        fixture
            .play(Move::from_iccs(text).expect("fixture coordinate move"))
            .expect("fixture move is legal");
    }
    let middle_game_fen = fixture.position().to_fen();
    let played_move = fixture
        .position()
        .clone()
        .legal_moves()
        .first()
        .expect("middle game has legal moves")
        .to_iccs();
    let mut session = ReviewWorkerSession::new(&middle_game_fen, &played_move, 100_000)
        .expect("fixture game is legal");
    let event: serde_json::Value = serde_json::from_str(&session.step().expect("first point"))
        .expect("worker response is valid JSON");
    let candidates = event["point"]["quick"]["candidates"]
        .as_array()
        .expect("candidate lines are present");
    assert!(candidates.len() >= 3);
    assert_eq!(event["continuationPending"], true);
    assert_eq!(event["point"]["continuationComplete"], false);
    for pass in ["quick", "final"] {
        for candidate in event["point"][pass]["candidates"].as_array().unwrap() {
            let audit = &candidate["replayAudit"];
            assert!(
                audit["rootFen"].is_string(),
                "{pass} candidate has root FEN audit"
            );
            assert!(
                audit["rootHistory"].is_array(),
                "{pass} candidate has history audit"
            );
            assert_eq!(audit["rootHistoryLength"], 0);
            assert!(audit["originalPv"].is_array());
            assert_eq!(audit["originalPv"], candidate["pv"]);
            assert_eq!(audit["replayedPv"], candidate["pv"]);
            assert_eq!(audit["failedIndex"], serde_json::Value::Null);
            assert_eq!(audit["failure"], serde_json::Value::Null);
            assert_eq!(audit["resultOutcome"], serde_json::Value::Null);
            assert_eq!(candidate["continuationStatus"], "pending");
            assert_eq!(candidate["continuationTerminal"], false);
        }
    }
    let original_lines = candidates.to_vec();
    let mut continuations = vec![Vec::<String>::new(); original_lines.len()];
    loop {
        let step: serde_json::Value =
            serde_json::from_str(&session.continue_step().expect("next continuation boundary"))
                .expect("continuation response is valid JSON");
        if step["done"] == true {
            break;
        }
        let index = step["candidateIndex"].as_u64().expect("candidate index") as usize;
        assert!(index < continuations.len());
        assert!(step["segment"]["depth"].as_u64().unwrap_or(0) >= 2);
        continuations[index].push(
            step["segment"]["move"]
                .as_str()
                .expect("continuation move")
                .to_owned(),
        );
    }
    for (candidate_index, candidate) in original_lines.iter().enumerate() {
        let pv = candidate["pv"]
            .as_array()
            .expect("original search line is retained");
        assert!(
            pv.len() >= 2,
            "the original search returned a short or empty line"
        );
        assert_eq!(candidate["pvEnd"], "depth_limit");
        assert_eq!(candidate["continuationTerminal"], false);
        assert_eq!(candidate["continuationNodeLimit"], 20_000);
        let continuation = &continuations[candidate_index];
        assert!(pv.len() + continuation.len() >= 6);

        let mut game = Game::new(Position::from_fen(&middle_game_fen).expect("fixture FEN"));
        let original_moves = pv
            .iter()
            .map(|value| value.as_str().expect("original PV move").to_owned());
        for text in original_moves.chain(continuation.iter().cloned()) {
            assert!(
                game.outcome().is_none(),
                "the reported line remains nonterminal"
            );
            let movement =
                Move::from_iccs(&text).expect("reported line uses a valid coordinate move");
            game.play(movement)
                .expect("each reported continuation move is legal");
        }
        assert!(
            game.outcome().is_none(),
            "fixture position is nonterminal after six plies"
        );
    }
}

#[test]
fn ui_review_candidates_are_replayed_from_their_actual_history_position() {
    let mut fixture = Game::new(Position::startpos());
    fixture.play(Move::from_iccs("h2e2").unwrap()).unwrap();
    for line in [
        ["b7b6", "b2b5", "i9i8"],
        ["h7h6", "b2c2", "b7b3"],
        ["b7b0", "a0b0", "b9c7"],
    ] {
        let mut game = fixture.clone();
        for text in line {
            let movement = Move::from_iccs(text).unwrap();
            game.play(movement)
                .unwrap_or_else(|error| panic!("{text} must replay legally: {error:?}"));
        }
    }
}

#[test]
fn focused_review_session_analyzes_only_the_selected_ply_with_full_history() {
    let start_fen = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";
    let mut session = ReviewWorkerSession::with_focus(start_fen, "h2e2 b7b3", 20_000, 1)
        .expect("focused review session initializes from the complete history");
    let event: Value = serde_json::from_str(&session.step().expect("focused point is returned"))
        .expect("review event is valid JSON");

    assert_eq!(
        event["index"], 0,
        "session uses a one-point local result list"
    );
    assert_eq!(event["point"]["quick"]["playedMove"], "b7b3");
    let audit = &event["point"]["quick"]["candidates"][0]["replayAudit"];
    assert_eq!(audit["plyIndex"], 1);
    assert_eq!(audit["rootHistory"], serde_json::json!(["h2e2"]));
    assert_eq!(audit["rootMatchesReplayStart"], true);
}
