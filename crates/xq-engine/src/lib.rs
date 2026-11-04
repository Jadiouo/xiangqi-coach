//! Deterministic CPU Xiangqi search and evaluation.

pub mod difficulty;

use std::collections::HashMap;
use xq_core::{Game, GameOutcome, Move, PieceKind, Position, Side};

const MATE: i32 = 30_000;
const MAX_QUIESCENCE_PLY: u8 = 12;
const MAX_SEARCH_PLY: u8 = 96;
const MAX_CHECK_EXTENSIONS: u8 = 8;
const VALUES: [i32; 7] = [0, 120, 120, 300, 600, 300, 70];

const POSITION_SQUARE_TABLE: [[i16; 90]; 7] = build_position_square_table();

const fn build_position_square_table() -> [[i16; 90]; 7] {
    let mut table = [[0; 90]; 7];
    let mut rank = 0;
    while rank < 10 {
        let mut file = 0;
        while file < 9 {
            let index = rank * 9 + file;
            table[PieceKind::Pawn as usize][index] = (rank * 2) as i16;
            let centrality = 4 - (file as i32 - 4).abs();
            table[PieceKind::Horse as usize][index] = centrality as i16;
            table[PieceKind::Rook as usize][index] = centrality as i16;
            table[PieceKind::Cannon as usize][index] = centrality as i16;
            file += 1;
        }
        rank += 1;
    }
    table
}

fn position_square_value(kind: PieceKind, side: Side, square: xq_core::Square) -> i32 {
    let relative_rank = if side == Side::Red {
        square.rank()
    } else {
        9 - square.rank()
    };
    let relative_square = xq_core::Square::new(square.file(), relative_rank)
        .expect("relative square remains on board");
    i32::from(POSITION_SQUARE_TABLE[kind as usize][relative_square.index()])
}

