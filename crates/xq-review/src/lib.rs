//! Pure review calculations and the analyzer boundary used by review clients.

use xq_core::{Game, GameOutcome, Move, MoveError, PieceKind, Position, Side};
pub use xq_engine::PrincipalVariationEnd as PvEnd;

/// Stable snake_case identifier for machine-readable output (web worker and CLI).
pub const fn pv_end_id(end: PvEnd) -> &'static str {
    match end {
        PvEnd::Terminal => "terminal",
        PvEnd::DepthLimit => "depth_limit",
        PvEnd::TranspositionCutoff => "transposition_cutoff",
        PvEnd::ForcedMove => "forced_move",
        PvEnd::NoCompletedIteration => "no_completed_iteration",
    }
}

pub mod level;
pub use level::{
    CalibrationBands, GameScore, LevelError, LevelEstimate, LevelProvenance, ScoredPly, SkillLevel,
    game_score,
};

mod line;
mod reason;
mod tactics;
pub use line::{COMPARISON_PLIES, EXTENSION_NODES, LineStep, MoveComparison, describe_line};
pub use reason::{
    CannonMountEvidence, CheckCaptureEvidence, EvalComponent, MaterialCapture, MaterialEvidence,
    PositionEvidence, ProtectionEvidence, Reason, ReasonKind,
};
pub use tactics::MOBILITY_GAP_STEPS;

const DEFAULT_K: f64 = 300.0;
const MULTIPV: usize = 3;

/// A deterministic analysis budget. Wall-clock policy belongs to the caller.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Limit {
    pub nodes: u64,
}

impl Limit {
    pub const fn new(nodes: u64) -> Self {
        Self { nodes }
    }
}

/// An evaluation whose score and mate distance are from the position's side-to-move view.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReviewScore {
    pub centipawns: i32,
    /// Positive means the side to move can force mate; negative means it is mated.
    pub mate_in: Option<i16>,
}

impl ReviewScore {
    pub const fn centipawns(value: i32) -> Self {
        Self {
            centipawns: value,
            mate_in: None,
        }
    }

    pub const fn mate_in(moves: i16) -> Self {
        Self {
            centipawns: 0,
            mate_in: Some(moves),
        }
    }

    pub const fn mated_in(moves: i16) -> Self {
        Self {
            centipawns: 0,
            mate_in: Some(-moves),
        }
    }

    fn inverted(self) -> Self {
        Self {
            centipawns: -self.centipawns,
            mate_in: self.mate_in.map(|distance| -distance),
        }
    }
}

/// One candidate line, scored from the analyzed position's side-to-move view.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Line {
    pub best_move: Move,
    pub score: ReviewScore,
    pub principal_variation: Vec<Move>,
    pub depth: u8,
    pub nodes: u64,
    pub pv_end: PvEnd,
}

/// Analysis is caller supplied; implementations must not assume file, clock, or RNG access.
pub trait Analyzer {
    /// Return up to `multipv` candidate lines for this position.
    fn analyze(&mut self, pos: &Position, limit: Limit, multipv: usize) -> Vec<Line>;

    /// Cancellation-aware adapter. Implementations may keep their last completed result.
    fn analyze_until(
        &mut self,
        pos: &Position,
        limit: Limit,
        multipv: usize,
        should_stop: &mut dyn FnMut() -> bool,
    ) -> Vec<Line> {
        if should_stop() {
            Vec::new()
        } else {
            self.analyze(pos, limit, multipv)
        }
    }

    /// Analyze with full game context when the implementation can use draw history.
    fn analyze_game(&mut self, game: &Game, limit: Limit, multipv: usize) -> Vec<Line> {
        self.analyze(game.position(), limit, multipv)
    }

    /// Cancellation-aware, history-preserving form of `analyze_game`.
    fn analyze_game_until(
        &mut self,
        game: &Game,
        limit: Limit,
        multipv: usize,
        should_stop: &mut dyn FnMut() -> bool,
    ) -> Vec<Line> {
        if should_stop() {
            Vec::new()
        } else {
            self.analyze_game(game, limit, multipv)
        }
    }

    /// True when, for one game, node budget and analyzer, the first line of a search asking for
    /// `n` lines is exactly the line a search asking for 1 line returns (the line count only cuts
    /// the result list). The review may then answer a one-line request from a search it already
    /// ran for more lines. Default false: such analyzers are always searched once per request.
    fn first_line_ignores_multipv(&self) -> bool {
        false
    }

