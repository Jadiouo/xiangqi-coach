//! Deterministic move selection profiles for player-facing difficulty.
//!
//! SearchLine scores remain unmodified; bounded noise is used only while choosing
//! among the clean, fully searched root candidates.

use xq_core::{Game, GameOutcome, Move};

use crate::{SearchConfig, SearchLine, SearchResult, Searcher};

const MAX_CANDIDATES: usize = 5;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Profile {
    node_limit: u64,
    noise_cp: u32,
    rank_weights: [u32; MAX_CANDIDATES],
}

// Candidate values, not measured or calibrated level strengths.
const PROFILES: [Profile; 10] = [
    Profile {
        node_limit: 64,
        noise_cp: 1_200,
        rank_weights: [1, 1, 1, 1, 1],
    },
    Profile {
        node_limit: 128,
        noise_cp: 900,
        rank_weights: [2, 1, 1, 1, 1],
    },
    Profile {
        node_limit: 256,
        noise_cp: 700,
        rank_weights: [3, 1, 1, 1, 1],
    },
    Profile {
        node_limit: 512,
        noise_cp: 500,
        rank_weights: [4, 1, 1, 1, 1],
    },
    Profile {
        node_limit: 1_024,
        noise_cp: 350,
        rank_weights: [5, 1, 1, 1, 1],
    },
    Profile {
        node_limit: 2_048,
        noise_cp: 250,
        rank_weights: [7, 1, 1, 1, 1],
    },
    Profile {
        node_limit: 4_096,
        noise_cp: 150,
        rank_weights: [10, 1, 1, 1, 1],
    },
    Profile {
        node_limit: 8_192,
        noise_cp: 75,
        rank_weights: [16, 1, 1, 1, 1],
    },
    Profile {
        node_limit: 16_384,
        noise_cp: 25,
        rank_weights: [32, 1, 1, 0, 0],
    },
    Profile {
        node_limit: u64::MAX,
        noise_cp: 0,
        rank_weights: [1, 0, 0, 0, 0],
    },
];

#[derive(Clone, Debug)]
pub struct DifficultyRequest {
    pub level: u8,
    pub rng_state: u64,
    /// Caller settings are preserved except that `node_limit` is clamped.
    pub search_config: SearchConfig,
    /// Additional caller-owned node cap, combined with the profile and config caps.
    pub node_limit: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletedAnalysis {
    pub score: i32,
    pub mate_in: Option<u8>,
    pub depth: u8,
    pub nodes: u64,
    /// Original, unmodified search lines from the completed iteration.
    pub lines: Vec<SearchLine>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DifficultyDecision {
    pub selected_move: Option<Move>,
    pub terminal: Option<GameOutcome>,
    /// Present only when a complete searched depth is available.
    pub analysis: Option<CompletedAnalysis>,
    /// Exact baseline single-PV result at level 10, including unsearched fallback metadata.
    pub search_result: Option<SearchResult>,
    /// True only when a non-terminal position needed a legal fallback.
    pub used_fallback: bool,
    /// Caller-owned deterministic PRNG state after selection.
    pub rng_state: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DifficultyError {
    InvalidLevel(u8),
}

/// Search and choose a move without ambient I/O, time, or entropy.
///
/// The effective node cap is the minimum of the level profile, the explicit
/// caller cap, and `request.search_config.node_limit`. Depth and stop policy
/// remain controlled by the supplied config and callback.
pub fn choose_move(
    game: &Game,
    request: DifficultyRequest,
    should_stop: impl FnMut() -> bool,
) -> Result<DifficultyDecision, DifficultyError> {
    choose_move_with_progress(game, request, should_stop, |_, _, _| {})
}

/// Choose a move and report each fully completed, sorted, noise-free iteration.
/// The observer cannot alter search control and is never called for a partial depth.
pub fn choose_move_with_progress(
    game: &Game,
    request: DifficultyRequest,
    mut should_stop: impl FnMut() -> bool,
    mut on_completed_iteration: impl FnMut(u8, u64, &[SearchLine]),
) -> Result<DifficultyDecision, DifficultyError> {
    let profile = *PROFILES
        .get(usize::from(request.level.saturating_sub(1)))
        .filter(|_| (1..=10).contains(&request.level))
        .ok_or(DifficultyError::InvalidLevel(request.level))?;

    if let Some(outcome) = game.outcome() {
        return Ok(DifficultyDecision {
            selected_move: None,
            terminal: Some(outcome),
            analysis: None,
            search_result: None,
            used_fallback: false,
            rng_state: request.rng_state,
        });
    }

    let mut position = game.position().clone();
    let mut legal_moves = position.legal_moves();
    legal_moves.sort_by_key(|movement| movement.to_iccs());
    if legal_moves.is_empty() {
        // Game::outcome is authoritative; this branch is defensive for future rule changes.
        return Ok(DifficultyDecision {
            selected_move: None,
            terminal: None,
            analysis: None,
            search_result: None,
            used_fallback: false,
            rng_state: request.rng_state,
        });
    }

    let effective_node_limit = profile
        .node_limit
        .min(request.node_limit)
        .min(request.search_config.node_limit);
    let mut config = request.search_config;
    config.node_limit = effective_node_limit;
    let searcher = Searcher::new(config);

    if request.level == 10 {
        let result = searcher.search_game_until(game, &mut should_stop);
        let forced_single = legal_moves.len() == 1;
        let analysis = (result.depth > 0).then(|| CompletedAnalysis {
            score: result.score,
            mate_in: result.mate_in,
            depth: result.depth,
            nodes: result.nodes,
            lines: vec![SearchLine {
                best_move: result
                    .best_move
                    .expect("a non-terminal search has a legal fallback"),
                score: result.score,
                depth: result.depth,
                mate_in: result.mate_in,
            }],
        });
        return Ok(DifficultyDecision {
            selected_move: result.best_move,
            terminal: None,
            analysis,
            search_result: Some(result),
            used_fallback: result.depth == 0 && !forced_single,
            rng_state: request.rng_state,
        });
    }

    let candidate_count = profile
        .rank_weights
        .iter()
        .filter(|weight| **weight > 0)
        .count();
    let mut completed = None;
    searcher.search_multipv_with_progress(
        game,
        candidate_count,
        &mut should_stop,
        |depth, nodes, lines| {
            completed = Some((depth, nodes, lines.to_vec()));
            on_completed_iteration(depth, nodes, lines);
        },
    );

    if let Some((depth, nodes, clean_lines)) = completed {
        let mut state = request.rng_state;
        let mut ranked_lines = clean_lines.clone();
        for line in &mut ranked_lines {
            let noise = uniform_i32(&mut state, profile.noise_cp);
            line.score = line.score.saturating_add(noise);
        }
        ranked_lines.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| left.best_move.to_iccs().cmp(&right.best_move.to_iccs()))
        });
        let available = ranked_lines.len().min(profile.rank_weights.len());
        let total_weight = profile.rank_weights[..available].iter().sum::<u32>();
        let draw = bounded_index(&mut state, u64::from(total_weight)) as u32;
        let mut cumulative = 0;
        let selected_rank = profile.rank_weights[..available]
            .iter()
            .position(|weight| {
                cumulative += *weight;
                draw < cumulative
            })
            .expect("profile assigns positive weight to an available candidate");
        let selected_move = ranked_lines[selected_rank].best_move;
        let clean_best = clean_lines
            .first()
            .expect("a completed iteration has a root line");
        return Ok(DifficultyDecision {
            selected_move: Some(selected_move),
            terminal: None,
            analysis: Some(CompletedAnalysis {
                score: clean_best.score,
                mate_in: clean_best.mate_in,
                depth,
                nodes,
                lines: clean_lines,
            }),
            search_result: None,
            used_fallback: false,
            rng_state: state,
        });
    }

