//! Small browser-facing adapter over the pure `xq-core` game API.

mod level;

use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
use xq_core::{
    Game, GameOutcome, ImportErrorKind, ImportWarning, Move, NotationFormat, Position, Side,
    format_chinese_move, import_record as parse_record,
};
use xq_engine::{
    SearchConfig, Searcher,
    difficulty::{DifficultyRequest, choose_move},
};
use xq_review::{
    Analyzer, BuiltinAnalyzer, IncrementalReview, Limit, Line, PlyAnalysis, PlyInput, ReviewPass,
    ReviewStep,
};

#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn xq_wasm_scaffold_version() -> u32 {
    2
}

struct MoveRecord {
    side: Side,
    notation: String,
    iccs: String,
    difficulty_level: Option<u8>,
}

/// Browser-owned session that delegates all rule decisions to `xq-core`.
#[wasm_bindgen]
pub struct WebGame {
    game: Game,
    starting_position: Position,
    records: Vec<MoveRecord>,
    rng_state: u64,
}

impl Default for WebGame {
    fn default() -> Self {
        Self::new()
    }
}

impl WebGame {
    /// Play the analyzer's top-ranked move for the current position (SPEC 8.7 branch reply).
    /// Returns false, leaving the game unchanged, if the game is over, the analyzer
    /// offers no line, or its move is illegal.
    pub(crate) fn play_best_reply<A: Analyzer + ?Sized>(
        &mut self,
        analyzer: &mut A,
        node_limit: u64,
    ) -> bool {
        if self.game.outcome().is_some() {
            return false;
        }
        let lines = analyzer.analyze_game(&self.game, Limit::new(node_limit), 1);
        let Some(line) = lines.first() else {
            return false;
        };
        self.play(&line.best_move.to_iccs())
    }
}

#[wasm_bindgen]
impl WebGame {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WebGame {
        WebGame {
            game: Game::new(Position::startpos()),
            starting_position: Position::startpos(),
            records: Vec::new(),
            rng_state: 1,
        }
    }

    #[wasm_bindgen(js_name = from_fen)]
    pub fn from_fen(fen: &str) -> Result<WebGame, JsValue> {
        let position = Position::from_fen(fen)
            .map_err(|_| JsValue::from_str("起始局面的 FEN 格式不正確。"))?;
        Ok(WebGame::from_position(position))
    }

    fn from_position(position: Position) -> WebGame {
        WebGame {
            game: Game::new(position.clone()),
            starting_position: position,
            records: Vec::new(),
            rng_state: 1,
        }
    }

    pub fn start_fen(&self) -> String {
        self.starting_position.to_fen()
    }

    /// Replace the browser game only after the entire supplied line is legal.
    pub fn load_record(&mut self, start_fen: &str, moves: &str) -> bool {
        let Ok(position) = Position::from_fen(start_fen) else {
            return false;
        };
        let mut candidate = Self::from_position(position);
        if moves
            .split_whitespace()
            .any(|movement| !candidate.play(movement))
        {
            return false;
        }
        *self = candidate;
        true
    }

    /// 90 ASCII cells in display order; see `Position::board_ascii`.
    pub fn board(&self) -> String {
        self.game.position().board_ascii()
    }

    pub fn fen(&self) -> String {
        self.game.position().to_fen()
    }

    pub fn side_to_move(&self) -> String {
        side_token(self.game.position().side_to_move()).to_owned()
    }

    /// Comma-separated ICCS moves. An adjudicated game has no playable moves.
    pub fn legal_moves(&self) -> String {
        if self.game.outcome().is_some() {
            return String::new();
        }
        let mut position = self.game.position().clone();
        position
            .legal_moves()
            .into_iter()
            .map(Move::to_iccs)
            .collect::<Vec<_>>()
            .join(",")
    }

