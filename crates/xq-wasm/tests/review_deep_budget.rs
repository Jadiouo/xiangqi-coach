//! The deep pass searches DEEP_FACTOR times the quick budget. The factor is a user decision
//! (2026-10-23: 3x, down from 10x); the numbers here come from that decision, not from the code.

use serde_json::Value;
use xq_core::Position;
use xq_wasm::ReviewWorkerSession;

// First 12 plies of docs/samples/data/sample-beginner.json; ply 11 (e6e5) loses about 20%, so it is deepened.
const GAME: [&str; 12] = [
    "c3c4", "g6g5", "h2g2", "g9e7", "h0i2", "h9g7", "i0h0", "i9h9", "h0h6", "f9e8", "b2b9", "e6e5",
];
const QUICK_NODES: u32 = 1_000;
const DEEP_FACTOR: u64 = 3;

#[test]
fn deep_pass_budget_is_three_times_the_quick_budget() {
    let fen = Position::startpos().to_fen();
    let mut session = ReviewWorkerSession::with_indices(&fen, &GAME.join(" "), QUICK_NODES, &[11])
        .expect("session");
    let mut deep_max = 0_u64;
    let mut quick_max = 0_u64;
    let mut deep_points = 0;
    loop {
        let event: Value = serde_json::from_str(&session.step().expect("step")).expect("json");
        if event["done"] == true {
            break;
        }
        let pending = event["continuationPending"] == true;
        let (pass, key) = match event["pass"].as_str() {
            Some("deep") => ("deep", "final"),
            _ => ("quick", "quick"),
        };
        for candidate in event["point"][key]["candidates"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let nodes = candidate["nodes"].as_u64().expect("nodes");
            if pass == "deep" {
                deep_max = deep_max.max(nodes);
            } else {
                quick_max = quick_max.max(nodes);
            }
        }
        if pass == "deep" {
            deep_points += 1;
        }
        if pending {
            loop {
                let step: Value =
                    serde_json::from_str(&session.continue_step().expect("c")).expect("json");
                if step["done"] == true {
                    break;
                }
            }
        }
    }
    assert!(deep_points > 0, "fixture must deepen at least one ply");
    // Node counts come in steps (a search stops at a finished depth), so only the upper bound is
    // asserted. Measured here: 3x budget -> 1,023 nodes at most; the old 10x budget -> 7,583.
    // A search may overshoot its limit by a few nodes (measured: 23 of 1,000).
    let slack = |limit: u64| limit + limit / 20;
    assert!(quick_max <= slack(u64::from(QUICK_NODES)));
    assert!(
        deep_max <= slack(DEEP_FACTOR * u64::from(QUICK_NODES)),
        "deep search used {deep_max} nodes, more than {DEEP_FACTOR}x the quick budget"
    );
}
