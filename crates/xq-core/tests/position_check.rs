use xq_core::{Position, Side};

#[test]
fn reports_check_state_for_either_side_without_changing_position() {
    let position = Position::from_fen("3kr4/9/9/9/9/9/9/9/9/4K4 w - - 0 1").unwrap();
    let fen = position.to_fen();
    assert!(position.is_in_check(Side::Red));
    assert!(!position.is_in_check(Side::Black));
    assert_eq!(position.to_fen(), fen);
}