    /// Newline-separated records: `ply|side|Chinese notation|ICCS`.
    pub fn history(&self) -> String {
        self.records
            .iter()
            .enumerate()
            .map(|(index, record)| {
                format!(
                    "{}|{}|{}|{}",
                    index / 2 + 1,
                    side_token(record.side),
                    record.notation,
                    record.iccs
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn last_move(&self) -> String {
        self.records
            .last()
            .map_or_else(String::new, |record| record.iccs.clone())
    }

    /// Difficulty used for the most recent engine move, or 0 before one exists.
    pub fn last_ai_level(&self) -> u8 {
        self.records
            .iter()
            .rev()
            .find_map(|record| record.difficulty_level)
            .unwrap_or(0)
    }

    /// Stable machine-readable result for the interface.
    pub fn outcome(&self) -> String {
        match self.game.outcome() {
            None => "ongoing",
            Some(GameOutcome::Draw) => "draw",
            Some(GameOutcome::Win(Side::Red)) => "red_win",
            Some(GameOutcome::Win(Side::Black)) => "black_win",
        }
        .to_owned()
    }

    /// Attempt one ICCS move. Returns false without changing state on failure.
    pub fn play(&mut self, iccs: &str) -> bool {
        if self.game.outcome().is_some() {
            return false;
        }
        let Ok(movement) = Move::from_iccs(iccs) else {
            return false;
        };
        let Ok(notation) = format_chinese_move(self.game.position(), movement) else {
            return false;
        };
        let side = self.game.position().side_to_move();
        if self.game.play(movement).is_err() {
            return false;
        }
        self.records.push(MoveRecord {
            side,
            notation,
            iccs: movement.to_iccs(),
            difficulty_level: None,
        });
        true
    }

    pub fn undo_last_move(&mut self) -> bool {
        if self.game.undo_last_move().is_none() {
            return false;
        }
        self.records.pop();
        true
    }

    /// Undo the latest human/AI turn as one user action.
    pub fn undo_turn(&mut self) -> bool {
        if !self.undo_last_move() {
            return false;
        }
        if self.game.position().side_to_move() == Side::Black {
            self.undo_last_move();
        }
        true
    }

    /// Search and apply one reply with the selected level and browser-owned RNG state.
    pub fn ai_move(&mut self, node_limit: u32, level: u8) -> bool {
        if self.game.outcome().is_some() {
            return false;
        }
        let node_limit = u64::from(node_limit);
        let decision = choose_move(
            &self.game,
            DifficultyRequest {
                level,
                rng_state: self.rng_state,
                search_config: SearchConfig {
                    node_limit,
                    ..SearchConfig::default()
                },
                node_limit,
            },
            || false,
        );
        let Ok(decision) = decision else {
            return false;
        };
        let Some(movement) = decision.selected_move else {
            return false;
        };
        self.rng_state = decision.rng_state;
        if !self.play(&movement.to_iccs()) {
            return false;
        }
        self.records
            .last_mut()
            .expect("an applied move has a history record")
            .difficulty_level = Some(level);
        true
    }

    /// Review-branch reply (SPEC 8.7): the built-in analyzer's best move, not a
    /// difficulty-weakened one.
    pub fn branch_reply(&mut self, node_limit: u32) -> bool {
        let mut analyzer = BuiltinAnalyzer::new(SearchConfig {
            node_limit: u64::from(node_limit),
            ..SearchConfig::default()
        });
        self.play_best_reply(&mut analyzer, u64::from(node_limit))
    }

    /// Evaluate the current real game position from its side-to-move perspective.
    pub fn live_evaluation(&self, node_limit: u32) -> String {
        let result = Searcher::new(SearchConfig {
            node_limit: u64::from(node_limit),
            ..SearchConfig::default()
        })
        .search_game(&self.game);
        json!({
            "scoreCentipawns": result.score,
            "nodes": result.nodes,
            "depth": result.depth,
            "fen": self.game.position().to_fen(),
            "sideToMove": side_token(self.game.position().side_to_move()),
        })
        .to_string()
    }

    pub fn restart(&mut self) {
        self.game = Game::new(self.starting_position.clone());
        self.records.clear();
        self.rng_state = 1;
    }
}

/// Incremental review adapter: root analysis and each continuation segment are separate calls,
/// so the Worker can receive cancellation or replacement requests between backend searches.
#[wasm_bindgen]
pub fn import_record(text: &str) -> String {
    let result = parse_record(text);
    let errors = result
        .error
        .as_ref()
        .map(|error| {
            vec![json!({
                "step": error.step,
                "token": error.token,
                "decodedMove": error.decoded_move,
                "kind": match error.kind {
                    ImportErrorKind::UnknownFormat => "unknown_format",
                    ImportErrorKind::InvalidNotation => "invalid_notation",
                    ImportErrorKind::IllegalMove => "illegal_move",
                    ImportErrorKind::Ambiguous => "ambiguous",
                    ImportErrorKind::InvalidPosition => "invalid_position",
                    ImportErrorKind::MalformedRecord => "malformed_record",
                    ImportErrorKind::GameOver => "game_over",
                },
                "candidates": error.candidates,
                "messageZh": error.message_zh(),
            })]
        })
        .unwrap_or_default();
    let format = result.format.map(|format| match format {
        NotationFormat::Iccs => "iccs",
        NotationFormat::Chinese => "chinese",
        NotationFormat::Pgn => "pgn",
        NotationFormat::DhtmlXq => "dhtmlxq",
    });
    let start_fen = if result
        .error
        .as_ref()
        .is_some_and(|error| error.kind == ImportErrorKind::InvalidPosition)
    {
        None
    } else {
        Some(result.initial_position.to_fen())
    };
    json!({
        "format": format,
        "startFen": start_fen,
        "moves": result
            .moves
            .iter()
            .map(|movement| movement.to_iccs())
            .collect::<Vec<_>>(),
        "warnings": result.warnings.iter().map(|warning| match warning {
            ImportWarning::VariationsNotImported => "variations_not_imported",
        }).collect::<Vec<_>>(),
        "metadata": result.metadata,
        "isStandardStart": if start_fen.is_none() {
            Value::Null
        } else {
            Value::Bool(result.is_standard_start)
        },
        "errors": errors,
    })
    .to_string()
}

#[wasm_bindgen]
pub struct ReviewWorkerSession {
    review: IncrementalReview<BuiltinAnalyzer>,
    analysis_indices: Vec<usize>,
    /// Events carry the original ply index (true for whole-game and `with_indices` sessions);
    /// a `with_focus` session keeps reporting its single analysis slot 0 for existing callers.
    report_source_index: bool,
    history_positions: Vec<Game>,
    history_moves: Vec<Vec<String>>,
    continuation_analyzer: BuiltinAnalyzer,
    pending_continuation: Option<PendingContinuation>,
}

#[wasm_bindgen]
impl ReviewWorkerSession {
    #[wasm_bindgen(constructor)]
    pub fn new(
        start_fen: &str,
        moves: &str,
        quick_node_limit: u32,
    ) -> Result<ReviewWorkerSession, JsValue> {
        build_review_session(start_fen, moves, quick_node_limit, ReviewSelection::All)
    }

    /// Create a review that reanalyzes one zero-based ply while retaining all prior Game history.
    #[wasm_bindgen(js_name = with_focus)]
    pub fn with_focus(
        start_fen: &str,
        moves: &str,
        quick_node_limit: u32,
        focus_index: u32,
    ) -> Result<ReviewWorkerSession, JsValue> {
        build_review_session(
            start_fen,
            moves,
            quick_node_limit,
            ReviewSelection::Focus(focus_index as usize),
        )
    }

    /// Create a two-pass review of only the given zero-based plies, with the same results per ply
    /// as `new` on the whole game. The full history is still replayed so every ply is analyzed from
    /// the same position and history as in the whole-game review; events carry original ply indices.
    /// Plies must be unique and inside the game; they are analyzed in ascending order.
    #[wasm_bindgen(js_name = with_indices)]
    pub fn with_indices(
        start_fen: &str,
        moves: &str,
        quick_node_limit: u32,
        indices: &[u32],
    ) -> Result<ReviewWorkerSession, JsValue> {
        build_review_session(
            start_fen,
            moves,
            quick_node_limit,
            ReviewSelection::Indices(indices.iter().map(|index| *index as usize).collect()),
        )
    }

    /// Returns one completed analysis point, leaving continuation work for `continue_step`.
    pub fn step(&mut self) -> Result<String, JsValue> {
        match self
            .review
            .advance()
            .map_err(|_| JsValue::from_str("review analysis failed"))?
        {
            Some(ReviewStep::Point {
                pass,
                index,
                result,
            }) => {
                let source_index = self.analysis_indices[index];
                let reported_index = if self.report_source_index {
                    source_index
                } else {
                    index
                };
                let continuation_start = self.history_positions.get(source_index);
                let continuation_lines = match pass {
                    ReviewPass::Quick => &result.quick.candidates,
                    ReviewPass::Deep => &result.final_result.candidates,
                };
                let other_lines = match pass {
                    ReviewPass::Quick => &result.final_result.candidates,
                    ReviewPass::Deep => &result.quick.candidates,
                };
                let history = self
                    .history_moves
                    .get(source_index)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                self.pending_continuation = continuation_start.and_then(|game| {
                    let candidates =
                        prepare_continuations(game, history, source_index, continuation_lines);
                    (!candidates.is_empty()).then_some(PendingContinuation {
                        index: reported_index,
                        pass,
                        candidates,
                        candidate_index: 0,
                    })
                });
                let other_candidates = continuation_start
                    .map(|game| prepare_continuations(game, history, source_index, other_lines))
                    .unwrap_or_default();
                let mut point = json!({
                    "quick": ply_json(&result.quick),
                    "final": ply_json(&result.final_result),
                    "deepened": result.deepened,
                    "continuationComplete": self.pending_continuation.is_none(),
                });
                if let Some(pending) = &self.pending_continuation {
                    let result_key = match pending.pass {
                        ReviewPass::Quick => "quick",
                        ReviewPass::Deep => "final",
                    };
                    let other_key = match pending.pass {
                        ReviewPass::Quick => "final",
                        ReviewPass::Deep => "quick",
                    };
                    annotate_candidate_values(&mut point, result_key, &pending.candidates);
                    annotate_candidate_values(&mut point, other_key, &other_candidates);
                } else {
                    let key = match pass {
                        ReviewPass::Quick => "quick",
                        ReviewPass::Deep => "final",
                    };
                    let other_key = match pass {
                        ReviewPass::Quick => "final",
                        ReviewPass::Deep => "quick",
                    };
                    annotate_candidate_values(&mut point, key, &other_candidates);
                    annotate_candidate_values(&mut point, other_key, &other_candidates);
                }
                Ok(json!({
                    "done": false,
                    "pass": match pass { ReviewPass::Quick => "quick", ReviewPass::Deep => "deep" },
                    "index": reported_index,
                    "continuationPending": self.pending_continuation.is_some(),
                    "point": point
                })
                .to_string())
            }
            None => Ok(json!({ "done": true }).to_string()),
        }
    }

    /// Analyze one next position for one candidate. The caller yields to the Worker event loop
    /// after each result so cancellation cannot wait for every candidate's full continuation.
    pub fn continue_step(&mut self) -> Result<String, JsValue> {
        let Some(pending) = self.pending_continuation.as_mut() else {
            return Ok(json!({ "done": true }).to_string());
        };
        while pending.candidate_index < pending.candidates.len() {
            let candidate_index = pending.candidate_index;
            let candidate = &mut pending.candidates[candidate_index];
            if candidate.complete {
                pending.candidate_index += 1;
                continue;
            }
            let Some(next) = self
                .continuation_analyzer
                .analyze_game(
                    &candidate.game,
                    Limit::new(CONTINUATION_NODES_PER_POSITION),
                    1,
                )
                .into_iter()
                .next()
            else {
                candidate.complete = true;
                candidate.terminal = candidate.game.outcome().is_some();
                candidate.status = if candidate.terminal {
                    "terminal"
                } else {
                    "no_result"
                };
                pending.candidate_index += 1;
                continue;
            };
            if candidate.game.play(next.best_move).is_err() {
                candidate.complete = true;
                candidate.status = "invalid_continuation";
                pending.candidate_index += 1;
                continue;
            }
            candidate.continuation.push(ContinuationSegment {
                move_iccs: next.best_move.to_iccs(),
                depth: next.depth,
                nodes: next.nodes,
                pv_end: next.pv_end,
            });
            candidate.complete = candidate.game.outcome().is_some()
                || candidate.total_plies + candidate.continuation.len()
                    >= MINIMUM_REVIEW_LINE_PLIES;
            candidate.terminal = candidate.game.outcome().is_some();
            candidate.status = if candidate.terminal {
                "terminal"
            } else if candidate.total_plies + candidate.continuation.len()
                >= MINIMUM_REVIEW_LINE_PLIES
            {
                if segment_was_truncated(&candidate.continuation) {
                    "search_truncated"
                } else {
                    "complete"
                }
            } else {
                "pending"
            };
            let segment = candidate.continuation.last().expect("segment was appended");
            let event = json!({
                "done": false,
                "pass": match pending.pass { ReviewPass::Quick => "quick", ReviewPass::Deep => "deep" },
                "index": pending.index,
                "candidateIndex": candidate_index,
                "segment": {
                    "move": segment.move_iccs,
                    "depth": segment.depth,
                    "nodes": segment.nodes,
                    "pvEnd": pv_end_name(segment.pv_end),
                },
                "candidateComplete": candidate.complete,
                "continuationTerminal": candidate.terminal,
                "continuationStatus": candidate.status,
            });
            if candidate.complete {
                pending.candidate_index += 1;
            }
            return Ok(event.to_string());
        }
        self.pending_continuation = None;
        Ok(json!({ "done": true }).to_string())
    }

    /// How many review searches this session ran and how many it answered from a search it had
    /// already run for the neighbouring ply (continuation top-ups are not counted).
    pub fn search_counts(&self) -> String {
        let (searches, reused) = self.review.search_counts();
        json!({ "searches": searches, "reused": reused }).to_string()
    }

    /// Stop before another point begins; completed points remain serializable.
    pub fn cancel(&mut self) -> String {
        let report = self.review.cancel();
        json!({
            "cancelled": report.cancelled,
            "completedPoints": report.points.len(),
        })
        .to_string()
    }
}

/// Sorted plies for a partial review, or `None` when the list is empty, repeats a ply or reaches
/// past the last ply.
fn sorted_review_indices(indices: &[usize], ply_count: usize) -> Option<Vec<usize>> {
    let mut sorted = indices.to_vec();
    sorted.sort_unstable();
    let valid = !sorted.is_empty()
        && sorted.windows(2).all(|pair| pair[0] != pair[1])
        && sorted.last().is_some_and(|last| *last < ply_count);
    valid.then_some(sorted)
}

fn build_review_session(
    start_fen: &str,
    moves: &str,
    quick_node_limit: u32,
    selection: ReviewSelection,
) -> Result<ReviewWorkerSession, JsValue> {
    if quick_node_limit == 0 {
        return Err(JsValue::from_str("quick node limit must be positive"));
    }
    let position = Position::from_fen(start_fen)
        .map_err(|_| JsValue::from_str("invalid review starting position"))?;
    let mut game = Game::new(position);
    let mut all_plies = Vec::new();
    let mut history_positions = Vec::new();
    let mut history_moves = Vec::new();
    let mut played_history = Vec::new();
    for text in moves.split(|character: char| character == ',' || character.is_whitespace()) {
        if text.is_empty() {
            continue;
        }
        let movement =
            Move::from_iccs(text).map_err(|_| JsValue::from_str("invalid move history"))?;
        let before = game.clone();
        history_positions.push(before.clone());
        history_moves.push(played_history.clone());
        game.play(movement)
            .map_err(|_| JsValue::from_str("illegal move history"))?;
        all_plies.push(PlyInput::new(before, movement));
        played_history.push(text.to_owned());
    }
    let analysis_indices = match &selection {
        ReviewSelection::Focus(index) if *index < all_plies.len() => vec![*index],
        ReviewSelection::Focus(_) => {
            return Err(JsValue::from_str(
                "focused review ply is outside the game history",
            ));
        }
        ReviewSelection::Indices(indices) => sorted_review_indices(indices, all_plies.len())
            .ok_or_else(|| {
                JsValue::from_str(
                    "review plies must be unique, non-empty and inside the game history",
                )
            })?,
        ReviewSelection::All => (0..all_plies.len()).collect(),
    };
    let plies = analysis_indices
        .iter()
        .map(|index| all_plies[*index].clone())
        .collect();
    let quick_limit = u64::from(quick_node_limit);
    let deep_limit = quick_limit.saturating_mul(DEEP_NODE_MULTIPLIER);
    // Review budgets are caller-selected and may exceed the game-play cap.
    // The review adapter still clamps each search to the exact requested limit.
    let analyzer = BuiltinAnalyzer::new(SearchConfig {
        node_limit: u64::from(u32::MAX),
        ..SearchConfig::default()
    });
    let review = if matches!(selection, ReviewSelection::Focus(_)) {
        IncrementalReview::new_single_pass(analyzer, plies, Limit::new(quick_limit))
    } else {
        IncrementalReview::new(
            analyzer,
            plies,
            Limit::new(quick_limit),
            Limit::new(deep_limit),
        )
    };
    Ok(ReviewWorkerSession {
        review,
        analysis_indices,
        report_source_index: !matches!(selection, ReviewSelection::Focus(_)),
        history_positions,
        history_moves,
        continuation_analyzer: BuiltinAnalyzer::new(SearchConfig {
            node_limit: u64::from(u32::MAX),
            ..SearchConfig::default()
        }),
        pending_continuation: None,
    })
}

enum ReviewSelection {
    All,
    Focus(usize),
    Indices(Vec<usize>),
}

#[derive(Clone)]
struct ContinuationSegment {
    move_iccs: String,
    depth: u8,
    nodes: u64,
    pv_end: xq_review::PvEnd,
}

struct PendingCandidate {
    game: Game,
    total_plies: usize,
    continuation: Vec<ContinuationSegment>,
    complete: bool,
    terminal: bool,
    replay_audit: Value,
    status: &'static str,
}

struct PendingContinuation {
    index: usize,
    pass: ReviewPass,
    candidates: Vec<PendingCandidate>,
    candidate_index: usize,
}

const CONTINUATION_NODES_PER_POSITION: u64 = 20_000;
/// The deep pass searches this many times the quick node count (user decision 2026-10-23: 3, was 10).
/// Keep in step with `DEEP_NODE_MULTIPLIER` in `web/src/review-cache.ts`.
const DEEP_NODE_MULTIPLIER: u64 = 3;
const MINIMUM_REVIEW_LINE_PLIES: usize = 6;

fn prepare_continuations(
    start: &Game,
    history: &[String],
    ply_index: usize,
    lines: &[Line],
) -> Vec<PendingCandidate> {
    lines
        .iter()
        .enumerate()
        .map(|(candidate_index, line)| {
            let mut game = start.clone();
            let root_fen = game.position().to_fen();
            let root_history_len = game.history_len();
            let mut replayed_pv = Vec::new();
            let mut failed_index = None;
            let mut failure = None;
            for (pv_index, movement) in line.principal_variation.iter().enumerate() {
                if let Some(outcome) = game.outcome() {
                    failed_index = Some(pv_index);
                    failure = Some(format!("terminal_before_pv_move:{outcome:?}"));
                    break;
                }
                if let Err(error) = game.play(*movement) {
                    failed_index = Some(pv_index);
                    failure = Some(format!("illegal_move:{error:?}"));
                    break;
                }
                replayed_pv.push(movement.to_iccs());
            }
            let terminal = game.outcome().is_some();
            let replay_audit = json!({
                "plyIndex": ply_index,
                "candidateIndex": candidate_index,
                "rootFen": root_fen,
                "rootHistory": history,
                "rootHistoryLength": root_history_len,
                "rootSideToMove": side_token(start.position().side_to_move()),
                "originalPv": line.principal_variation.iter().map(|movement| movement.to_iccs()).collect::<Vec<_>>(),
                "replayedPv": replayed_pv,
                "failedIndex": failed_index,
                "failure": failure,
                "resultFen": game.position().to_fen(),
                "resultHistoryLength": game.history_len(),
                "resultSideToMove": side_token(game.position().side_to_move()),
                "resultOutcome": game.outcome().map(|outcome| format!("{outcome:?}")),
                "rootMatchesReplayStart": root_fen == start.position().to_fen(),
            });
            let complete = failed_index.is_some()
                || line.principal_variation.len() >= MINIMUM_REVIEW_LINE_PLIES
                || terminal;
            let status = if failed_index.is_some() {
                "invalid_pv"
            } else if terminal {
                "terminal"
            } else if line.principal_variation.len() >= MINIMUM_REVIEW_LINE_PLIES {
                "minimum_reached"
            } else {
                "pending"
            };
            PendingCandidate {
                game,
                total_plies: replayed_pv.len(),
                continuation: Vec::new(),
                complete,
                terminal,
                replay_audit,
                status,
            }
        })
        .collect()
}

fn annotate_candidate_values(point: &mut Value, key: &str, candidates: &[PendingCandidate]) {
    if let Some(values) = point[key]["candidates"].as_array_mut() {
        for (value, candidate) in values.iter_mut().zip(candidates) {
            value["continuationTerminal"] = json!(candidate.terminal);
            value["continuationStatus"] = json!(candidate.status);
            value["replayAudit"] = candidate.replay_audit.clone();
        }
    }
}

fn segment_was_truncated(segments: &[ContinuationSegment]) -> bool {
    segments
        .iter()
        .any(|segment| segment.pv_end == xq_review::PvEnd::DepthLimit)
}

fn ply_json(result: &PlyAnalysis) -> Value {
    json!({
        "bestMove": result.best_move.to_iccs(),
        "playedMove": result.played_move.to_iccs(),
        "playedRank": result.played_rank,
        "bestScore": score_json(result.best_score.centipawns, result.best_score.mate_in),
        "playedScore": score_json(result.played_score.centipawns, result.played_score.mate_in),
        "bestWinProbability": result.best_win_probability,
        "playedWinProbability": result.played_win_probability,
        "lossPercent": result.loss_percent,
        "classification": classification_name(result.classification),
        "reason": result.reason.as_ref().map(|reason| {
            let kind = match reason.kind {
                xq_review::ReasonKind::WalkedIntoMate => "walked_into_mate",
                xq_review::ReasonKind::MissedMate => "missed_mate",
                xq_review::ReasonKind::DroppedMaterial => "dropped_material",
                xq_review::ReasonKind::MissedMaterial => "missed_material",
                xq_review::ReasonKind::SentPiece => "sent_piece",
                xq_review::ReasonKind::CannonMount => "cannon_mount",
                xq_review::ReasonKind::AbandonedProtection => "abandoned_protection",
                xq_review::ReasonKind::CheckCapture => "check_capture",
                xq_review::ReasonKind::PositionType => "position_type",
            };
            let material = reason.material.as_ref().map(|evidence| json!({
                "mover": side_name(evidence.mover),
                "bestNet": evidence.best_net,
                "playedNet": evidence.played_net,
                "plies": evidence.plies,
                "settled": evidence.settled,
                "bestCaptures": evidence.best_captures.iter().map(material_capture_json).collect::<Vec<_>>(),
                "playedCaptures": evidence.played_captures.iter().map(material_capture_json).collect::<Vec<_>>(),
            }));
            let piece_json = |piece: xq_core::Piece| {
                json!({"side": side_name(piece.side), "kind": piece_kind_name(piece.kind)})
            };
            let protection = reason.protection.as_ref().map(|evidence| json!({
                "piece": piece_json(evidence.piece),
                "from": evidence.from.to_iccs(),
                "to": evidence.to.to_iccs(),
                "capturedAt": evidence.captured_at.to_iccs(),
                "capturer": side_name(evidence.capturer),
                "attacker": piece_json(evidence.attacker),
                "net": evidence.net,
                "protectedPiece": evidence.protected_piece.map(piece_json),
                "protectedSquare": evidence.protected_square.map(|square| square.to_iccs()),
            }));
            let check_capture = reason.check_capture.as_ref().map(|evidence| json!({
                "victim": piece_json(evidence.victim),
                "victimSquare": evidence.victim_square.to_iccs(),
                "attacker": piece_json(evidence.attacker),
                "attackerFrom": evidence.attacker_from.to_iccs(),
                "net": evidence.net,
            }));
            let cannon_mount = reason.cannon_mount.as_ref().map(|evidence| json!({
                "screen": piece_json(evidence.screen),
                "screenSquare": evidence.screen_square.to_iccs(),
                "cannon": piece_json(evidence.cannon),
                "cannonFrom": evidence.cannon_from.to_iccs(),
                "victim": piece_json(evidence.victim),
                "victimSquare": evidence.victim_square.to_iccs(),
                "net": evidence.net,
            }));
            let position = reason.position.as_ref().map(|evidence| json!({
                "component": match evidence.component {
                    xq_review::EvalComponent::Material => "material",
                    xq_review::EvalComponent::Position => "position",
                    xq_review::EvalComponent::Mobility => "mobility",
                    xq_review::EvalComponent::KingSafety => "king_safety",
                },
                "playedValue": evidence.played_value,
                "bestValue": evidence.best_value,
                "mobilityBefore": evidence.mobility_before,
                "mobilityAfter": evidence.mobility_after,
                "mobilityAfterBest": evidence.mobility_after_best,
            }));
            json!({
                "kind": kind,
                "moves": reason.moves,
                "material": material,
                "protection": protection,
                "checkCapture": check_capture,
                "cannonMount": cannon_mount,
                "position": position,
            })
        }),
        "comparison": result.comparison.as_ref().map(comparison_json),
        "candidates": result.candidates.iter().map(|line| json!({
            "move": line.best_move.to_iccs(),
            "score": score_json(line.score.centipawns, line.score.mate_in),
            "pv": line
                .principal_variation
                .iter()
                .map(|movement| movement.to_iccs())
                .collect::<Vec<_>>(),
            "depth": line.depth,
            "nodes": line.nodes,
            "pvEnd": pv_end_name(line.pv_end),
            "continuation": [],
            "continuationNodeLimit": CONTINUATION_NODES_PER_POSITION,
            "continuationTerminal": false,
            "replayAudit": {},
            "continuationStatus": "pending",
        })).collect::<Vec<_>>(),
    })
}

fn comparison_json(comparison: &xq_review::MoveComparison) -> Value {
    let steps = |steps: &[xq_review::LineStep]| {
        steps
            .iter()
            .map(|step| {
                json!({
                    "iccs": step.mv.to_iccs(),
                    "notation": step.notation,
                    "side": side_name(step.side),
                    "captured": step.captured.map(|piece| json!({
                        "side": side_name(piece.side),
                        "kind": piece_kind_name(piece.kind),
                    })),
                })
            })
            .collect::<Vec<_>>()
    };
    json!({
        "playedLine": steps(&comparison.played_line),
        "bestLine": steps(&comparison.best_line),
        "playedComplete": comparison.played_complete,
        "bestComplete": comparison.best_complete,
        "playedSettled": comparison.played_settled,
        "bestSettled": comparison.best_settled,
    })
}

fn side_name(side: xq_core::Side) -> &'static str {
    match side {
        xq_core::Side::Red => "red",
        xq_core::Side::Black => "black",
    }
}

fn piece_kind_name(kind: xq_core::PieceKind) -> &'static str {
    match kind {
        xq_core::PieceKind::King => "king",
        xq_core::PieceKind::Advisor => "advisor",
        xq_core::PieceKind::Elephant => "elephant",
        xq_core::PieceKind::Horse => "horse",
        xq_core::PieceKind::Rook => "rook",
        xq_core::PieceKind::Cannon => "cannon",
        xq_core::PieceKind::Pawn => "pawn",
    }
}

fn material_capture_json(capture: &xq_review::MaterialCapture) -> Value {
    json!({
        "piece": {"side": side_name(capture.piece.side), "kind": piece_kind_name(capture.piece.kind)},
        "square": capture.square.to_iccs(),
        "capturer": side_name(capture.capturer),
        "ply": capture.ply,
    })
}

fn classification_name(classification: xq_review::Classification) -> &'static str {
    match classification {
        xq_review::Classification::Unclassified => "unclassified",
        xq_review::Classification::Good => "good",
        xq_review::Classification::UniqueMove => "unique_move",
        xq_review::Classification::Inaccuracy => "inaccuracy",
        xq_review::Classification::DoubtfulMove => "doubtful_move",
        xq_review::Classification::Mistake => "mistake",
        xq_review::Classification::Blunder => "blunder",
        xq_review::Classification::MissedMate => "missed_mate",
    }
}

fn pv_end_name(end: xq_review::PvEnd) -> &'static str {
    xq_review::pv_end_id(end)
}

