//! Marked final results get short engine lines topped up, one analyzer call per missing ply
//! (single line, 20,000 nodes, as the wasm continuation does). Quick results and unmarked moves
//! are never topped up. Only xq-review calls the analyzer; the engine is untouched.

mod common;

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use common::line;
use xq_core::{Game, Move, Position};
use xq_review::{
    Analyzer, IncrementalReview, Limit, Line, PlyInput, ReviewScore, analyze_two_pass,
    review_game_two_pass_until,
};

const FEN: &str = "4k4/9/9/9/2p6/9/9/1N7/9/3K5 w - - 0 1";
const EXTENSION_NODES: u64 = 20_000;

fn mv(text: &str) -> Move {
    Move::from_iccs(text).unwrap()
}

/// Scripted root and reply lines; every other position gets its first legal move.
struct Scripted {
    root: (String, Vec<&'static str>),
    after: (String, Vec<&'static str>),
    calls: Rc<RefCell<Vec<(String, u64, usize)>>>,
    stop_after_first_extension: Option<Rc<Cell<bool>>>,
    answers: HashMap<String, Vec<Line>>,
}

impl Scripted {
    fn new(played: &str, best_pv: &[&'static str], reply_pv: &[&'static str]) -> Self {
        let game = Game::new(Position::from_fen(FEN).unwrap());
        let mut after = game.clone();
        after.play(mv(played)).unwrap();
        Self {
            root: (game.position().to_fen(), best_pv.to_vec()),
            after: (after.position().to_fen(), reply_pv.to_vec()),
            calls: Rc::default(),
            stop_after_first_extension: None,
            answers: HashMap::new(),
        }
    }

    fn extension_calls(&self) -> Vec<(String, u64, usize)> {
        self.calls
            .borrow()
            .iter()
            .filter(|(_, nodes, _)| *nodes == EXTENSION_NODES)
            .cloned()
            .collect()
    }
}

impl Analyzer for Scripted {
    fn analyze(&mut self, pos: &Position, limit: Limit, multipv: usize) -> Vec<Line> {
        let fen = pos.to_fen();
        self.calls
            .borrow_mut()
            .push((fen.clone(), limit.nodes, multipv));
        if limit.nodes == EXTENSION_NODES {
            if let Some(flag) = &self.stop_after_first_extension {
                flag.set(true);
            }
        } else if fen == self.root.0 {
            return vec![line(&self.root.1, ReviewScore::centipawns(400))];
        } else if fen == self.after.0 {
            return vec![line(&self.after.1, ReviewScore::centipawns(0))];
        }
        let first = pos.clone().legal_moves()[0].to_iccs();
        self.answers
            .entry(fen)
            .or_insert_with(|| vec![line(&[first.as_str()], ReviewScore::centipawns(0))])
            .clone()
    }

    fn name(&self) -> String {
        "scripted".into()
    }
}

fn ply(played: &str) -> PlyInput {
    PlyInput::new(Game::new(Position::from_fen(FEN).unwrap()), mv(played))
}

fn run_single(analyzer: &mut Scripted, played: &str) -> xq_review::PlyAnalysis {
    let mut review =
        IncrementalReview::new_single_pass(analyzer, vec![ply(played)], Limit::new(100));
    review.advance().unwrap().unwrap();
    review.report().points.remove(0).final_result
}

#[test]
fn a_one_step_line_is_topped_up_to_four_plies() {
    let mut analyzer = Scripted::new("b2c4", &["d0d1"], &["e9e8"]);
    let result = run_single(&mut analyzer, "b2c4");
    let comparison = result.comparison.expect("marked");
    assert_eq!(comparison.best_line.len(), 4);
    assert_eq!(comparison.played_line.len(), 4);
    assert!(comparison.best_complete && comparison.played_complete);
    assert_eq!(comparison.best_line[0].mv, mv("d0d1"));
    assert_eq!(comparison.played_line[0].mv, mv("e9e8"));
    // 3 missing plies per line, one call each, all single-line.
    let extra = analyzer.extension_calls();
    assert_eq!(extra.len(), 6);
    assert!(extra.iter().all(|(_, _, multipv)| *multipv == 1));
}

#[test]
fn the_top_up_has_a_hard_call_cap() {
    let mut analyzer = Scripted::new("b2c4", &["d0d1"], &["e9e8"]);
    run_single(&mut analyzer, "b2c4");
    // At most (N - 1) extra calls per line, so never more than 2 * N overall.
    assert!(analyzer.extension_calls().len() <= 2 * xq_review::COMPARISON_PLIES);
}

#[test]
fn a_line_that_already_ends_the_game_is_not_extended() {
    let fen = "5k3/9/9/9/R4n3/6N2/9/9/9/3RK4 w - - 0 1";
    let start = Game::new(Position::from_fen(fen).unwrap());
    let mut probe = Position::from_fen(fen).unwrap();
    let mating = probe
        .legal_moves()
        .into_iter()
        .find(|&m| {
            let mut g = start.clone();
            g.play(m).unwrap();
            g.outcome().is_some()
        })
        .unwrap();
    let other = probe
        .legal_moves()
        .into_iter()
        .find(|&m| {
            m != mating && {
                let mut g = start.clone();
                g.play(m).unwrap();
                g.outcome().is_none()
            }
        })
        .unwrap();
    let mut after = start.clone();
    after.play(other).unwrap();
    let reply = after.position().clone().legal_moves()[0].to_iccs();
    let mut calls = 0usize;
    struct Mate {
        root: String,
        after: String,
        mating: String,
        reply: String,
        extension_calls: usize,
    }
    impl Analyzer for Mate {
        fn analyze(&mut self, pos: &Position, limit: Limit, _: usize) -> Vec<Line> {
            let fen = pos.to_fen();
            if limit.nodes == EXTENSION_NODES {
                self.extension_calls += 1;
                let first = pos.clone().legal_moves()[0].to_iccs();
                return vec![line(&[first.as_str()], ReviewScore::centipawns(0))];
            }
            if fen == self.root {
                vec![line(&[self.mating.as_str()], ReviewScore::centipawns(400))]
            } else if fen == self.after {
                vec![line(&[self.reply.as_str()], ReviewScore::centipawns(0))]
            } else {
                Vec::new()
            }
        }
        fn name(&self) -> String {
            "mate".into()
        }
    }
    let mut analyzer = Mate {
        root: start.position().to_fen(),
        after: after.position().to_fen(),
        mating: mating.to_iccs(),
        reply,
        extension_calls: 0,
    };
    let input = PlyInput::new(start, other);
    let mut review =
        IncrementalReview::new_single_pass(&mut analyzer, vec![input], Limit::new(100));
    review.advance().unwrap().unwrap();
    let comparison = review.report().points[0]
        .final_result
        .comparison
        .clone()
        .unwrap();
    drop(review);
    calls += analyzer.extension_calls;
    assert!(comparison.best_complete);
    assert_eq!(comparison.best_line.len(), 1);
    // Only the played line (reply, then more) needed topping up: at most 3 calls.
    assert!(calls <= 3, "extension calls {calls}");
}

#[test]
fn should_stop_ends_the_top_up_and_leaves_the_lines_incomplete() {
    let stop = Rc::new(Cell::new(false));
    let mut analyzer = Scripted::new("b2c4", &["d0d1"], &["e9e8"]);
    analyzer.stop_after_first_extension = Some(stop.clone());
    let mut review =
        IncrementalReview::new_single_pass(&mut analyzer, vec![ply("b2c4")], Limit::new(100));
    let flag = stop.clone();
    let mut should_stop = move || flag.get();
    review.advance_until(&mut should_stop).unwrap().unwrap();
    let comparison = review.report().points[0]
        .final_result
        .comparison
        .clone()
        .unwrap();
    drop(review);
    assert_eq!(analyzer.extension_calls().len(), 1);
    assert!(!comparison.best_complete);
    assert!(!comparison.played_complete);
    assert!(comparison.best_line.len() < 4 && comparison.played_line.len() < 4);
    // The next advance reports the cancellation.
    let mut idle = Scripted::new("b2c4", &["d0d1"], &["e9e8"]);
    let mut review =
        IncrementalReview::new_single_pass(&mut idle, vec![ply("b2c4")], Limit::new(100));
    let mut stopped = || true;
    assert!(review.advance_until(&mut stopped).unwrap().is_none());
    assert!(review.report().cancelled);
}

#[test]
fn an_unmarked_move_is_never_topped_up() {
    let mut analyzer = Scripted::new("d0d1", &["d0d1"], &["e9e8"]);
    analyzer.after.1 = vec!["e9e8"];
    // Same score on both sides: the played move is the best move.
    struct Even(Scripted);
    impl Analyzer for Even {
        fn analyze(&mut self, pos: &Position, limit: Limit, multipv: usize) -> Vec<Line> {
            let mut lines = self.0.analyze(pos, limit, multipv);
            if limit.nodes != EXTENSION_NODES && pos.to_fen() == self.0.root.0 {
                lines[0].score = ReviewScore::centipawns(0);
            }
            lines
        }
        fn name(&self) -> String {
            "even".into()
        }
    }
    let mut even = Even(analyzer);
    let mut review =
        IncrementalReview::new_single_pass(&mut even, vec![ply("d0d1")], Limit::new(100));
    review.advance().unwrap().unwrap();
    let result = review.report().points[0].final_result.clone();
    drop(review);
    assert!(result.comparison.is_none());
    assert_eq!(even.0.extension_calls().len(), 0);
}

#[test]
fn only_the_final_result_is_topped_up_not_the_quick_one() {
    let mut analyzer = Scripted::new("b2c4", &["d0d1"], &["e9e8"]);
    let report = review_game_two_pass_until(
        &mut analyzer,
        &[ply("b2c4")],
        Limit::new(100),
        Limit::new(1_000),
        &mut || false,
    )
    .unwrap();
    let point = &report.points[0];
    assert!(point.deepened);
    assert_eq!(point.quick.comparison.as_ref().unwrap().best_line.len(), 1);
    assert_eq!(
        point
            .final_result
            .comparison
            .as_ref()
            .unwrap()
            .best_line
            .len(),
        4
    );

    let mut analyzer = Scripted::new("b2c4", &["d0d1"], &["e9e8"]);
    let plies = [ply("b2c4")];
    let results =
        analyze_two_pass(&mut analyzer, &plies, Limit::new(100), Limit::new(1_000)).unwrap();
    assert_eq!(
        results[0]
            .quick
            .comparison
            .as_ref()
            .unwrap()
            .best_line
            .len(),
        1
    );
    assert_eq!(
        results[0]
            .final_result
            .comparison
            .as_ref()
            .unwrap()
            .best_line
            .len(),
        4
    );
}

/// Settled as the review defines it: some step of the line captured, and the side to move at
/// the end still has a capture (unless the game is over).
fn settled_by_hand(start: &Game, moves: &[Move]) -> bool {
    let mut game = start.clone();
    let mut any_capture = false;
    for &m in moves {
        any_capture |= game.position().piece_at(m.to).is_some();
        game.play(m).unwrap();
    }
    if game.outcome().is_some() || !any_capture {
        return true;
    }
    let mut position = game.position().clone();
    let side = position.side_to_move();
    !position
        .legal_moves()
        .into_iter()
        .any(|m| position.piece_at(m.to).is_some_and(|p| p.side != side))
}

#[test]
fn settled_flags_follow_the_line_when_should_stop_cuts_the_top_up() {
    const FEN2: &str = "2r1k4/9/9/9/9/2p6/9/1N7/9/3K5 w - - 0 1";
    struct Cut {
        stop: Rc<Cell<bool>>,
        root: String,
        after_played: String,
        after_best: String,
    }
    impl Analyzer for Cut {
        fn analyze(&mut self, pos: &Position, limit: Limit, _: usize) -> Vec<Line> {
            let fen = pos.to_fen();
            if limit.nodes == EXTENSION_NODES {
                self.stop.set(true);
                // Black's rook takes the horse that just captured on c4.
                let reply = if fen == self.after_best {
                    "c9c4"
                } else {
                    "e9e8"
                };
                return vec![line(&[reply], ReviewScore::centipawns(0))];
            }
            if fen == self.root {
                vec![line(&["b2c4"], ReviewScore::centipawns(400))]
            } else if fen == self.after_played {
                vec![line(&["e9e8"], ReviewScore::centipawns(0))]
            } else {
                Vec::new()
            }
        }
        fn name(&self) -> String {
            "cut".into()
        }
    }
    let start = Game::new(Position::from_fen(FEN2).unwrap());
    let mut after_played = start.clone();
    after_played.play(mv("d0d1")).unwrap();
    let mut after_best = start.clone();
    after_best.play(mv("b2c4")).unwrap();
    let stop = Rc::new(Cell::new(false));
    let mut analyzer = Cut {
        stop: stop.clone(),
        root: start.position().to_fen(),
        after_played: after_played.position().to_fen(),
        after_best: after_best.position().to_fen(),
    };
    let input = PlyInput::new(start.clone(), mv("d0d1"));
    let mut review =
        IncrementalReview::new_single_pass(&mut analyzer, vec![input], Limit::new(100));
    let flag = stop.clone();
    let mut should_stop = move || flag.get();
    review.advance_until(&mut should_stop).unwrap().unwrap();
    let comparison = review.report().points[0]
        .final_result
        .comparison
        .clone()
        .unwrap();
    let best: Vec<Move> = comparison.best_line.iter().map(|s| s.mv).collect();
    let played: Vec<Move> = comparison.played_line.iter().map(|s| s.mv).collect();
    assert_eq!(
        best,
        [mv("b2c4"), mv("c9c4")],
        "one top-up step before the stop"
    );
    assert_eq!(comparison.best_settled, settled_by_hand(&start, &best));
    assert_eq!(
        comparison.played_settled,
        settled_by_hand(&after_played, &played)
    );
}
