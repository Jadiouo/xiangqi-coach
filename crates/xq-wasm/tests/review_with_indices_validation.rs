//! `with_indices` accepts valid ply lists in any order. The rejections are unit-tested on
//! `sorted_review_indices` in `src/lib.rs`, since building a `JsValue` error aborts on native targets.
use xq_wasm::ReviewWorkerSession;

const START: &str = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";
const MOVES: &str = "h2e2 h9g7 h0g2";

#[test]
fn accepts_unique_in_range_indices_in_any_order() {
    assert!(ReviewWorkerSession::with_indices(START, MOVES, 100, &[2, 0]).is_ok());
}