fn score_json(centipawns: i32, mate_in: Option<i16>) -> Value {
    json!({ "centipawns": centipawns, "mateIn": mate_in })
}

fn side_token(side: Side) -> &'static str {
    match side {
        Side::Red => "red",
        Side::Black => "black",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_review_indices_must_be_unique_non_empty_and_inside_the_game() {
        assert_eq!(sorted_review_indices(&[2, 0], 3), Some(vec![0, 2]));
        assert_eq!(sorted_review_indices(&[], 3), None);
        assert_eq!(sorted_review_indices(&[1, 1], 3), None);
        assert_eq!(sorted_review_indices(&[0, 3], 3), None);
    }

    #[test]
    fn record_import_exposes_custom_start_and_step_error_without_a_standard_fallback() {
        let imported = serde_json::from_str::<Value>(&import_record(
            "[FEN \"2R6/9/5k3/9/r8/2C6/9/6R2/9/2C1K4 w - - 0 1\"]\n1. c0d0 *",
        ))
        .unwrap();

        assert_eq!(imported["format"], "pgn");
        assert_eq!(imported["isStandardStart"], false);
        assert_eq!(
            imported["startFen"],
            "2R6/9/5k3/9/r8/2C6/9/6R2/9/2C1K4 w - - 0 1"
        );
        assert_eq!(imported["moves"], serde_json::json!(["c0d0"]));
        assert_eq!(imported["errors"], serde_json::json!([]));

        let invalid_fen =
            serde_json::from_str::<Value>(&import_record("[FEN \"not-a-fen\"]\n1. c0d0 *"))
                .unwrap();
        assert_eq!(invalid_fen["startFen"], Value::Null);
        assert_eq!(invalid_fen["isStandardStart"], Value::Null);
        assert_eq!(invalid_fen["errors"][0]["kind"], "invalid_position");

        let bad_step = serde_json::from_str::<Value>(&import_record(
            "[FEN \"2R6/9/5k3/9/r8/2C6/9/6R2/9/2C1K4 w - - 0 1\"]\n1. c0d0 zzzz",
        ))
        .unwrap();
        assert_eq!(bad_step["moves"], serde_json::json!(["c0d0"]));
        assert_eq!(bad_step["errors"][0]["step"], 2);
        assert_eq!(bad_step["errors"][0]["token"], "zzzz");
    }

    #[test]
    fn web_game_record_load_is_atomic_and_keeps_its_custom_root() {
        let mut game = WebGame::from_fen("2R6/9/5k3/9/r8/2C6/9/6R2/9/2C1K4 w - - 0 1").unwrap();
        assert!(game.load_record("2R6/9/5k3/9/r8/2C6/9/6R2/9/2C1K4 w - - 0 1", "c0d0",));
        let accepted_fen = game.fen();
        assert!(accepted_fen.ends_with(" b - - 1 1"));
        assert_eq!(game.history(), "1|red|後炮平六|c0d0");

        assert!(!game.load_record("not-a-fen", "c0d0"));
        assert_eq!(game.fen(), accepted_fen);
        assert_eq!(game.history(), "1|red|後炮平六|c0d0");

        assert!(!game.load_record("2R6/9/5k3/9/r8/2C6/9/6R2/9/2C1K4 w - - 0 1", "c0d0 zzzz",));
        assert_eq!(game.fen(), accepted_fen);
        assert_eq!(game.history(), "1|red|後炮平六|c0d0");
    }

    #[test]
    fn browser_game_exposes_core_legal_moves_notation_and_undo() {
        let mut game = WebGame::new();
        let start_fen = game.fen();

        assert_eq!(game.side_to_move(), "red");
        assert_eq!(game.board().chars().count(), 90);
        assert_eq!(game.legal_moves().split(',').count(), 44);
        assert!(game.legal_moves().split(',').any(|token| token == "h2e2"));

        assert!(game.play("h2e2"));
        assert_eq!(game.side_to_move(), "black");
        assert_eq!(game.history(), "1|red|炮二平五|h2e2");
        assert_eq!(game.last_move(), "h2e2");

        assert!(game.undo_last_move());
        assert_eq!(game.fen(), start_fen);
        assert_eq!(game.side_to_move(), "red");
        assert!(game.history().is_empty());
        assert!(!game.undo_last_move());
    }

    #[test]
    fn level_ten_browser_entry_matches_the_default_single_pv_move() {
        let mut game = WebGame::new();
        assert!(game.play("h2e2"));
        let expected = xq_engine::Searcher::new(SearchConfig {
            node_limit: 256,
            ..SearchConfig::default()
        })
        .search_game(&game.game)
        .best_move
        .expect("the position has a legal engine reply")
        .to_iccs();

        assert!(game.ai_move(256, 10));
        assert_eq!(game.last_move(), expected);
        assert_eq!(game.last_ai_level(), 10);
    }

    #[test]
    fn illegal_browser_move_does_not_change_game_state() {
        let mut game = WebGame::new();
        let start_fen = game.fen();

        assert!(!game.play("h2h8"));
        assert_eq!(game.fen(), start_fen);
        assert_eq!(game.side_to_move(), "red");
        assert!(game.history().is_empty());
    }

    #[test]
    fn live_evaluation_reports_the_current_position_from_side_to_move() {
        let mut game = WebGame::new();
        assert!(game.play("h2e2"));
        let evaluation: Value = serde_json::from_str(&game.live_evaluation(4_000)).unwrap();

        assert_eq!(evaluation["fen"], game.fen());
        assert_eq!(evaluation["sideToMove"], "black");
        assert!(evaluation["scoreCentipawns"].is_i64());
        assert!(
            evaluation["nodes"]
                .as_u64()
                .is_some_and(|nodes| nodes <= 4_000)
        );
    }

    #[test]
    fn live_evaluation_reports_the_searched_depth() {
        let game = WebGame::new();
        let evaluation: Value = serde_json::from_str(&game.live_evaluation(4_000)).unwrap();

        assert!(evaluation["depth"].as_u64().is_some_and(|depth| depth >= 1));
    }

    #[test]
    fn review_dto_preserves_typed_reason_and_serializes_absence_as_null() {
        let movement = Move::from_iccs("h2e2").unwrap();
        let result = PlyAnalysis {
            best_move: movement,
            played_move: movement,
            candidates: Vec::new(),
            played_rank: Some(1),
            best_score: xq_review::ReviewScore::mate_in(3),
            played_score: xq_review::ReviewScore::mate_in(3),
            played_line: None,
            best_win_probability: 1.0,
            played_win_probability: 1.0,
            loss_percent: 0.0,
            classification: xq_review::Classification::Good,
            reason: Some(xq_review::Reason::bare(
                xq_review::ReasonKind::MissedMate,
                3,
            )),
            comparison: None,
        };
        let json: Value = serde_json::from_str(&ply_json(&result).to_string()).unwrap();
        assert_eq!(json["reason"]["kind"], "missed_mate");
        assert_eq!(json["reason"]["moves"], 3);

        let mut without_reason = result;
        without_reason.reason = None;
        let json: Value = serde_json::from_str(&ply_json(&without_reason).to_string()).unwrap();
        assert!(json["reason"].is_null());
    }

    #[test]
    fn branch_reply_from_a_mid_game_node_is_that_positions_best_move() {
        // TEST_PLAN 6.5.3. The product reply path (choose_move) has no injectable
        // analyzer seam, so the oracle is an independent search on the same position.
        let mut game = WebGame::new();
        // Branch off after ply 1 (a different black reply than the recorded one).
        assert!(game.load_record(&game.start_fen(), "h2e2"));
        assert!(game.play("b9c7"));
        let expected = xq_engine::Searcher::new(SearchConfig {
            node_limit: 256,
            ..SearchConfig::default()
        })
        .search_game(&game.game)
        .best_move
        .expect("the branch position has a legal engine reply")
        .to_iccs();

        assert!(game.branch_reply(256));
        assert_eq!(game.last_move(), expected);
        assert_eq!(game.history().lines().count(), 3);
    }

    #[test]
    fn illegal_move_in_a_branch_is_rejected_and_leaves_the_line_unchanged() {
        // TEST_PLAN 6.5.5 (engine side): the worker turns `false` into invalidMove,
        // and the page only appends tree nodes after an ok response.
        let mut game = WebGame::new();
        assert!(game.load_record(&game.start_fen(), "h2e2"));
        assert!(game.play("b9c7"));
        let (fen, history) = (game.fen(), game.history());

        assert!(!game.play("a0a5"), "a rook cannot jump over its own pawn");
        assert!(!game.play("zzzz"));
        assert_eq!(game.fen(), fen);
        assert_eq!(game.history(), history);
        assert!(
            game.play("b0c2"),
            "the branch stays playable after a rejection"
        );
    }

    struct ScriptedAnalyzer {
        reply: &'static str,
        asked: Vec<(String, u64, usize)>,
    }

    impl Analyzer for ScriptedAnalyzer {
        fn analyze(&mut self, position: &Position, limit: Limit, multipv: usize) -> Vec<Line> {
            self.asked.push((position.to_fen(), limit.nodes, multipv));
            let best_move = Move::from_iccs(self.reply).unwrap();
            vec![Line {
                best_move,
                score: xq_review::ReviewScore::centipawns(0),
                principal_variation: vec![best_move],
                depth: 1,
                nodes: 1,
                pv_end: xq_engine::PrincipalVariationEnd::DepthLimit,
            }]
        }

        fn name(&self) -> String {
            "scripted".to_owned()
        }
    }

    #[test]
    fn branch_reply_plays_the_analyzers_best_move_for_that_position() {
        // TEST_PLAN 6.5.3 with a fake analyzer: the reply is whatever the analyzer
        // ranks first, regardless of the player's difficulty setting.
        let mut game = WebGame::new();
        assert!(game.play("h2e2"));
        let branch_fen = game.fen();
        let mut analyzer = ScriptedAnalyzer {
            reply: "a6a5",
            asked: Vec::new(),
        };

        assert!(game.play_best_reply(&mut analyzer, 777));
        assert_eq!(game.last_move(), "a6a5");
        assert_eq!(analyzer.asked, vec![(branch_fen, 777, 1)]);
        assert_eq!(game.side_to_move(), "red");
    }

    #[test]
    fn branch_reply_rejects_an_illegal_analyzer_move_without_changing_the_game() {
        let mut game = WebGame::new();
        assert!(game.play("h2e2"));
        let (fen, history) = (game.fen(), game.history());
        let mut analyzer = ScriptedAnalyzer {
            reply: "a0a9",
            asked: Vec::new(),
        };
        assert!(!game.play_best_reply(&mut analyzer, 100));
        assert_eq!(game.fen(), fen);
        assert_eq!(game.history(), history);
    }

    #[test]
    fn exchange_check_and_position_reasons_reach_the_page_with_their_evidence() {
        use xq_core::{Piece, PieceKind, Side, Square};
        let sq = |text: &str| Square::from_iccs(text).unwrap();
        let horse = Piece {
            side: Side::Red,
            kind: PieceKind::Horse,
        };
        let cannon = Piece {
            side: Side::Red,
            kind: PieceKind::Cannon,
        };
        let rook = Piece {
            side: Side::Black,
            kind: PieceKind::Rook,
        };
        let dto = |reason: xq_review::Reason| -> Value {
            let result = PlyAnalysis {
                best_move: Move::from_iccs("d0d1").unwrap(),
                played_move: Move::from_iccs("b2c4").unwrap(),
                candidates: Vec::new(),
                played_rank: None,
                best_score: xq_review::ReviewScore::centipawns(400),
                played_score: xq_review::ReviewScore::centipawns(0),
                played_line: None,
                best_win_probability: 0.8,
                played_win_probability: 0.5,
                loss_percent: 30.0,
                classification: xq_review::Classification::Blunder,
                reason: Some(reason),
                comparison: None,
            };
            serde_json::from_str(&ply_json(&result).to_string()).unwrap()
        };

        let sent = dto(xq_review::Reason {
            protection: Some(xq_review::ProtectionEvidence {
                piece: horse,
                from: sq("b2"),
                to: sq("c4"),
                captured_at: sq("c4"),
                capturer: Side::Black,
                attacker: Piece {
                    side: Side::Black,
                    kind: PieceKind::Pawn,
                },
                net: -300,
                protected_piece: None,
                protected_square: None,
            }),
            ..xq_review::Reason::bare(xq_review::ReasonKind::SentPiece, 0)
        });
        assert_eq!(sent["reason"]["kind"], "sent_piece");
        assert_eq!(sent["reason"]["protection"]["piece"]["kind"], "horse");
        assert_eq!(sent["reason"]["protection"]["from"], "b2");
        assert_eq!(sent["reason"]["protection"]["capturedAt"], "c4");
        assert_eq!(sent["reason"]["protection"]["capturer"], "black");
        assert_eq!(sent["reason"]["protection"]["attacker"]["kind"], "pawn");
        assert_eq!(sent["reason"]["protection"]["net"], -300);
        assert!(sent["reason"]["protection"]["protectedPiece"].is_null());

        let abandoned = dto(xq_review::Reason {
            protection: Some(xq_review::ProtectionEvidence {
                piece: Piece {
                    side: Side::Red,
                    kind: PieceKind::Rook,
                },
                from: sq("a5"),
                to: sq("a4"),
                captured_at: sq("b5"),
                capturer: Side::Black,
                attacker: rook,
                net: -300,
                protected_piece: Some(cannon),
                protected_square: Some(sq("b5")),
            }),
            ..xq_review::Reason::bare(xq_review::ReasonKind::AbandonedProtection, 0)
        });
        assert_eq!(abandoned["reason"]["kind"], "abandoned_protection");
        assert_eq!(
            abandoned["reason"]["protection"]["protectedPiece"]["kind"],
            "cannon"
        );
        assert_eq!(abandoned["reason"]["protection"]["protectedSquare"], "b5");

        let check = dto(xq_review::Reason {
            check_capture: Some(xq_review::CheckCaptureEvidence {
                victim: horse,
                victim_square: sq("e3"),
                attacker: rook,
                attacker_from: sq("a3"),
                net: -300,
            }),
            ..xq_review::Reason::bare(xq_review::ReasonKind::CheckCapture, 0)
        });
        assert_eq!(check["reason"]["kind"], "check_capture");
        assert_eq!(check["reason"]["checkCapture"]["victim"]["kind"], "horse");
        assert_eq!(check["reason"]["checkCapture"]["victimSquare"], "e3");
        assert_eq!(check["reason"]["checkCapture"]["attacker"]["kind"], "rook");
        assert_eq!(check["reason"]["checkCapture"]["attackerFrom"], "a3");
        assert_eq!(check["reason"]["checkCapture"]["net"], -300);

        let position = dto(xq_review::Reason {
            position: Some(xq_review::PositionEvidence {
                component: xq_review::EvalComponent::Mobility,
                played_value: 36,
                best_value: 40,
                mobility_before: 11,
                mobility_after: 4,
                mobility_after_best: 9,
            }),
            ..xq_review::Reason::bare(xq_review::ReasonKind::PositionType, 0)
        });
        assert_eq!(position["reason"]["kind"], "position_type");
        assert_eq!(position["reason"]["position"]["component"], "mobility");
        assert_eq!(position["reason"]["position"]["playedValue"], 36);
        assert_eq!(position["reason"]["position"]["bestValue"], 40);
        assert_eq!(position["reason"]["position"]["mobilityBefore"], 11);
        assert_eq!(position["reason"]["position"]["mobilityAfter"], 4);
        assert_eq!(position["reason"]["position"]["mobilityAfterBest"], 9);

        let piece = |side, kind| xq_core::Piece { side, kind };
        let mount = dto(xq_review::Reason {
            cannon_mount: Some(xq_review::CannonMountEvidence {
                screen: piece(xq_core::Side::Red, xq_core::PieceKind::Horse),
                screen_square: xq_core::Square::from_iccs("a2").unwrap(),
                cannon: piece(xq_core::Side::Black, xq_core::PieceKind::Cannon),
                cannon_from: xq_core::Square::from_iccs("a5").unwrap(),
                victim: piece(xq_core::Side::Red, xq_core::PieceKind::Rook),
                victim_square: xq_core::Square::from_iccs("a0").unwrap(),
                net: -600,
            }),
            ..xq_review::Reason::bare(xq_review::ReasonKind::CannonMount, 0)
        });
        assert_eq!(mount["reason"]["kind"], "cannon_mount");
        assert_eq!(mount["reason"]["cannonMount"]["screen"]["kind"], "horse");
        assert_eq!(mount["reason"]["cannonMount"]["screenSquare"], "a2");
        assert_eq!(mount["reason"]["cannonMount"]["cannon"]["side"], "black");
        assert_eq!(mount["reason"]["cannonMount"]["cannonFrom"], "a5");
        assert_eq!(mount["reason"]["cannonMount"]["victim"]["kind"], "rook");
        assert_eq!(mount["reason"]["cannonMount"]["victimSquare"], "a0");
        assert_eq!(mount["reason"]["cannonMount"]["net"], -600);
    }

    #[test]
    fn material_reason_dto_preserves_net_and_specific_capture_evidence() {
        let movement = Move::from_iccs("d1d2").unwrap();
        let result = PlyAnalysis {
            best_move: Move::from_iccs("a0a5").unwrap(),
            played_move: movement,
            candidates: Vec::new(),
            played_rank: None,
            best_score: xq_review::ReviewScore::centipawns(400),
            played_score: xq_review::ReviewScore::centipawns(0),
            played_line: None,
            best_win_probability: 0.8,
            played_win_probability: 0.5,
            loss_percent: 30.0,
            classification: xq_review::Classification::Blunder,
            reason: Some(xq_review::Reason {
                material: Some(xq_review::MaterialEvidence {
                    mover: xq_core::Side::Red,
                    best_net: 600,
                    played_net: -600,
                    plies: 2,
                    settled: true,
                    best_captures: Vec::new(),
                    played_captures: vec![xq_review::MaterialCapture {
                        piece: xq_core::Piece {
                            side: xq_core::Side::Red,
                            kind: xq_core::PieceKind::Rook,
                        },
                        square: xq_core::Square::from_iccs("a0").unwrap(),
                        capturer: xq_core::Side::Black,
                        ply: 2,
                    }],
                }),
                ..xq_review::Reason::bare(xq_review::ReasonKind::DroppedMaterial, 0)
            }),
            comparison: None,
        };
        let json: Value = serde_json::from_str(&ply_json(&result).to_string()).unwrap();
        assert_eq!(json["reason"]["kind"], "dropped_material");
        assert_eq!(json["reason"]["material"]["mover"], "red");
        assert_eq!(json["reason"]["material"]["bestNet"], 600);
        assert_eq!(json["reason"]["material"]["playedNet"], -600);
        assert_eq!(
            json["reason"]["material"]["playedCaptures"][0]["piece"]["kind"],
            "rook"
        );
        assert_eq!(
            json["reason"]["material"]["playedCaptures"][0]["square"],
            "a0"
        );
    }

    #[test]
    fn ai_reply_is_legal_and_one_undo_restores_the_whole_turn() {
        let mut game = WebGame::new();
        let start_fen = game.fen();
        assert!(game.play("h2e2"));
        assert!(game.ai_move(256, 10));
        assert_eq!(game.side_to_move(), "red");
        assert_eq!(game.history().lines().count(), 2);
        assert!(game.undo_turn());
        assert_eq!(game.fen(), start_fen);
        assert!(game.history().is_empty());
    }
    #[test]
    fn review_dto_serializes_the_move_comparison() {
        let movement = Move::from_iccs("h2e2").unwrap();
        let step = |iccs: &str, notation: &str, side, captured| xq_review::LineStep {
            mv: Move::from_iccs(iccs).unwrap(),
            side,
            notation: notation.to_string(),
            captured,
        };
        let mut result = PlyAnalysis {
            best_move: movement,
            played_move: movement,
            candidates: Vec::new(),
            played_rank: Some(1),
            best_score: xq_review::ReviewScore::centipawns(0),
            played_score: xq_review::ReviewScore::centipawns(0),
            played_line: None,
            best_win_probability: 0.8,
            played_win_probability: 0.5,
            loss_percent: 30.0,
            classification: xq_review::Classification::Blunder,
            reason: None,
            comparison: Some(xq_review::MoveComparison {
                played_line: vec![step(
                    "e9e8",
                    "將5進1",
                    xq_core::Side::Black,
                    Some(xq_core::Piece {
                        side: xq_core::Side::Red,
                        kind: xq_core::PieceKind::Rook,
                    }),
                )],
                best_line: vec![step("h2e2", "炮二平五", xq_core::Side::Red, None)],
                played_complete: true,
                best_complete: false,
                played_settled: false,
                best_settled: true,
            }),
        };
        let json: Value = serde_json::from_str(&ply_json(&result).to_string()).unwrap();
        let comparison = &json["comparison"];
        assert_eq!(comparison["playedLine"][0]["iccs"], "e9e8");
        assert_eq!(comparison["playedLine"][0]["notation"], "將5進1");
        assert_eq!(comparison["playedLine"][0]["side"], "black");
        assert_eq!(comparison["playedLine"][0]["captured"]["kind"], "rook");
        assert_eq!(comparison["playedLine"][0]["captured"]["side"], "red");
        assert_eq!(comparison["bestLine"][0]["iccs"], "h2e2");
        assert!(comparison["bestLine"][0]["captured"].is_null());
        assert_eq!(comparison["playedComplete"], true);
        assert_eq!(comparison["bestComplete"], false);
        assert_eq!(comparison["playedSettled"], false);
        assert_eq!(comparison["bestSettled"], true);

        result.comparison = None;
        let json: Value = serde_json::from_str(&ply_json(&result).to_string()).unwrap();
        assert!(json["comparison"].is_null());
    }
}

#[cfg(test)]
#[path = "review_terminal_tests.rs"]
mod review_terminal_tests;
