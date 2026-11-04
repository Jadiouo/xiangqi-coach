//! Plies analyzed in one session share the search between neighbouring plies; plies analyzed in
//! separate sessions do not. Sharing must show up as fewer searches and never change an event.

use serde_json::Value;
use xq_core::Position;
use xq_wasm::ReviewWorkerSession;

const GAME: [&str; 4] = ["c3c4", "g6g5", "h2g2", "g9e7"];
const QUICK_NODES: u32 = 1_000;

fn drain_events(session: &mut ReviewWorkerSession) -> Vec<Value> {
    let mut events = Vec::new();
    loop {
        let event: Value = serde_json::from_str(&session.step().expect("step")).expect("json");
        if event["done"] == true {
            break;
        }
        let pending = event["continuationPending"] == true;
        events.push(event);
        if pending {
            loop {
                let step: Value = serde_json::from_str(&session.continue_step().expect("continue"))
                    .expect("json");
                if step["done"] == true {
                    break;
                }
                events.push(step);
            }
        }
    }
    events
}

fn counts(session: &ReviewWorkerSession) -> (u64, u64) {
    let value: Value = serde_json::from_str(&session.search_counts()).expect("counts json");
    (
        value["searches"].as_u64().expect("searches"),
        value["reused"].as_u64().expect("reused"),
    )
}

fn by_ply(events: &[Value], ply: usize) -> Vec<Value> {
    events
        .iter()
        .filter(|event| event["index"].as_u64() == Some(ply as u64))
        .cloned()
        .collect()
}

#[test]
fn one_session_over_neighbouring_plies_searches_less_and_reports_the_same_events() {
    let fen = Position::startpos().to_fen();
    let moves = GAME.join(" ");

    let mut whole = ReviewWorkerSession::new(&fen, &moves, QUICK_NODES).expect("whole session");
    let whole_events = drain_events(&mut whole);
    let (whole_searches, whole_reused) = counts(&whole);

    let mut single_searches = 0;
    for ply in 0..GAME.len() {
        let mut single =
            ReviewWorkerSession::with_indices(&fen, &moves, QUICK_NODES, &[ply as u32])
                .expect("single-ply session");
        let events = drain_events(&mut single);
        assert_eq!(events, by_ply(&whole_events, ply), "ply {ply} differs");
        let (searches, reused) = counts(&single);
        assert_eq!(reused, 0, "a one-ply session has nothing to share");
        single_searches += searches;
    }
    eprintln!("whole {whole_searches} (+{whole_reused} reused), singles {single_searches}");
    assert!(whole_reused >= (GAME.len() as u64) - 1);
    assert!(whole_searches < single_searches);
    assert_eq!(whole_searches + whole_reused, single_searches);
}