    fn name(&self) -> String;
}

impl<A: Analyzer + ?Sized> Analyzer for &mut A {
    fn analyze(&mut self, pos: &Position, limit: Limit, multipv: usize) -> Vec<Line> {
        (**self).analyze(pos, limit, multipv)
    }

    fn analyze_until(
        &mut self,
        pos: &Position,
        limit: Limit,
        multipv: usize,
        should_stop: &mut dyn FnMut() -> bool,
    ) -> Vec<Line> {
        (**self).analyze_until(pos, limit, multipv, should_stop)
    }

    fn analyze_game(&mut self, game: &Game, limit: Limit, multipv: usize) -> Vec<Line> {
        (**self).analyze_game(game, limit, multipv)
    }

    fn analyze_game_until(
        &mut self,
        game: &Game,
        limit: Limit,
        multipv: usize,
        should_stop: &mut dyn FnMut() -> bool,
    ) -> Vec<Line> {
        (**self).analyze_game_until(game, limit, multipv, should_stop)
    }

    fn first_line_ignores_multipv(&self) -> bool {
        (**self).first_line_ignores_multipv()
    }

    fn name(&self) -> String {
        (**self).name()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Classification {
    Unclassified,
    Good,
    UniqueMove,
    Inaccuracy,
    DoubtfulMove,
    Mistake,
    Blunder,
    MissedMate,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlyAnalysis {
    pub best_move: Move,
    pub played_move: Move,
    pub candidates: Vec<Line>,
    /// One-based position in the reported candidate lines; None means outside them.
    pub played_rank: Option<u8>,
    pub best_score: ReviewScore,
    pub played_score: ReviewScore,
    /// Best line after the played move. Retained because tactical reasons need its moves,
    /// not only its score.
    pub played_line: Option<Line>,
    pub best_win_probability: f64,
    pub played_win_probability: f64,
    pub loss_percent: f64,
    pub classification: Classification,
    /// First supported explanation for a marked tactical error, if mate evidence exists.
    pub reason: Option<Reason>,
    /// Played line versus best line, only for doubtful moves, mistakes and blunders.
    pub comparison: Option<MoveComparison>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TwoPassPlyAnalysis {
    pub quick: PlyAnalysis,
    /// Replaces the quick result when the first pass loss is greater than 5%.
    pub final_result: PlyAnalysis,
    pub deepened: bool,
}

#[derive(Clone, Debug)]
pub struct PlyInput {
    pub game: Game,
    pub played_move: Move,
}

impl PlyInput {
    pub fn new(game: Game, played_move: Move) -> Self {
        Self { game, played_move }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReviewError {
    IllegalPlayedMove,
    NoAnalysisLines,
    Cancelled,
}

impl From<MoveError> for ReviewError {
    fn from(_: MoveError) -> Self {
        Self::IllegalPlayedMove
    }
}

/// Convert a side-to-move score to win probability using the SPEC default k=300.
pub fn win_probability(score: ReviewScore) -> f64 {
    match score.mate_in {
        Some(distance) if distance > 0 => 1.0,
        Some(distance) if distance < 0 => 0.0,
        _ => 1.0 / (1.0 + (-f64::from(score.centipawns) / DEFAULT_K).exp()),
    }
}

/// Classify loss percentages using the boundaries specified for review annotations.
pub fn classify_loss(
    loss_percent: f64,
    played_rank: Option<u8>,
    unique_move: bool,
    missed_mate: bool,
) -> Classification {
    if missed_mate {
        Classification::MissedMate
    } else if unique_move {
        Classification::UniqueMove
    } else if loss_percent < 2.0 && matches!(played_rank, Some(1 | 2)) {
        Classification::Good
    } else if loss_percent < 2.0 {
        Classification::Unclassified
    } else if loss_percent < 5.0 {
        Classification::Inaccuracy
    } else if loss_percent < 10.0 {
        Classification::DoubtfulMove
    } else if loss_percent < 20.0 {
        Classification::Mistake
    } else {
        Classification::Blunder
    }
}

/// Searches of the last few positions, kept so that the search after ply i can serve as the
/// search before ply i + 1 (same game, same node budget, same analyzer).
///
/// Only used for analyzers that declare `first_line_ignores_multipv`; the search is then always
/// run for `MULTIPV` lines and a one-line request takes the first. A search that was cut short by
/// `should_stop`, or that returned nothing, is never kept.
#[derive(Debug, Default)]
pub struct SearchMemo {
    entries: Vec<MemoEntry>,
    searches: u64,
    reused: u64,
}

#[derive(Debug)]
struct MemoEntry {
    game: Game,
    limit: Limit,
    lines: Vec<Line>,
}

const MEMO_ENTRIES: usize = 4;

/// Exactly the same search input: same start, same moves (and so the same repetition history).
fn same_game(a: &Game, b: &Game) -> bool {
    a.context_key() == b.context_key()
        && a.initial_position() == b.initial_position()
        && a.position() == b.position()
        && a.history_len() == b.history_len()
        && a.history_moves().eq(b.history_moves())
}

impl SearchMemo {
    pub fn new() -> Self {
        Self::default()
    }

    /// Searches actually run through this memo.
    pub fn searches(&self) -> u64 {
        self.searches
    }

    /// Requests answered from an earlier search.
    pub fn reused(&self) -> u64 {
        self.reused
    }

    fn analyze<A: Analyzer + ?Sized>(
        &mut self,
        analyzer: &mut A,
        game: &Game,
        limit: Limit,
        wanted: usize,
        should_stop: &mut dyn FnMut() -> bool,
    ) -> Vec<Line> {
        if !analyzer.first_line_ignores_multipv() {
            self.searches += 1;
            return analyzer.analyze_game_until(game, limit, wanted, should_stop);
        }
        if let Some(entry) = self
            .entries
            .iter()
            .find(|entry| entry.limit == limit && same_game(&entry.game, game))
        {
            self.reused += 1;
            return entry.lines.iter().take(wanted).cloned().collect();
        }
        self.searches += 1;
        let mut stopped = false;
        let lines = {
            let mut watch = || {
                let stop = should_stop();
                stopped |= stop;
                stop
            };
            analyzer.analyze_game_until(game, limit, MULTIPV.max(wanted), &mut watch)
        };
        if !stopped && !lines.is_empty() {
            if self.entries.len() == MEMO_ENTRIES {
                self.entries.remove(0);
            }
            self.entries.push(MemoEntry {
                game: game.clone(),
                limit,
                lines: lines.clone(),
            });
        }
        lines.into_iter().take(wanted).collect()
    }
}

/// Analyze one played move. Parent scores are for the mover; child scores are negated
/// from the opponent's side-to-move view before comparing probabilities.
pub fn review_one_move<A: Analyzer + ?Sized>(
    analyzer: &mut A,
    game: &Game,
    played_move: Move,
    limit: Limit,
) -> Result<PlyAnalysis, ReviewError> {
    let mut never_stop = || false;
    review_one_move_until(analyzer, game, played_move, limit, &mut never_stop, None)
}

fn review_one_move_until<A: Analyzer + ?Sized>(
    analyzer: &mut A,
    game: &Game,
    played_move: Move,
    limit: Limit,
    should_stop: &mut dyn FnMut() -> bool,
    mut memo: Option<&mut SearchMemo>,
) -> Result<PlyAnalysis, ReviewError> {
    let mut after_game = game.clone();
    after_game.play(played_move)?;

    let lines = match memo.as_deref_mut() {
        Some(memo) => memo.analyze(analyzer, game, limit, MULTIPV, should_stop),
        None => analyzer.analyze_game_until(game, limit, MULTIPV, should_stop),
    };
    if lines.is_empty() && should_stop() {
        return Err(ReviewError::Cancelled);
    }
    let best = lines.first().ok_or(ReviewError::NoAnalysisLines)?;
    let played_rank = lines
        .iter()
        .position(|line| line.best_move == played_move)
        .map(|rank| (rank + 1) as u8);

    let best_probability = win_probability(best.score);
    let mut played_line = None;
    let played_score = match after_game.outcome() {
        Some(GameOutcome::Draw) => ReviewScore::centipawns(0),
        Some(GameOutcome::Win(winner)) => {
            let child_score = if winner == after_game.position().side_to_move() {
                ReviewScore::mate_in(1)
            } else {
                ReviewScore::mated_in(1)
            };
            child_score.inverted()
        }
        None => {
            let after_lines = match memo {
                Some(memo) => memo.analyze(analyzer, &after_game, limit, 1, should_stop),
                None => analyzer.analyze_game_until(&after_game, limit, 1, should_stop),
            };
            if after_lines.is_empty() && should_stop() {
                return Err(ReviewError::Cancelled);
            }
            let after_line = after_lines.first().ok_or(ReviewError::NoAnalysisLines)?;
            played_line = Some(after_line.clone());
            after_line.score.inverted()
        }
    };
    let played_probability = win_probability(played_score);
    let loss_percent = ((best_probability - played_probability).max(0.0)) * 100.0;

    let second_best_probability = lines.get(1).map(|line| win_probability(line.score));
    let unique_move = played_rank == Some(1)
        && second_best_probability.is_some_and(|second| best_probability - second >= 0.15);
    let missed_mate = best.best_move != played_move
        && best.score.mate_in.is_some_and(|distance| distance > 0)
        && !played_score.mate_in.is_some_and(|distance| distance > 0);
    let classification = classify_loss(loss_percent, played_rank, unique_move, missed_mate);
    let mate_reason = if matches!(
        classification,
        Classification::DoubtfulMove
            | Classification::Mistake
            | Classification::Blunder
            | Classification::MissedMate
    ) {
        if played_score.mate_in.is_some_and(|distance| distance < 0) {
            played_score
                .mate_in
                .map(|distance| Reason::bare(ReasonKind::WalkedIntoMate, distance.unsigned_abs()))
        } else if missed_mate {
            best.score
                .mate_in
                .map(|distance| Reason::bare(ReasonKind::MissedMate, distance as u16))
        } else {
            None
        }
    } else {
        None
    };
    let reason = mate_reason.or_else(|| {
        if !matches!(
            classification,
            Classification::DoubtfulMove | Classification::Mistake | Classification::Blunder
        ) {
            return None;
        }
        // The engine's best reply to the played move: a tactical reason may only claim a
        // capture the engine itself would make.
        let reply = played_line.as_ref().map(|line| line.best_move);
        material_reason(game, played_move, best, played_line.as_ref())
            .or_else(|| tactics::sent_piece(game, played_move, reply))
            .or_else(|| tactics::cannon_mount(game, played_move, reply))
            .or_else(|| tactics::abandoned_protection(game, played_move, reply))
            .or_else(|| tactics::check_capture(game, played_move, reply))
            .or_else(|| tactics::position_type(game, played_move, best.best_move))
    });

    let comparison = is_marked(classification)
        .then(|| build_comparison(game, &after_game, best, played_line.as_ref()));

    Ok(PlyAnalysis {
        best_move: best.best_move,
        played_move,
        candidates: lines.clone(),
        played_rank,
        best_score: best.score,
        played_score,
        played_line,
        best_win_probability: best_probability,
        played_win_probability: played_probability,
        loss_percent,
        classification,
        reason,
        comparison,
    })
}

/// Moves that get a played-versus-best comparison.
fn is_marked(classification: Classification) -> bool {
    matches!(
        classification,
        Classification::DoubtfulMove
            | Classification::Mistake
            | Classification::Blunder
            | Classification::MissedMate
    )
}

/// Top up a short line of a marked final result: one single-line analyzer call per missing ply
/// (`EXTENSION_NODES` each, best move appended), until the line has `COMPARISON_PLIES` plies, the
/// game ends, the analyzer returns nothing, or `should_stop` fires (lines then stay incomplete).
/// Best line first, then the played line; at most `COMPARISON_PLIES - 1` calls per line.
fn extend_comparison<A: Analyzer + ?Sized>(
    analyzer: &mut A,
    game: &Game,
    played_move: Move,
    result: &mut PlyAnalysis,
    should_stop: &mut dyn FnMut() -> bool,
) {
    let Some(comparison) = result.comparison.as_mut() else {
        return;
    };
    let mut after_game = game.clone();
    if after_game.play(played_move).is_err() {
        return;
    }
    let limit = Limit::new(EXTENSION_NODES);
    'lines: for (start, steps, complete) in [
        (
            game,
            &mut comparison.best_line,
            &mut comparison.best_complete,
        ),
        (
            &after_game,
            &mut comparison.played_line,
            &mut comparison.played_complete,
        ),
    ] {
        for _ in 0..COMPARISON_PLIES {
            if *complete || steps.len() >= COMPARISON_PLIES {
                break;
            }
            let mut moves: Vec<Move> = steps.iter().map(|step| step.mv).collect();
            let mut tip = start.clone();
            if moves.iter().any(|&m| tip.play(m).is_err()) || tip.outcome().is_some() {
                break;
            }
            if should_stop() {
                break 'lines;
            }
            let lines = analyzer.analyze_game_until(&tip, limit, 1, should_stop);
            let Some(next) = lines.first() else {
                break;
            };
            moves.push(next.best_move);
            let described = describe_line(start, &moves, COMPARISON_PLIES);
            if described.len() != moves.len() {
                break;
            }
            *steps = described;
            *complete = line::line_is_complete(start, steps);
        }
    }
    comparison.best_settled = line::line_is_settled(game, &comparison.best_line);
    comparison.played_settled = line::line_is_settled(&after_game, &comparison.played_line);
}

/// Describe both lines from what the analyzer already returned; no further search.
fn build_comparison(
    game: &Game,
    after_game: &Game,
    best: &Line,
    played_line: Option<&Line>,
) -> MoveComparison {
    let played_moves: &[Move] = played_line.map_or(&[], |line| line.principal_variation.as_slice());
    let played = describe_line(after_game, played_moves, COMPARISON_PLIES);
    let played_complete = line::line_is_complete(after_game, &played);

    // The PV may be empty (no completed iteration); the best move itself is always known.
    let fallback = [best.best_move];
    let best_moves: &[Move] = if best.principal_variation.first() == Some(&best.best_move) {
        &best.principal_variation
    } else {
        &fallback
    };
    let best_line = describe_line(game, best_moves, COMPARISON_PLIES);
    let best_complete = line::line_is_complete(game, &best_line);
    let played_settled = line::line_is_settled(after_game, &played);
    let best_settled = line::line_is_settled(game, &best_line);
    MoveComparison {
        played_line: played,
        best_line,
        played_complete,
        best_complete,
        played_settled,
        best_settled,
    }
}

struct ReplayedMaterialLine {
    net: i32,
    captures: Vec<MaterialCapture>,
    end: Position,
}

fn material_reason(
    game: &Game,
    played_move: Move,
    best: &Line,
    played: Option<&Line>,
) -> Option<Reason> {
    let played = played?;
    if best.principal_variation.first().copied() != Some(best.best_move)
        || best.best_move == played_move
        || played.principal_variation.first().copied() != Some(played.best_move)
        || matches!(
            best.pv_end,
            PvEnd::NoCompletedIteration | PvEnd::TranspositionCutoff
        )
        || matches!(
            played.pv_end,
            PvEnd::NoCompletedIteration | PvEnd::TranspositionCutoff
        )
    {
        return None;
    }

    // Each line is cut at the comparison length; their lengths need not match.
    let mut actual_moves = Vec::with_capacity(played.principal_variation.len() + 1);
    actual_moves.push(played_move);
    actual_moves.extend_from_slice(&played.principal_variation);
    actual_moves.truncate(COMPARISON_PLIES);
    let best_moves =
        &best.principal_variation[..best.principal_variation.len().min(COMPARISON_PLIES)];

    let mover = game.position().side_to_move();
    let best_line = replay_material_line(game.clone(), mover, best_moves)?;
    let played_line = replay_material_line(game.clone(), mover, &actual_moves)?;
    // A line that captured and ends with another capture available has not shown that its
    // balance survives the obvious reply: keep the claim but flag it (SPEC 8.4.1).
    let settled = line_end_settled(&best_line) && line_end_settled(&played_line);

    let kind = if played_line.net < 0 && played_line.net < best_line.net {
        ReasonKind::DroppedMaterial
    } else if best_line.net > 0 && played_line.net <= 0 {
        ReasonKind::MissedMaterial
    } else {
        return None;
    };
    Some(Reason {
        material: Some(MaterialEvidence {
            mover,
            best_net: best_line.net,
            played_net: played_line.net,
            plies: actual_moves.len().max(best_moves.len()) as u8,
            settled,
            best_captures: best_line.captures,
            played_captures: played_line.captures,
        }),
        ..Reason::bare(kind, 0)
    })
}

/// A line without a capture has no exchange to leave open.
fn line_end_settled(line: &ReplayedMaterialLine) -> bool {
    line.captures.is_empty() || !has_legal_capture(&line.end)
}

fn replay_material_line(
    mut game: Game,
    root_side: Side,
    moves: &[Move],
) -> Option<ReplayedMaterialLine> {
    let mut net = 0;
    let mut captures = Vec::new();
    for (index, movement) in moves.iter().copied().enumerate() {
        if game.outcome().is_some() {
            return None;
        }
        let capturer = game.position().side_to_move();
        if let Some(piece) = game.position().piece_at(movement.to) {
            let value = material_value(piece.kind);
            net += if capturer == root_side { value } else { -value };
            captures.push(MaterialCapture {
                piece,
                square: movement.to,
                capturer,
                ply: (index + 1) as u8,
            });
        }
        game.play(movement).ok()?;
    }
    Some(ReplayedMaterialLine {
        net,
        captures,
        end: game.position().clone(),
    })
}

fn has_legal_capture(position: &Position) -> bool {
    position.clone().legal_moves().into_iter().any(|movement| {
        position
            .piece_at(movement.to)
            .is_some_and(|piece| piece.side != position.side_to_move())
    })
}

pub(crate) fn material_value(kind: PieceKind) -> i32 {
    // These are the existing built-in evaluator's material terms, in its PieceKind order.
    match kind {
        PieceKind::King => 0,
        PieceKind::Advisor | PieceKind::Elephant => 120,
        PieceKind::Horse | PieceKind::Cannon => 300,
        PieceKind::Rook => 600,
        PieceKind::Pawn => 70,
    }
}

/// Run the quick pass for every supplied ply, then rerun only losses over 5%.
/// The second-pass analysis fully replaces the first-pass result for that ply.
pub fn analyze_two_pass<A: Analyzer + ?Sized>(
    analyzer: &mut A,
    plies: &[PlyInput],
    quick_limit: Limit,
    deep_limit: Limit,
) -> Result<Vec<TwoPassPlyAnalysis>, ReviewError> {
    let mut results = Vec::with_capacity(plies.len());
    let mut memo = SearchMemo::new();
    for ply in plies {
        let mut never_stop = || false;
        let quick = review_one_move_until(
            analyzer,
            &ply.game,
            ply.played_move,
            quick_limit,
            &mut never_stop,
            Some(&mut memo),
        )?;
        let deepened = should_deepen(quick.loss_percent);
        let final_result = if deepened {
            let mut deep = review_one_move_until(
                analyzer,
                &ply.game,
                ply.played_move,
                deep_limit,
                &mut never_stop,
                Some(&mut memo),
            )?;
            extend_comparison(
                analyzer,
                &ply.game,
                ply.played_move,
                &mut deep,
                &mut never_stop,
            );
            deep
        } else {
            quick.clone()
        };
        results.push(TwoPassPlyAnalysis {
            quick,
            final_result,
            deepened,
        });
    }
    Ok(results)
}

/// Completed review points remain available when cancellation interrupts a later point/pass.
#[derive(Clone, Debug)]
pub struct ReviewReport {
    pub analyzer: String,
    pub points: Vec<TwoPassPlyAnalysis>,
    pub cancelled: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReviewPass {
    Quick,
    Deep,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ReviewStep {
    Point {
        pass: ReviewPass,
        index: usize,
        result: TwoPassPlyAnalysis,
    },
}

/// Incremental two-pass review. Each call to `advance` completes at most one ply,
/// allowing an embedding worker to process cancel or replacement messages between plies.
pub struct IncrementalReview<A: Analyzer> {
    analyzer: A,
    analyzer_name: String,
    plies: Vec<PlyInput>,
    quick_limit: Limit,
    deep_limit: Limit,
    points: Vec<TwoPassPlyAnalysis>,
    quick_index: usize,
    deep_index: usize,
    deep_pass: bool,
    allow_deep_pass: bool,
    cancelled: bool,
    memo: SearchMemo,
}

impl<A: Analyzer> IncrementalReview<A> {
    pub fn new(analyzer: A, plies: Vec<PlyInput>, quick_limit: Limit, deep_limit: Limit) -> Self {
        Self::new_with_deep_pass(analyzer, plies, quick_limit, deep_limit, true)
    }

    /// Analyze the supplied plies once at the requested budget without automatically
    /// scheduling the normal whole-game second pass. Used for an explicit focused reanalysis.
    pub fn new_single_pass(analyzer: A, plies: Vec<PlyInput>, limit: Limit) -> Self {
        Self::new_with_deep_pass(analyzer, plies, limit, limit, false)
    }

    fn new_with_deep_pass(
        analyzer: A,
        plies: Vec<PlyInput>,
        quick_limit: Limit,
        deep_limit: Limit,
        allow_deep_pass: bool,
    ) -> Self {
        let analyzer_name = analyzer.name();
        Self {
            analyzer,
            analyzer_name,
            points: Vec::with_capacity(plies.len()),
            plies,
            quick_limit,
            deep_limit,
            quick_index: 0,
            deep_index: 0,
            deep_pass: false,
            allow_deep_pass,
            cancelled: false,
            memo: SearchMemo::new(),
        }
    }

    pub fn advance(&mut self) -> Result<Option<ReviewStep>, ReviewError> {
        let mut never_stop = || false;
        self.advance_until(&mut never_stop)
    }

    pub fn advance_until(
        &mut self,
        should_stop: &mut dyn FnMut() -> bool,
    ) -> Result<Option<ReviewStep>, ReviewError> {
        if self.cancelled {
            return Ok(None);
        }
        if should_stop() {
            self.cancelled = true;
            return Ok(None);
        }

        if !self.deep_pass {
            if self.quick_index == self.plies.len() {
                if !self.allow_deep_pass {
                    return Ok(None);
                }
                self.deep_pass = true;
            } else {
                let index = self.quick_index;
                let quick = match review_one_move_until(
                    &mut self.analyzer,
                    &self.plies[index].game,
                    self.plies[index].played_move,
                    self.quick_limit,
                    should_stop,
                    Some(&mut self.memo),
                ) {
                    Ok(result) => result,
                    Err(ReviewError::Cancelled) => {
                        self.cancelled = true;
                        return Ok(None);
                    }
                    Err(error) => return Err(error),
                };
                // A single pass is final already; in the two-pass flow the quick result is not
                // topped up.
                let mut final_result = quick.clone();
                if !self.allow_deep_pass {
                    extend_comparison(
                        &mut self.analyzer,
                        &self.plies[index].game,
                        self.plies[index].played_move,
                        &mut final_result,
                        should_stop,
                    );
                }
                self.points.push(TwoPassPlyAnalysis {
                    quick,
                    final_result,
                    deepened: false,
                });
                self.quick_index += 1;
                return Ok(Some(ReviewStep::Point {
                    pass: ReviewPass::Quick,
                    index,
                    result: self.points.last().expect("point was just appended").clone(),
                }));
            }
        }

        while self.deep_index < self.points.len() {
            let index = self.deep_index;
            self.deep_index += 1;
            if !should_deepen(self.points[index].quick.loss_percent) {
                continue;
            }
            let mut deep = match review_one_move_until(
                &mut self.analyzer,
                &self.plies[index].game,
                self.plies[index].played_move,
                self.deep_limit,
                should_stop,
                Some(&mut self.memo),
            ) {
                Ok(result) => result,
                Err(ReviewError::Cancelled) => {
                    self.cancelled = true;
                    return Ok(None);
                }
                Err(error) => return Err(error),
            };
            extend_comparison(
                &mut self.analyzer,
                &self.plies[index].game,
                self.plies[index].played_move,
                &mut deep,
                should_stop,
            );
            self.points[index].final_result = deep;
            self.points[index].deepened = true;
            return Ok(Some(ReviewStep::Point {
                pass: ReviewPass::Deep,
                index,
                result: self.points[index].clone(),
            }));
        }
        Ok(None)
    }

    /// Searches run and searches answered from an earlier one, for the plies analyzed so far
    /// (continuation top-ups are not counted).
    pub fn search_counts(&self) -> (u64, u64) {
        (self.memo.searches(), self.memo.reused())
    }

    pub fn cancel(&mut self) -> ReviewReport {
        self.cancelled = true;
        self.report()
    }

    pub fn report(&self) -> ReviewReport {
        ReviewReport {
            analyzer: self.analyzer_name.clone(),
            points: self.points.clone(),
            cancelled: self.cancelled,
        }
    }
}

/// Run a quick scan over the entire supplied game prefix, then deepen only losses >5%.
/// Cancellation never publishes a partly analyzed ply; completed points remain in the report.
pub fn review_game_two_pass_until<A: Analyzer + ?Sized>(
    analyzer: &mut A,
    plies: &[PlyInput],
    quick_limit: Limit,
    deep_limit: Limit,
    should_stop: &mut dyn FnMut() -> bool,
) -> Result<ReviewReport, ReviewError> {
    let mut incremental = IncrementalReview::new(analyzer, plies.to_vec(), quick_limit, deep_limit);
    loop {
        match incremental.advance_until(should_stop) {
            Ok(Some(_)) => {}
            Ok(None) => return Ok(incremental.report()),
            Err(error) => return Err(error),
        }
    }
}

fn should_deepen(loss_percent: f64) -> bool {
    loss_percent > 5.0
}

/// Hard cap of the no-line retry: the larger of this and the original budget times
/// `RETRY_CAP_FACTOR`.
const RETRY_CAP_MIN_NODES: u64 = 2_000_000;
const RETRY_CAP_FACTOR: u64 = 64;

/// Adapter from the in-process searcher to the review analyzer boundary.
///
/// Each review line carries the engine's principal variation (`Line::principal_variation`) with
/// the reason it ended (`Line::pv_end`). The PV is not guaranteed to be long: a transposition
/// cutoff or a forced move can end it early, and it can be empty when no iteration completed.
pub struct BuiltinAnalyzer {
    config: xq_engine::SearchConfig,
}

impl BuiltinAnalyzer {
    pub fn new(config: xq_engine::SearchConfig) -> Self {
        Self { config }
    }
}

impl Analyzer for BuiltinAnalyzer {
    fn analyze(&mut self, pos: &Position, limit: Limit, multipv: usize) -> Vec<Line> {
        self.analyze_game(&Game::new(pos.clone()), limit, multipv)
    }

    fn analyze_game(&mut self, game: &Game, limit: Limit, multipv: usize) -> Vec<Line> {
        let mut never_stop = || false;
        self.analyze_game_until(game, limit, multipv, &mut never_stop)
    }

    fn analyze_until(
        &mut self,
        pos: &Position,
        limit: Limit,
        multipv: usize,
        should_stop: &mut dyn FnMut() -> bool,
    ) -> Vec<Line> {
        self.analyze_game_until(&Game::new(pos.clone()), limit, multipv, should_stop)
    }

    fn analyze_game_until(
        &mut self,
        game: &Game,
        limit: Limit,
        multipv: usize,
        should_stop: &mut dyn FnMut() -> bool,
    ) -> Vec<Line> {
        if limit.nodes == 0 || multipv == 0 {
            return Vec::new();
        }
        let legal_moves = game.position().clone().legal_moves();
        let forced_move = legal_moves.len() == 1;
        // At least 1: the retry multiplies by 4, and 0 * 4 stays 0 forever.
        let budget = self.config.node_limit.min(limit.nodes).max(1);
        // A position with legal moves should yield at least one line. When the first search
        // iteration does not fit the node budget (the position 2bakab2/.../1NBA1AB2 w needs
        // about 168k nodes for depth 1; Red is not in check there), retry with a 4x larger
        // budget each time until a line appears, the search is cancelled, or the hard cap
        // is reached. The search itself is untouched and a budget that already produced
        // lines is never retried. If the cap is reached with no line the result stays empty.
        let hard_cap = budget
            .saturating_mul(RETRY_CAP_FACTOR)
            .max(RETRY_CAP_MIN_NODES);
        let mut nodes = budget;
        let entries = loop {
            let mut config = self.config.clone();
            config.node_limit = nodes;
            let searcher = xq_engine::Searcher::new(config);
            let entries: Vec<_> = searcher
                .search_multipv_with_principal_variation(game, multipv, &mut *should_stop)
                .into_iter()
                .filter(|entry| forced_move || entry.line.depth > 0)
                .collect();
            if !entries.is_empty() || should_stop() || nodes >= hard_cap {
                break entries;
            }
            nodes = nodes.saturating_mul(4).min(hard_cap);
        };
        entries
            .into_iter()
            .map(|entry| Line {
                best_move: entry.line.best_move,
                score: ReviewScore {
                    centipawns: entry.line.score,
                    mate_in: entry.line.mate_in.map(|distance| {
                        if entry.line.score < 0 {
                            -i16::from(distance)
                        } else {
                            i16::from(distance)
                        }
                    }),
                },
                principal_variation: entry.principal_variation,
                depth: entry.line.depth,
                nodes: entry.nodes,
                pv_end: entry.end,
            })
            .collect()
    }

    /// `Searcher::search_multipv_impl` searches every root move with a full window in a fixed
    /// order and only cuts the finished list with `take(count)`; the node-limit retry, the
    /// forced-move case and the depth filter do not look at the line count either.
    fn first_line_ignores_multipv(&self) -> bool {
        true
    }

    fn name(&self) -> String {
        "內建引擎".to_owned()
    }
}

#[cfg(test)]
mod threshold_tests {
    use super::should_deepen;

    #[test]
    fn second_pass_threshold_is_strictly_greater_than_five_percent() {
        assert!(!should_deepen(5.0));
        assert!(should_deepen(5.000_001));
    }
}
