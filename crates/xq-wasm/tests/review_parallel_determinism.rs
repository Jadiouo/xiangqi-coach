//! P2: reviewing a game split across several sessions must give exactly the
//! same per-ply results as one session reviewing every ply in order.
//! The expected value is the single-session output; it is never edited.

use serde_json::Value;
use std::collections::BTreeMap;
use xq_core::Position;
use xq_wasm::ReviewWorkerSession;

// First plies of docs/samples/data/sample-beginner.json. Few plies and a small budget keep the
// test short: every distinct split below re-analyzes the whole game once.
const GAME: [&str; 4] = ["c3c4", "g6g5", "h2g2", "g9e7"];
const QUICK_NODES: u32 = 1_000;

/// Every event a session emits (points and continuation steps), grouped by the
/// original ply index, in emission order.
fn drain(mut session: ReviewWorkerSession) -> BTreeMap<usize, Vec<Value>> {
    let mut events: BTreeMap<usize, Vec<Value>> = BTreeMap::new();
    loop {
        let event: Value = serde_json::from_str(&session.step().expect("step")).expect("step json");
        if event["done"] == true {
            break;
        }
        let index = event["index"].as_u64().expect("point index") as usize;
        let pending = event["continuationPending"] == true;
        events.entry(index).or_default().push(event);
        if pending {
            loop {
                let step: Value = serde_json::from_str(&session.continue_step().expect("cont"))
                    .expect("continuation json");
                if step["done"] == true {
                    break;
                }
                let index = step["index"].as_u64().expect("continuation index") as usize;
                events.entry(index).or_default().push(step);
            }
        }
    }
    events
}

fn start_fen() -> String {
    Position::startpos().to_fen()
}

fn moves_text() -> String {
    GAME.join(" ")
}

fn split(count: usize, parts: usize, interleaved: bool) -> Vec<Vec<u32>> {
    let mut groups = vec![Vec::new(); parts];
    for ply in 0..count {
        let group = if interleaved {
            ply % parts
        } else {
            ply * parts / count
        };
        groups[group].push(ply as u32);
    }
    groups.retain(|group| !group.is_empty());
    groups
}

#[test]
fn split_reviews_match_the_single_session_review_exactly() {
    let fen = start_fen();
    let moves = moves_text();
    let baseline =
        drain(ReviewWorkerSession::new(&fen, &moves, QUICK_NODES).expect("baseline session"));
    assert_eq!(baseline.len(), GAME.len(), "baseline covers every ply");
    for (index, events) in &baseline {
        assert!(
            events.len() > 2,
            "ply {index} should have quick and deep points plus continuation steps"
        );
    }
    let mut seen = std::collections::BTreeSet::new();
    for parts in 1..=4 {
        for interleaved in [false, true] {
            let groups = split(GAME.len(), parts, interleaved);
            if !seen.insert(groups.clone()) {
                continue; // contiguous and interleaved coincide (k=1, one ply per part)
            }
            let mut merged: BTreeMap<usize, Vec<Value>> = BTreeMap::new();
            for group in groups {
                let session = ReviewWorkerSession::with_indices(&fen, &moves, QUICK_NODES, &group)
                    .expect("subset session");
                for (index, events) in drain(session) {
                    assert!(
                        group.contains(&(index as u32)),
                        "event index {index} must be an original ply of {group:?}"
                    );
                    assert!(
                        merged.insert(index, events).is_none(),
                        "ply {index} analyzed twice"
                    );
                }
            }
            assert_eq!(
                merged, baseline,
                "k={parts} interleaved={interleaved} differs from the single session"
            );
        }
    }
}