#[derive(Clone, Debug)]
pub struct SearchConfig {
    pub node_limit: u64,
    pub max_depth: u8,
    pub use_transposition_table: bool,
    pub use_move_ordering: bool,
    /// Bounded check extension, paired with root alpha in the accepted M4 configuration.
    pub use_check_extensions: bool,
    /// Root alpha narrowing, paired with check extensions in the accepted M4 configuration.
    pub use_root_alpha: bool,
    /// Per-search quiet killer and history ordering candidate.
    pub use_killer_history_ordering: bool,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            node_limit: 100_000,
            max_depth: 32,
            use_transposition_table: true,
            use_move_ordering: true,
            use_check_extensions: true,
            use_root_alpha: true,
            use_killer_history_ordering: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Evaluation {
    pub material: i32,
    pub position: i32,
    pub mobility: i32,
    pub king_safety: i32,
    pub total: i32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SearchResult {
    pub best_move: Option<Move>,
    /// Centipawns, positive from the side-to-move's perspective.
    pub score: i32,
    pub nodes: u64,
    pub depth: u8,
    pub mate_in: Option<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SearchLine {
    pub best_move: Move,
    pub score: i32,
    pub depth: u8,
    pub mate_in: Option<u8>,
}

/// Why an observed principal variation ended.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PrincipalVariationEnd {
    /// The replayed line reached a game outcome.
    Terminal,
    /// The line reached the main search depth boundary.
    DepthLimit,
    /// The search reused a cached score without a stored path.
    TranspositionCutoff,
    /// The only legal root move was returned without searching.
    ForcedMove,
    /// No full iteration completed, so no searched path is available.
    NoCompletedIteration,
}

/// A MultiPV candidate together with the path recorded during that same search.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchPvLine {
    pub line: SearchLine,
    pub nodes: u64,
    pub principal_variation: Vec<Move>,
    pub end: PrincipalVariationEnd,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ForcedMate {
    pub first_move: Move,
    pub in_attack_moves: u8,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MateProof {
    /// False means a node cap stopped at least one branch; no uniqueness claim is valid.
    pub complete: bool,
    /// Every root move is classified by its shortest proven forced mate distance.
    pub forced_mates: Vec<ForcedMate>,
    /// Number of (root move, depth) branches fully classified.
    pub root_branches_checked: usize,
    pub nodes: u64,
}

impl MateProof {
    /// Return a unique first move only when the full tree proves exactly that distance.
    pub fn unique_for_target(&self, target_attack_moves: u8) -> Option<Move> {
        if self.complete
            && self.forced_mates.len() == 1
            && self.forced_mates[0].in_attack_moves == target_attack_moves
        {
            Some(self.forced_mates[0].first_move)
        } else {
            None
        }
    }
}

/// Exhaustively classify root moves by shortest forced mate distance up to the limit.
/// The node cap is a hard safety bound: a capped result is explicitly incomplete.
pub fn prove_shortest_mates(game: &Game, max_attack_moves: u8, node_limit: u64) -> MateProof {
    let mut root = game.clone();
    let mut position = root.position().clone();
    let mut moves = position.legal_moves();
    moves.sort_by_key(|movement| movement.to_iccs());
    let mut proof = MateProof {
        complete: true,
        forced_mates: Vec::new(),
        root_branches_checked: 0,
        nodes: 0,
    };
    if root.outcome().is_some() {
        return proof;
    }
    let attacker = root.position().side_to_move();
    for depth in 1..=max_attack_moves {
        for movement in &moves {
            if proof
                .forced_mates
                .iter()
                .any(|mate| mate.first_move == *movement)
            {
                continue;
            }
            if proof.nodes >= node_limit {
                proof.complete = false;
                return proof;
            }
            root.play(*movement).expect("generated move remains legal");
            let forced = if root.outcome() == Some(GameOutcome::Win(attacker)) {
                Some(true)
            } else {
                force_mate(
                    &mut root,
                    attacker,
                    depth - 1,
                    false,
                    &mut proof.nodes,
                    node_limit,
                )
            };
            root.undo_last_move();
            proof.root_branches_checked += 1;
            match forced {
                Some(true) => proof.forced_mates.push(ForcedMate {
                    first_move: *movement,
                    in_attack_moves: depth,
                }),
                Some(false) => {}
                None => {
                    proof.complete = false;
                    return proof;
                }
            }
        }
    }
    proof
        .forced_mates
        .sort_by_key(|mate| mate.first_move.to_iccs());
    proof
}

fn force_mate(
    game: &mut Game,
    attacker: Side,
    remaining_attack_moves: u8,
    attacker_to_move: bool,
    nodes: &mut u64,
    node_limit: u64,
) -> Option<bool> {
    if *nodes >= node_limit {
        return None;
    }
    *nodes += 1;
    if let Some(outcome) = game.outcome() {
        return Some(outcome == GameOutcome::Win(attacker));
    }
    if remaining_attack_moves == 0 {
        return Some(false);
    }
    let mut position = game.position().clone();
    let mut moves = position.legal_moves();
    moves.sort_by_key(|movement| movement.to_iccs());
    if attacker_to_move {
        for movement in moves {
            game.play(movement).expect("generated move remains legal");
            let outcome = force_mate(
                game,
                attacker,
                remaining_attack_moves - 1,
                false,
                nodes,
                node_limit,
            );
            game.undo_last_move();
            match outcome {
                Some(true) => return Some(true),
                Some(false) => {}
                None => return None,
            }
        }
        Some(false)
    } else {
        for movement in moves {
            game.play(movement).expect("generated move remains legal");
            let outcome = force_mate(
                game,
                attacker,
                remaining_attack_moves,
                true,
                nodes,
                node_limit,
            );
            game.undo_last_move();
            match outcome {
                Some(false) => return Some(false),
                Some(true) => {}
                None => return None,
            }
        }
        Some(true)
    }
}

#[derive(Clone, Debug)]
pub struct Searcher {
    config: SearchConfig,
}

#[derive(Clone, Debug)]
struct PrincipalVariationRecorder {
    lines: Vec<Vec<Move>>,
    ends: Vec<PrincipalVariationEnd>,
}

trait PrincipalVariationObserver {
    fn begin(&mut self, ply: usize);
    fn finish(&mut self, ply: usize, end: PrincipalVariationEnd);
    fn follow(&mut self, ply: usize, movement: Move);
}

#[derive(Clone, Copy, Debug)]
struct NoPrincipalVariation;

impl PrincipalVariationObserver for NoPrincipalVariation {
    #[inline(always)]
    fn begin(&mut self, _: usize) {}
    #[inline(always)]
    fn finish(&mut self, _: usize, _: PrincipalVariationEnd) {}
    #[inline(always)]
    fn follow(&mut self, _: usize, _: Move) {}
}

impl PrincipalVariationRecorder {
    fn new() -> Self {
        Self {
            lines: vec![Vec::new()],
            ends: vec![PrincipalVariationEnd::DepthLimit],
        }
    }

    fn begin(&mut self, ply: usize) {
        if self.lines.len() <= ply + 1 {
            self.lines.resize_with(ply + 2, Vec::new);
            self.ends.resize(ply + 2, PrincipalVariationEnd::DepthLimit);
        }
        self.lines[ply].clear();
        self.ends[ply] = PrincipalVariationEnd::DepthLimit;
    }

    fn follow(&mut self, ply: usize, movement: Move) {
        let child_line = self.lines[ply + 1].clone();
        let child_end = self.ends[ply + 1];
        self.lines[ply].clear();
        self.lines[ply].push(movement);
        self.lines[ply].extend(child_line);
        self.ends[ply] = child_end;
    }
}

impl PrincipalVariationObserver for PrincipalVariationRecorder {
    #[inline(always)]
    fn begin(&mut self, ply: usize) {
        PrincipalVariationRecorder::begin(self, ply);
    }
    #[inline(always)]
    fn finish(&mut self, ply: usize, end: PrincipalVariationEnd) {
        self.ends[ply] = end;
    }
    #[inline(always)]
    fn follow(&mut self, ply: usize, movement: Move) {
        PrincipalVariationRecorder::follow(self, ply, movement);
    }
}

#[derive(Clone, Debug)]
struct MoveOrderingState {
    enabled: bool,
    killers: Vec<[Option<Move>; 2]>,
    history: [[[u16; 90]; 90]; 2],
}

impl MoveOrderingState {
    fn new(enabled: bool) -> Self {
        Self {
            enabled,
            killers: Vec::new(),
            history: [[[0; 90]; 90]; 2],
        }
    }

    fn record_quiet_cutoff(&mut self, movement: Move, side: Side, ply: u8, depth: u8) {
        if !self.enabled {
            return;
        }
        let index = usize::from(ply);
        if self.killers.len() <= index {
            self.killers.resize(index + 1, [None; 2]);
        }
        if self.killers[index][0] != Some(movement) {
            self.killers[index][1] = self.killers[index][0];
            self.killers[index][0] = Some(movement);
        }
        let side_index = usize::from(side == Side::Black);
        let score = &mut self.history[side_index][movement.from.index()][movement.to.index()];
        *score = score
            .saturating_add(u16::from(depth).saturating_mul(u16::from(depth)))
            .min(10_000);
    }

    fn quiet_rank(&self, movement: Move, side: Side, ply: u8) -> (u8, u16) {
        let killer_rank = self.killers.get(usize::from(ply)).map_or(2, |killers| {
            if killers[0] == Some(movement) {
                0
            } else if killers[1] == Some(movement) {
                1
            } else {
                2
            }
        });
        let side_index = usize::from(side == Side::Black);
        (
            killer_rank,
            self.history[side_index][movement.from.index()][movement.to.index()],
        )
    }
}

impl Searcher {
    pub fn new(config: SearchConfig) -> Self {
        Self { config }
    }

    pub fn search(&self, position: &Position) -> SearchResult {
        self.search_game(&Game::new(position.clone()))
    }

    /// Search a game while preserving repetition and no-capture history.
    pub fn search_game(&self, game: &Game) -> SearchResult {
        self.search_game_until(game, || false)
    }

    /// Search until the node cap, maximum depth, or caller-provided stop signal.
    pub fn search_game_until(
        &self,
        game: &Game,
        mut should_stop: impl FnMut() -> bool,
    ) -> SearchResult {
        let mut root = game.clone();
        if let Some(outcome) = root.outcome() {
            return SearchResult {
                best_move: None,
                score: outcome_score(outcome, root.position().side_to_move()),
                nodes: 0,
                depth: 0,
                mate_in: None,
            };
        }
        let mut root_position = root.position().clone();
        let mut moves = root_position.legal_moves();
        moves.sort_by_key(|movement| movement.to_iccs());
        if moves.len() == 1 {
            return SearchResult {
                best_move: Some(moves[0]),
                score: evaluate(&root_position).total,
                nodes: 0,
                depth: 0,
                mate_in: None,
            };
        }
        let mut result = SearchResult {
            best_move: Some(moves[0]),
            score: evaluate(&root_position).total,
            nodes: 0,
            depth: 0,
            mate_in: None,
        };
        let mut table = HashMap::new();
        let mut ordering = MoveOrderingState::new(self.config.use_killer_history_ordering);
        for depth in 1..=self.config.max_depth {
            let mut best_score = i32::MIN / 2;
            let mut best_move = result.best_move.unwrap_or(moves[0]);
            let mut completed = true;
            let mut aborted = false;
            for movement in &moves {
                if result.nodes >= self.config.node_limit || should_stop() {
                    completed = false;
                    break;
                }
                root.play(*movement).expect("legal move remains legal");
                let narrowed = self.config.use_root_alpha && best_score != i32::MIN / 2;
                let (alpha, beta) = if narrowed {
                    (-best_score - 1, -best_score)
                } else {
                    (-MATE, MATE)
                };
                let extends = self.config.use_check_extensions
                    && root.position().is_in_check(root.position().side_to_move());
                let child_depth = if extends { depth } else { depth - 1 };
                let child_extensions_left = MAX_CHECK_EXTENSIONS - u8::from(extends);
                let mut score = -negamax_game(
                    &mut root,
                    child_depth,
                    child_extensions_left,
                    alpha,
                    beta,
                    &mut result.nodes,
                    self.config.node_limit,
                    1,
                    self.config.use_transposition_table,
                    &mut table,
                    self.config.use_check_extensions,
                    self.config.use_move_ordering,
                    &mut ordering,
                    &mut aborted,
                    &mut should_stop,
                );
                score = step_mate_score(score);
                let mut exact = !narrowed;
                if narrowed && !aborted && (score > best_score || is_mate_score(score)) {
                    if should_stop() {
                        completed = false;
                        root.undo_last_move();
                        break;
                    }
                    score = -negamax_game(
                        &mut root,
                        child_depth,
                        child_extensions_left,
                        -MATE,
                        MATE,
                        &mut result.nodes,
                        self.config.node_limit,
                        1,
                        self.config.use_transposition_table,
                        &mut table,
                        self.config.use_check_extensions,
                        self.config.use_move_ordering,
                        &mut ordering,
                        &mut aborted,
                        &mut should_stop,
                    );
                    score = step_mate_score(score);
                    exact = true;
                }
                root.undo_last_move();
                if aborted {
                    completed = false;
                    break;
                }
                if should_stop() {
                    completed = false;
                    break;
                }
                if exact && score > best_score {
                    best_score = score;
                    best_move = *movement;
                }
                if result.nodes >= self.config.node_limit && movement != moves.last().unwrap() {
                    completed = false;
                    break;
                }
            }
            if completed && best_score != i32::MIN / 2 {
                result.best_move = Some(best_move);
                result.score = best_score;
                result.depth = depth;
                result.mate_in = mate_distance(best_score);
            }
            if !completed || result.nodes >= self.config.node_limit {
                break;
            }
        }
        result
    }

    /// Return up to `count` distinct principal moves, best first.
    pub fn search_multipv(&self, game: &Game, count: usize) -> Vec<SearchLine> {
        self.search_multipv_until(game, count, || false)
    }

    /// MultiPV search with a caller-provided cancellation signal.
    pub fn search_multipv_until(
        &self,
        game: &Game,
        count: usize,
        should_stop: impl FnMut() -> bool,
    ) -> Vec<SearchLine> {
        self.search_multipv_with_progress(game, count, should_stop, |_, _, _| {})
    }

    /// MultiPV search that notifies the caller after each fully completed, sorted depth.
    /// The observer cannot alter search control; incomplete depths are never reported.
    pub fn search_multipv_with_progress(
        &self,
        game: &Game,
        count: usize,
        should_stop: impl FnMut() -> bool,
        on_completed_iteration: impl FnMut(u8, u64, &[SearchLine]),
    ) -> Vec<SearchLine> {
        self.search_multipv_impl(game, count, should_stop, false, on_completed_iteration)
            .0
    }

    /// Search MultiPV and return principal paths observed during those same iterations.
    /// This opt-in trace adds no search nodes and does not reconstruct paths from the TT.
    pub fn search_multipv_with_principal_variation(
        &self,
        game: &Game,
        count: usize,
        should_stop: impl FnMut() -> bool,
    ) -> Vec<SearchPvLine> {
        self.search_multipv_impl(game, count, should_stop, true, |_, _, _| {})
            .1
    }

    fn search_multipv_impl(
        &self,
        game: &Game,
        count: usize,
        mut should_stop: impl FnMut() -> bool,
        capture_principal_variation: bool,
        mut on_completed_iteration: impl FnMut(u8, u64, &[SearchLine]),
    ) -> (Vec<SearchLine>, Vec<SearchPvLine>) {
        if count == 0 || game.outcome().is_some() {
            return (Vec::new(), Vec::new());
        }
        let mut root = game.clone();
        let mut position = root.position().clone();
        let mut moves = position.legal_moves();
        moves.sort_by_key(|movement| movement.to_iccs());
        if moves.len() == 1 {
            let line = SearchLine {
                best_move: moves[0],
                score: evaluate(&position).total,
                depth: 0,
                mate_in: None,
            };
            let observed = capture_principal_variation
                .then(|| SearchPvLine {
                    line,
                    nodes: 0,
                    principal_variation: vec![moves[0]],
                    end: PrincipalVariationEnd::ForcedMove,
                })
                .into_iter()
                .collect();
            return (vec![line], observed);
        }
        let mut nodes = 0;
        let mut table = HashMap::new();
        let mut ordering = MoveOrderingState::new(self.config.use_killer_history_ordering);
        let fallback = moves[0];
        let fallback_line = SearchLine {
            best_move: fallback,
            score: evaluate(&position).total,
            depth: 0,
            mate_in: None,
        };
        let mut final_lines = vec![fallback_line];
        let mut final_pv_lines = capture_principal_variation
            .then(|| SearchPvLine {
                line: fallback_line,
                nodes: 0,
                principal_variation: Vec::new(),
                end: PrincipalVariationEnd::NoCompletedIteration,
            })
            .into_iter()
            .collect::<Vec<_>>();
        for depth in 1..=self.config.max_depth {
            let mut lines = Vec::new();
            let mut traces = HashMap::new();
            let mut complete = true;
            let mut aborted = false;
            for movement in &moves {
                if nodes >= self.config.node_limit || should_stop() {
                    complete = false;
                    break;
                }
                root.play(*movement).expect("generated move remains legal");
                let extends = self.config.use_check_extensions
                    && root.position().is_in_check(root.position().side_to_move());
                let child_depth = if extends { depth } else { depth - 1 };
                let child_extensions_left = MAX_CHECK_EXTENSIONS - u8::from(extends);
                let mut recorder =
                    capture_principal_variation.then(PrincipalVariationRecorder::new);
                let score = if let Some(recorder) = recorder.as_mut() {
                    -negamax_game_observed(
                        &mut root,
                        child_depth,
                        child_extensions_left,
                        -MATE,
                        MATE,
                        &mut nodes,
                        self.config.node_limit,
                        1,
                        self.config.use_transposition_table,
                        &mut table,
                        self.config.use_check_extensions,
                        self.config.use_move_ordering,
                        &mut ordering,
                        &mut aborted,
                        &mut should_stop,
                        recorder,
                    )
                } else {
                    -negamax_game(
                        &mut root,
                        child_depth,
                        child_extensions_left,
                        -MATE,
                        MATE,
                        &mut nodes,
                        self.config.node_limit,
                        1,
                        self.config.use_transposition_table,
                        &mut table,
                        self.config.use_check_extensions,
                        self.config.use_move_ordering,
                        &mut ordering,
                        &mut aborted,
                        &mut should_stop,
                    )
                };
                root.undo_last_move();
                if aborted {
                    complete = false;
                    break;
                }
                let score = step_mate_score(score);
                if should_stop() {
                    complete = false;
                    break;
                }
                let line = SearchLine {
                    best_move: *movement,
                    score,
                    depth,
                    mate_in: mate_distance(score),
                };
                if let Some(recorder) = recorder {
                    let child_line = recorder.lines.get(1).cloned().unwrap_or_default();
                    let mut principal_variation = Vec::with_capacity(child_line.len() + 1);
                    principal_variation.push(*movement);
                    principal_variation.extend(child_line);
                    let end = recorder
                        .ends
                        .get(1)
                        .copied()
                        .unwrap_or(PrincipalVariationEnd::DepthLimit);
                    traces.insert(*movement, (principal_variation, end));
                }
                lines.push(line);
            }
            if !complete {
                break;
            }
            lines.sort_by(|a, b| {
                b.score
                    .cmp(&a.score)
                    .then_with(|| a.best_move.to_iccs().cmp(&b.best_move.to_iccs()))
            });
            final_lines = lines.into_iter().take(count).collect();
            if capture_principal_variation {
                final_pv_lines = final_lines
                    .iter()
                    .map(|line| {
                        let (principal_variation, end) =
                            traces.remove(&line.best_move).unwrap_or_else(|| {
                                (vec![line.best_move], PrincipalVariationEnd::DepthLimit)
                            });
                        SearchPvLine {
                            line: *line,
                            nodes,
                            principal_variation,
                            end,
                        }
                    })
                    .collect();
            }
            on_completed_iteration(depth, nodes, &final_lines);
            if nodes >= self.config.node_limit {
                break;
            }
        }
        (final_lines, final_pv_lines)
    }
}

#[allow(clippy::too_many_arguments)] // Search state is explicit and supplied by the caller.
fn negamax_game(
    game: &mut Game,
    depth: u8,
    extensions_left: u8,
    alpha: i32,
    beta: i32,
    nodes: &mut u64,
    limit: u64,
    ply: u8,
    use_table: bool,
    table: &mut HashMap<(u64, u8, u8), i32>,
    use_check_extensions: bool,
    use_ordering: bool,
    ordering: &mut MoveOrderingState,
    aborted: &mut bool,
    should_stop: &mut impl FnMut() -> bool,
) -> i32 {
    let mut no_pv = NoPrincipalVariation;
    negamax_game_observed(
        game,
        depth,
        extensions_left,
        alpha,
        beta,
        nodes,
        limit,
        ply,
        use_table,
        table,
        use_check_extensions,
        use_ordering,
        ordering,
        aborted,
        should_stop,
        &mut no_pv,
    )
}

#[allow(clippy::too_many_arguments)] // Search state and statically dispatched PV observation are explicit.
fn negamax_game_observed<P: PrincipalVariationObserver>(
    game: &mut Game,
    depth: u8,
    extensions_left: u8,
    alpha: i32,
    beta: i32,
    nodes: &mut u64,
    limit: u64,
    ply: u8,
    use_table: bool,
    table: &mut HashMap<(u64, u8, u8), i32>,
    use_check_extensions: bool,
    use_ordering: bool,
    ordering: &mut MoveOrderingState,
    aborted: &mut bool,
    should_stop: &mut impl FnMut() -> bool,
    pv: &mut P,
) -> i32 {
    pv.begin(usize::from(ply));
    if should_stop() {
        *aborted = true;
        return evaluate(game.position()).total;
    }
    if let Some(outcome) = game.outcome() {
        pv.finish(usize::from(ply), PrincipalVariationEnd::Terminal);
        return outcome_score(outcome, game.position().side_to_move());
    }
    if *nodes >= limit {
        *aborted = true;
        return evaluate(game.position()).total;
    }
    let key = (game.context_key(), depth, extensions_left);
    if use_table && let Some(score) = table.get(&key) {
        pv.finish(usize::from(ply), PrincipalVariationEnd::TranspositionCutoff);
        return score_from_table(*score, ply);
    }
    *nodes += 1;
    if use_check_extensions && ply >= MAX_SEARCH_PLY {
        return evaluate(game.position()).total;
    }
    if depth == 0 {
        return quiescence(game, alpha, beta, nodes, limit, 0, aborted, should_stop);
    }
    let original_alpha = alpha;
    let mut position = game.position().clone();
    let mut moves = position.legal_moves();
    order_moves(&position, &mut moves, use_ordering, ordering, ply);
    let mut alpha = alpha;
    let mut best = -MATE;
    let mut cutoff = false;
    for movement in moves {
        if *nodes >= limit || should_stop() {
            *aborted = true;
            break;
        }
        game.play(movement).expect("generated move remains legal");
        let child_in_check = game.position().is_in_check(game.position().side_to_move());
        let extends = use_check_extensions && extensions_left > 0 && child_in_check;
        let child_depth = if extends { depth } else { depth - 1 };
        let child_extensions_left = if extends {
            extensions_left - 1
        } else {
            extensions_left
        };
        let child_score = negamax_game_observed(
            game,
            child_depth,
            child_extensions_left,
            -beta,
            -alpha,
            nodes,
            limit,
            ply + 1,
            use_table,
            table,
            use_check_extensions,
            use_ordering,
            ordering,
            aborted,
            should_stop,
            pv,
        );
        game.undo_last_move();
        if *aborted {
            break;
        }
        let score = step_mate_score(-child_score);
        if should_stop() {
            *aborted = true;
            break;
        }
        if score > best {
            best = score;
            pv.follow(usize::from(ply), movement);
        }
        alpha = alpha.max(score);
        if alpha >= beta {
            cutoff = true;
            if position.piece_at(movement.to).is_none() {
                ordering.record_quiet_cutoff(movement, position.side_to_move(), ply, depth);
            }
            break;
        }
    }
    let score = if best == -MATE {
        evaluate(&position).total
    } else {
        best
    };
    if use_table
        && !cutoff
        && score > original_alpha
        && !*aborted
        && *nodes < limit
        && !should_stop()
    {
        table.insert(key, score_to_table(score, ply));
    }
    score
}

fn outcome_score(outcome: GameOutcome, side_to_move: Side) -> i32 {
    match outcome {
        GameOutcome::Draw => 0,
        GameOutcome::Win(winner) if winner == side_to_move => MATE,
        GameOutcome::Win(_) => -MATE,
    }
}

fn step_mate_score(score: i32) -> i32 {
    if score >= MATE - 100 {
        score - 1
    } else if score <= -MATE + 100 {
        score + 1
    } else {
        score
    }
}

fn score_to_table(score: i32, ply: u8) -> i32 {
    if score >= MATE - 100 {
        score + i32::from(ply)
    } else if score <= -MATE + 100 {
        score - i32::from(ply)
    } else {
        score
    }
}

fn score_from_table(score: i32, ply: u8) -> i32 {
    if score >= MATE - 100 {
        score - i32::from(ply)
    } else if score <= -MATE + 100 {
        score + i32::from(ply)
    } else {
        score
    }
}

fn order_moves(
    position: &Position,
    moves: &mut [Move],
    enabled: bool,
    ordering: &MoveOrderingState,
    ply: u8,
) {
    if enabled {
        moves.sort_by_key(|movement| {
            if let Some(piece) = position.piece_at(movement.to) {
                (
                    0_u8,
                    std::cmp::Reverse(VALUES[piece.kind as usize]),
                    0_u8,
                    std::cmp::Reverse(0_u16),
                    movement.to_iccs(),
                )
            } else {
                let (killer, history) = if ordering.enabled {
                    ordering.quiet_rank(*movement, position.side_to_move(), ply)
                } else {
                    (2, 0)
                };
                (
                    1_u8,
                    std::cmp::Reverse(0),
                    killer,
                    std::cmp::Reverse(history),
                    movement.to_iccs(),
                )
            }
        });
    } else {
        moves.sort_by_key(|movement| movement.to_iccs());
    }
}

#[allow(clippy::too_many_arguments)] // Search state and abort status are explicit.
fn quiescence(
    game: &mut Game,
    mut alpha: i32,
    beta: i32,
    nodes: &mut u64,
    limit: u64,
    ply: u8,
    aborted: &mut bool,
    should_stop: &mut impl FnMut() -> bool,
) -> i32 {
    if should_stop() || *nodes >= limit {
        *aborted = true;
        return evaluate(game.position()).total;
    }
    if let Some(outcome) = game.outcome() {
        return outcome_score(outcome, game.position().side_to_move());
    }
    *nodes += 1;
    let in_check = game.position().is_in_check(game.position().side_to_move());
    let stand_pat = evaluate(game.position()).total;
    if !in_check {
        if stand_pat >= beta {
            return stand_pat;
        }
        alpha = alpha.max(stand_pat);
    }
    if ply >= MAX_QUIESCENCE_PLY {
        return stand_pat;
    }
    let mut position = game.position().clone();
    let mut moves = position.legal_moves();
    if !in_check {
        moves.retain(|movement| position.piece_at(movement.to).is_some());
    }
    order_quiescence_moves(&position, &mut moves);
    for movement in moves {
        if *nodes >= limit || should_stop() {
            *aborted = true;
            break;
        }
        game.play(movement).expect("generated move remains legal");
        let score = -quiescence(
            game,
            -beta,
            -alpha,
            nodes,
            limit,
            ply + 1,
            aborted,
            should_stop,
        );
        game.undo_last_move();
        if *aborted {
            break;
        }
        let score = step_mate_score(score);
        if score >= beta {
            return score;
        }
        alpha = alpha.max(score);
    }
    alpha
}

fn order_quiescence_moves(position: &Position, moves: &mut [Move]) {
    moves.sort_by_key(|movement| {
        let victim = position
            .piece_at(movement.to)
            .map_or(0, |piece| VALUES[piece.kind as usize]);
        (std::cmp::Reverse(victim), movement.to_iccs())
    });
}

pub fn evaluate(position: &Position) -> Evaluation {
    let mut material = 0;
    let mut positional = 0;
    let mut red_king = None;
    let mut black_king = None;
    for rank in 0..10 {
        for file in 0..9 {
            let square = xq_core::Square::new(file, rank).unwrap();
            if let Some(piece) = position.piece_at(square) {
                let sign = side_sign(piece.side);
                material += sign * VALUES[piece.kind as usize];
                positional += sign * position_square_value(piece.kind, piece.side, square);
                if piece.kind == PieceKind::King {
                    if piece.side == Side::Red {
                        red_king = Some(square);
                    } else {
                        black_king = Some(square);
                    }
                }
            }
        }
    }
    let king_safety = red_king.map_or(0, |s| {
        -((s.file() as i32 - 4).abs() + (s.rank() as i32 - 1).abs()) * 2
    }) - black_king.map_or(0, |s| {
        -((s.file() as i32 - 4).abs() + (s.rank() as i32 - 8).abs()) * 2
    });
    let mobility_red = position.legal_moves_for(Side::Red).len() as i32
        - position.legal_moves_for(Side::Black).len() as i32;
    let mobility = mobility_red * 2 * side_sign(position.side_to_move());
    let total_red =
        (material + positional + king_safety) * side_sign(position.side_to_move()) + mobility;
    Evaluation {
        material: material * side_sign(position.side_to_move()),
        position: positional * side_sign(position.side_to_move()),
        mobility,
        king_safety: king_safety * side_sign(position.side_to_move()),
        total: total_red,
    }
}

fn side_sign(side: Side) -> i32 {
    if side == Side::Red { 1 } else { -1 }
}
fn mate_distance(score: i32) -> Option<u8> {
    (score.abs() >= MATE - 100).then_some(((MATE - score.abs() + 1) / 2).max(0) as u8)
}

fn is_mate_score(score: i32) -> bool {
    score >= MATE - 100 || score <= -MATE + 100
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn position_square_table_matches_the_old_formula_for_every_square_and_side() {
        let kinds = [
            PieceKind::King,
            PieceKind::Advisor,
            PieceKind::Elephant,
            PieceKind::Horse,
            PieceKind::Rook,
            PieceKind::Cannon,
            PieceKind::Pawn,
        ];
        for kind in kinds {
            for side in [Side::Red, Side::Black] {
                for rank in 0..10 {
                    for file in 0..9 {
                        let square = xq_core::Square::new(file, rank).unwrap();
                        let expected = match kind {
                            PieceKind::Pawn if side == Side::Red => i32::from(rank) * 2,
                            PieceKind::Pawn => i32::from(9 - rank) * 2,
                            PieceKind::Horse | PieceKind::Rook | PieceKind::Cannon => {
                                4 - (i32::from(file) - 4).abs()
                            }
                            _ => 0,
                        };
                        assert_eq!(position_square_value(kind, side, square), expected);
                        let mirror = xq_core::Square::new(8 - file, rank).unwrap();
                        assert_eq!(position_square_value(kind, side, mirror), expected);
                    }
                }
            }
        }
    }

    #[test]
    fn evaluation_totals_are_frozen_for_reference_positions() {
        // Characterization of the shipped scores (taken before the breakdown was first used
        // by the review reasons): the reasons only read the breakdown, they must never move it.
        let cases = [
            (
                "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1",
                0,
                0,
            ),
            ("4k4/9/9/9/9/9/2R6/9/9/1N1K5 w - - 0 1", 939, 939),
            ("3k5/9/9/9/p8/9/1N7/9/9/4K4 b - - 0 1", -237, -237),
        ];
        for (fen, expected_total, expected_sum) in cases {
            let evaluation = evaluate(&Position::from_fen(fen).unwrap());
            assert_eq!(evaluation.total, expected_total, "{fen}");
            assert_eq!(
                evaluation.material
                    + evaluation.position
                    + evaluation.mobility
                    + evaluation.king_safety,
                expected_sum,
                "{fen}"
            );
        }
    }

    #[test]
    fn evaluation_breakdown_sums_to_total() {
        let evaluation = evaluate(&Position::startpos());
        assert_eq!(
            evaluation.material
                + evaluation.position
                + evaluation.mobility
                + evaluation.king_safety,
            evaluation.total
        );
    }

    #[test]
    fn fail_low_score_is_not_reused_as_an_exact_transposition_value() {
        let fen = "4k4/4r4/9/4p4/9/9/9/9/4R4/3K5 w - - 0 1";
        let mut game = Game::new(Position::from_fen(fen).unwrap());
        let initial_fen = game.position().to_fen();
        let initial_context = game.context_key();
        let mut table = HashMap::new();
        let mut probe_nodes = 0;
        let mut probe_aborted = false;
        let fail_low = negamax_game(
            &mut game,
            2,
            MAX_CHECK_EXTENSIONS,
            -75,
            -74,
            &mut probe_nodes,
            1_000_000,
            0,
            true,
            &mut table,
            false,
            true,
            &mut MoveOrderingState::new(false),
            &mut probe_aborted,
            &mut || false,
        );
        assert!(!probe_aborted);
        assert!(fail_low <= -75, "the narrow-window result is fail-low");
        assert_eq!(game.position().to_fen(), initial_fen);
        assert_eq!(game.context_key(), initial_context);
        let root_key = (initial_context, 2, MAX_CHECK_EXTENSIONS);
        assert!(
            !table.contains_key(&root_key),
            "a fail-low is only an upper bound"
        );

        let mut reference_game = Game::new(Position::from_fen(fen).unwrap());
        let mut reference_nodes = 0;
        let mut reference_aborted = false;
        let reference = negamax_game(
            &mut reference_game,
            2,
            MAX_CHECK_EXTENSIONS,
            -MATE,
            MATE,
            &mut reference_nodes,
            1_000_000,
            0,
            false,
            &mut HashMap::new(),
            false,
            true,
            &mut MoveOrderingState::new(false),
            &mut reference_aborted,
            &mut || false,
        );
        assert!(!reference_aborted);
        assert_eq!(reference, -76);

        let mut reuse_nodes = 0;
        let mut reuse_aborted = false;
        let repaired = negamax_game(
            &mut game,
            2,
            MAX_CHECK_EXTENSIONS,
            -MATE,
            MATE,
            &mut reuse_nodes,
            1_000_000,
            0,
            true,
            &mut table,
            false,
            true,
            &mut MoveOrderingState::new(false),
            &mut reuse_aborted,
            &mut || false,
        );
        assert!(!reuse_aborted);
        assert_eq!(
            repaired, reference,
            "a fail-low bound must not be used as exact"
        );
        assert!(
            reuse_nodes > 0,
            "the fail-low probe did not short-circuit search"
        );
        assert!(
            table.contains_key(&root_key),
            "the full-window result is exact"
        );

        let mut exact_hit_nodes = 0;
        let mut exact_hit_aborted = false;
        let exact_hit = negamax_game(
            &mut game,
            2,
            MAX_CHECK_EXTENSIONS,
            -MATE,
            MATE,
            &mut exact_hit_nodes,
            1_000_000,
            0,
            true,
            &mut table,
            false,
            true,
            &mut MoveOrderingState::new(false),
            &mut exact_hit_aborted,
            &mut || false,
        );
        assert!(!exact_hit_aborted);
        assert_eq!(exact_hit, reference);
        assert_eq!(exact_hit_nodes, 0, "an exact TT result remains reusable");

        let mut cutoff_game = Game::new(Position::from_fen(fen).unwrap());
        let mut cutoff_table = HashMap::new();
        let mut cutoff_nodes = 0;
        let mut cutoff_aborted = false;
        let cutoff_score = negamax_game(
            &mut cutoff_game,
            2,
            MAX_CHECK_EXTENSIONS,
            -77,
            -76,
            &mut cutoff_nodes,
            1_000_000,
            0,
            true,
            &mut cutoff_table,
            false,
            true,
            &mut MoveOrderingState::new(false),
            &mut cutoff_aborted,
            &mut || false,
        );
        assert!(!cutoff_aborted);
        assert!(cutoff_score >= -76, "the narrow search reached beta");
        assert!(
            !cutoff_table.contains_key(&root_key),
            "a cutoff is not exact"
        );

        let mut aborted_game = Game::new(Position::from_fen(fen).unwrap());
        let mut aborted_table = HashMap::new();
        let mut aborted_nodes = 0;
        let mut aborted = false;
        let _ = negamax_game(
            &mut aborted_game,
            2,
            MAX_CHECK_EXTENSIONS,
            -MATE,
            MATE,
            &mut aborted_nodes,
            1,
            0,
            true,
            &mut aborted_table,
            false,
            true,
            &mut MoveOrderingState::new(false),
            &mut aborted,
            &mut || false,
        );
        assert!(aborted);
        assert!(
            !aborted_table.contains_key(&root_key),
            "an incomplete node is not exact"
        );
    }

    #[test]
    fn quiet_ordering_uses_two_killers_then_history_and_keeps_captures_first() {
        let mut position = Position::from_fen("4k4/4r4/9/4p4/9/9/9/9/4R4/3K5 w - - 0 1").unwrap();
        let move_for = |token| Move::from_iccs(token).unwrap();
        let capture = move_for("e1e6");
        let first_killer = move_for("e1d1");
        let second_killer = move_for("e1c1");
        let high_history = move_for("e1h1");
        let low_history = move_for("e1g1");
        let mut moves = position.legal_moves();
        for expected in [
            capture,
            first_killer,
            second_killer,
            high_history,
            low_history,
        ] {
            assert!(
                moves.contains(&expected),
                "fixture move {expected:?} must be legal"
            );
        }

        let mut state = MoveOrderingState::new(true);
        state.record_quiet_cutoff(first_killer, Side::Red, 1, 4);
        state.record_quiet_cutoff(second_killer, Side::Red, 1, 4);
        state.record_quiet_cutoff(low_history, Side::Red, 7, 2);
        state.record_quiet_cutoff(high_history, Side::Red, 8, 4);
        order_moves(&position, &mut moves, true, &state, 1);

        let index = |movement| {
            moves
                .iter()
                .position(|candidate| *candidate == movement)
                .unwrap()
        };
        assert!(
            index(capture) < index(second_killer),
            "captures remain ahead of quiets"
        );
        assert!(
            index(second_killer) < index(first_killer),
            "most recent killer is first"
        );
        assert!(index(first_killer) < index(high_history));
        assert!(
            index(high_history) < index(low_history),
            "history scores rank quiets"
        );
        let quiet_tokens: Vec<_> = moves
            .iter()
            .filter(|movement| position.piece_at(movement.to).is_none())
            .filter(|movement| {
                ![first_killer, second_killer, high_history, low_history].contains(movement)
            })
            .map(|movement| movement.to_iccs())
            .collect();
        assert!(quiet_tokens.windows(2).all(|pair| pair[0] <= pair[1]));
    }

    #[test]
    fn quiet_history_score_saturates_without_overflow() {
        let movement = Move::from_iccs("e1d1").unwrap();
        let mut state = MoveOrderingState::new(true);
        for _ in 0..1_000 {
            state.record_quiet_cutoff(movement, Side::Red, 3, 32);
        }
        assert_eq!(
            state.history[0][movement.from.index()][movement.to.index()],
            10_000
        );
    }
}
