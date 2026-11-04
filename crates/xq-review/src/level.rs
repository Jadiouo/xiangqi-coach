//! Pure policy for adapting review depth to caller-calibrated game scores.

use crate::Classification;

const NEW_SCORE_WEIGHT: f64 = 0.3;
const MIN_GAMES: u32 = 3;

/// A finite game-level score computed by the caller from accepted review data.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GameScore(f64);

impl GameScore {
    pub fn new(value: f64) -> Result<Self, LevelError> {
        if value.is_finite() {
            Ok(Self(value))
        } else {
            Err(LevelError::NonFiniteScore)
        }
    }

    pub const fn value(self) -> f64 {
        self.0
    }
}

/// Source of a reviewed game; only a user's unassisted, self-played game is eligible.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LevelProvenance {
    OwnGame,
    AssistedGame,
    ImportedGame,
}

/// Caller-supplied score boundaries, from Entry through Expert.
///
/// They are intentionally not assigned product defaults until calibration has been validated.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CalibrationBands([f64; 4]);

impl CalibrationBands {
    pub fn new(boundaries: [f64; 4]) -> Result<Self, LevelError> {
        if boundaries.iter().any(|value| !value.is_finite())
            || boundaries.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return Err(LevelError::InvalidBands);
        }
        Ok(Self(boundaries))
    }

    fn level_for(self, score: f64) -> SkillLevel {
        match self.0.iter().position(|boundary| score < *boundary) {
            Some(0) => SkillLevel::Entry,
            Some(1) => SkillLevel::Beginner,
            Some(2) => SkillLevel::Intermediate,
            Some(3) => SkillLevel::Proficient,
            _ => SkillLevel::Expert,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillLevel {
    Entry,
    Beginner,
    Intermediate,
    Proficient,
    Expert,
}

impl SkillLevel {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Entry => "entry",
            Self::Beginner => "beginner",
            Self::Intermediate => "intermediate",
            Self::Proficient => "proficient",
            Self::Expert => "expert",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        [
            Self::Entry,
            Self::Beginner,
            Self::Intermediate,
            Self::Proficient,
            Self::Expert,
        ]
        .into_iter()
        .find(|level| level.name() == name)
    }

    /// SPEC 8.5 wording group: Entry and Beginner, Intermediate, Proficient and Expert.
    pub const fn voice(self) -> &'static str {
        match self {
            Self::Entry | Self::Beginner => "beginner",
            Self::Intermediate => "intermediate",
            Self::Proficient | Self::Expert => "proficient",
        }
    }

    /// Whether this level includes a classification in its review annotations.
    pub const fn shows(self, classification: Classification) -> bool {
        if matches!(classification, Classification::MissedMate) {
            return true;
        }
        match self {
            Self::Entry | Self::Beginner => matches!(
                classification,
                Classification::Mistake | Classification::Blunder
            ),
            Self::Intermediate => matches!(
                classification,
                Classification::DoubtfulMove | Classification::Mistake | Classification::Blunder
            ),
            Self::Proficient | Self::Expert => matches!(
                classification,
                Classification::Inaccuracy
                    | Classification::DoubtfulMove
                    | Classification::Mistake
                    | Classification::Blunder
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LevelError {
    NonFiniteScore,
    InvalidBands,
    /// A game score needs at least one reviewed move.
    NoMoves,
}

/// One reviewed move of the user's own, as the game score needs it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScoredPly {
    pub loss_percent: f64,
    pub classification: Classification,
}

/// Weight of the blunder frequency against the mean loss, in percentage points per 100%
/// of moves. Fixed before any calibration data was looked at.
const BLUNDER_RATE_WEIGHT: f64 = 50.0;

/// SPEC 8.5: turn a reviewed game into one score, higher meaning stronger play. The score is
/// minus (mean win-probability loss in percentage points plus 50 times the fraction of moves
/// that were blunders or missed mates).
pub fn game_score(plies: &[ScoredPly]) -> Result<GameScore, LevelError> {
    if plies.is_empty() {
        return Err(LevelError::NoMoves);
    }
    let count = plies.len() as f64;
    let mean_loss = plies.iter().map(|ply| ply.loss_percent).sum::<f64>() / count;
    let blunders = plies
        .iter()
        .filter(|ply| {
            matches!(
                ply.classification,
                Classification::Blunder | Classification::MissedMate
            )
        })
        .count() as f64;
    GameScore::new(-(mean_loss + BLUNDER_RATE_WEIGHT * blunders / count))
}

/// Deterministic estimate state. `level()` falls back to Beginner until three games qualify.
#[derive(Clone, Debug, PartialEq)]
pub struct LevelEstimate {
    auto_score: Option<f64>,
    game_count: u32,
    bands: Option<CalibrationBands>,
    manual_level: Option<SkillLevel>,
}

impl Default for LevelEstimate {
    fn default() -> Self {
        Self::new()
    }
}

impl LevelEstimate {
    pub const fn new() -> Self {
        Self {
            auto_score: None,
            game_count: 0,
            bands: None,
            manual_level: None,
        }
    }

    /// Add an eligible game score with the new observation weighted at 30 percent.
    /// Excluded provenance and manual override leave all automatic state untouched.
    pub fn observe(
        &mut self,
        score: GameScore,
        provenance: LevelProvenance,
        bands: CalibrationBands,
    ) -> Result<(), LevelError> {
        if provenance != LevelProvenance::OwnGame || self.manual_level.is_some() {
            return Ok(());
        }
        self.auto_score = Some(match self.auto_score {
            Some(previous) => {
                previous * (1.0 - NEW_SCORE_WEIGHT) + score.value() * NEW_SCORE_WEIGHT
            }
            None => score.value(),
        });
        self.game_count = self.game_count.saturating_add(1);
        self.bands = Some(bands);
        Ok(())
    }

    /// Rebuild an estimate from stored parts (the caller persists them between sessions).
    pub fn from_parts(
        auto_score: Option<f64>,
        game_count: u32,
        manual_level: Option<SkillLevel>,
        bands: CalibrationBands,
    ) -> Self {
        Self {
            auto_score,
            game_count,
            bands: Some(bands),
            manual_level,
        }
    }

    pub const fn manual_level(&self) -> Option<SkillLevel> {
        self.manual_level
    }

    pub fn set_manual_level(&mut self, level: SkillLevel) {
        self.manual_level = Some(level);
    }

    /// Clear manual choice and all automatic history; caller must supply three new games again.
    pub fn reestimate(&mut self) {
        self.auto_score = None;
        self.game_count = 0;
        self.bands = None;
        self.manual_level = None;
    }

    pub fn level(&self) -> SkillLevel {
        self.manual_level.unwrap_or_else(|| {
            if self.is_calibrated() {
                self.bands
                    .expect("a calibrated estimate always has score bands")
                    .level_for(self.auto_score.expect("a calibrated estimate has a score"))
            } else {
                SkillLevel::Beginner
            }
        })
    }

    /// The level to show to the user: `None` until three eligible games (or a manual choice).
    pub fn displayed_level(&self) -> Option<SkillLevel> {
        (self.is_manual() || self.is_calibrated()).then(|| self.level())
    }

    pub const fn is_calibrated(&self) -> bool {
        self.game_count >= MIN_GAMES
    }

    pub const fn is_manual(&self) -> bool {
        self.manual_level.is_some()
    }

    pub const fn auto_score(&self) -> Option<f64> {
        self.auto_score
    }

    pub const fn game_count(&self) -> u32 {
        self.game_count
    }
}