    let selected_move = if legal_moves.len() == 1 {
        legal_moves[0]
    } else {
        let mut state = request.rng_state;
        let index = bounded_index(&mut state, legal_moves.len() as u64) as usize;
        return Ok(DifficultyDecision {
            selected_move: Some(legal_moves[index]),
            terminal: None,
            analysis: None,
            search_result: None,
            used_fallback: true,
            rng_state: state,
        });
    };
    Ok(DifficultyDecision {
        selected_move: Some(selected_move),
        terminal: None,
        analysis: None,
        search_result: None,
        used_fallback: false,
        rng_state: request.rng_state,
    })
}

fn uniform_i32(state: &mut u64, radius: u32) -> i32 {
    if radius == 0 {
        return 0;
    }
    let width = u64::from(radius) * 2 + 1;
    bounded_index(state, width) as i32 - radius as i32
}

fn bounded_index(state: &mut u64, bound: u64) -> u64 {
    debug_assert!(bound > 0);
    let threshold = bound.wrapping_neg() % bound;
    loop {
        let value = next_u64(state);
        if value >= threshold {
            return value % bound;
        }
    }
}

fn next_u64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut value = *state;
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

#[cfg(test)]
mod tests {
    use super::{MAX_CANDIDATES, PROFILES};

    #[test]
    fn candidate_profiles_preserve_monotone_difficulty_controls_and_exact_top_endpoint() {
        for pair in PROFILES.windows(2) {
            let (weaker, stronger) = (pair[0], pair[1]);
            assert!(weaker.node_limit <= stronger.node_limit);
            assert!(weaker.noise_cp >= stronger.noise_cp);
            assert!(
                weaker
                    .rank_weights
                    .iter()
                    .filter(|weight| **weight > 0)
                    .count()
                    >= stronger
                        .rank_weights
                        .iter()
                        .filter(|weight| **weight > 0)
                        .count()
            );
            let weaker_total: u64 = weaker
                .rank_weights
                .iter()
                .map(|weight| u64::from(*weight))
                .sum();
            let stronger_total: u64 = stronger
                .rank_weights
                .iter()
                .map(|weight| u64::from(*weight))
                .sum();
            assert!(
                u64::from(weaker.rank_weights[0]) * stronger_total
                    <= u64::from(stronger.rank_weights[0]) * weaker_total
            );
        }
        let top = PROFILES[9];
        assert_eq!(top.node_limit, u64::MAX);
        assert_eq!(top.noise_cp, 0);
        assert_eq!(top.rank_weights, [1, 0, 0, 0, 0]);
        assert_eq!(top.rank_weights.len(), MAX_CANDIDATES);
    }
}
