//! Browser-facing, stateless wrapper over the SPEC 8.5 level policy. The page stores the
//! estimate as JSON and passes it in; nothing here keeps state, reads a clock or touches storage.

use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
use xq_review::{
    CalibrationBands, Classification, GameScore, LevelEstimate, LevelProvenance, ScoredPly,
    SkillLevel, game_score,
};

/// Score boundaries between Entry, Beginner, Intermediate, Proficient and Expert: the midpoints
/// between the mean game scores of the frozen engine games at difficulty 2, 4, 6, 8 and 10
/// (-35.529, -31.627, -12.091, -4.345, -0.648; docs/DECISIONS.md, 6.4 protocol). Engine
/// difficulty is only a proxy for human skill, so these are first estimates to be recalibrated
/// against real users.
const BAND_BOUNDARIES: [f64; 4] = [-33.578, -21.859, -8.218, -2.4965];

fn bands() -> CalibrationBands {
    CalibrationBands::new(BAND_BOUNDARIES).expect("the compiled-in bands are valid")
}

fn error(message: &str) -> String {
    json!({ "error": message }).to_string()
}

fn parse_state(text: &str) -> Result<LevelEstimate, &'static str> {
    let value: Value = serde_json::from_str(text).map_err(|_| "state is not JSON")?;
    let auto_score = match &value["autoScore"] {
        Value::Null => None,
        number => Some(
            number
                .as_f64()
                .filter(|n| n.is_finite())
                .ok_or("bad autoScore")?,
        ),
    };
    let game_count = value["gameCount"]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .ok_or("bad gameCount")?;
    let manual = match &value["manual"] {
        Value::Null => None,
        name => Some(
            name.as_str()
                .and_then(SkillLevel::from_name)
                .ok_or("bad manual level")?,
        ),
    };
    if auto_score.is_none() != (game_count == 0) {
        return Err("autoScore and gameCount disagree");
    }
    Ok(LevelEstimate::from_parts(
        auto_score,
        game_count,
        manual,
        bands(),
    ))
}

fn view(estimate: &LevelEstimate) -> String {
    let level = estimate.level();
    json!({
        "state": {
            "autoScore": estimate.auto_score(),
            "gameCount": estimate.game_count(),
            "manual": estimate.manual_level().map(SkillLevel::name),
        },
        "level": level.name(),
        "voice": level.voice(),
        "displayed": estimate.displayed_level().is_some(),
        "manual": estimate.is_manual(),
        "gameCount": estimate.game_count(),
    })
    .to_string()
}

fn classification(name: &str) -> Option<Classification> {
    Some(match name {
        "unclassified" => Classification::Unclassified,
        "good" => Classification::Good,
        "unique_move" => Classification::UniqueMove,
        "inaccuracy" => Classification::Inaccuracy,
        "doubtful_move" => Classification::DoubtfulMove,
        "mistake" => Classification::Mistake,
        "blunder" => Classification::Blunder,
        "missed_mate" => Classification::MissedMate,
        _ => return None,
    })
}

fn parse_plies(text: &str) -> Result<Vec<ScoredPly>, &'static str> {
    let value: Value = serde_json::from_str(text).map_err(|_| "plies are not JSON")?;
    value
        .as_array()
        .ok_or("plies must be an array")?
        .iter()
        .map(|ply| {
            Ok(ScoredPly {
                loss_percent: ply["lossPercent"].as_f64().ok_or("bad lossPercent")?,
                classification: ply["classification"]
                    .as_str()
                    .and_then(classification)
                    .ok_or("bad classification")?,
            })
        })
        .collect()
}

/// Describe a stored estimate (level, wording voice, whether to show it).
#[wasm_bindgen]
pub fn level_view(state: &str) -> String {
    match parse_state(state) {
        Ok(estimate) => view(&estimate),
        Err(message) => error(message),
    }
}

/// Add one reviewed game. `provenance` is "own", "assisted" or "imported"; only "own" counts.
#[wasm_bindgen]
pub fn level_observe(state: &str, plies: &str, provenance: &str) -> String {
    let provenance = match provenance {
        "own" => LevelProvenance::OwnGame,
        "assisted" => LevelProvenance::AssistedGame,
        "imported" => LevelProvenance::ImportedGame,
        _ => return error("unknown provenance"),
    };
    let mut estimate = match parse_state(state) {
        Ok(estimate) => estimate,
        Err(message) => return error(message),
    };
    let score: GameScore = match parse_plies(plies).and_then(|list| {
        game_score(&list).map_err(|_| "a game needs at least one finite reviewed move")
    }) {
        Ok(score) => score,
        Err(message) => return error(message),
    };
    if estimate.observe(score, provenance, bands()).is_err() {
        return error("observation rejected");
    }
    view(&estimate)
}

/// Pin the level by hand (freezes automatic updates).
#[wasm_bindgen]
pub fn level_set_manual(state: &str, level: &str) -> String {
    let mut estimate = match parse_state(state) {
        Ok(estimate) => estimate,
        Err(message) => return error(message),
    };
    let Some(level) = SkillLevel::from_name(level) else {
        return error("unknown level");
    };
    estimate.set_manual_level(level);
    view(&estimate)
}

/// A cleared estimate: no history, no manual choice (the 重新估計 button).
#[wasm_bindgen]
pub fn level_reestimate() -> String {
    let mut estimate = LevelEstimate::new();
    estimate.reestimate();
    view(&estimate)
}

/// Whether review annotations at `level` include a move of this classification.
#[wasm_bindgen]
pub fn level_shows(level: &str, classification_name: &str) -> bool {
    match (
        SkillLevel::from_name(level),
        classification(classification_name),
    ) {
        (Some(level), Some(class)) => level.shows(class),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn parse(text: String) -> Value {
        serde_json::from_str(&text).unwrap_or_else(|error| panic!("{error}: {text:?}"))
    }

    fn plies(loss: f64, classification: &str, count: usize) -> String {
        json!(
            (0..count)
                .map(|_| json!({"lossPercent": loss, "classification": classification}))
                .collect::<Vec<_>>()
        )
        .to_string()
    }

    #[test]
    fn a_fresh_state_shows_no_level_and_the_beginner_voice() {
        let view = parse(level_reestimate());
        assert_eq!(view["level"], "beginner");
        assert_eq!(view["voice"], "beginner");
        assert_eq!(view["displayed"], false);
        assert_eq!(view["manual"], false);
        assert_eq!(view["gameCount"], 0);
        assert_eq!(
            parse(level_view(&view["state"].to_string()))["level"],
            "beginner"
        );
    }

    #[test]
    fn three_own_games_calibrate_and_clean_play_outranks_blundering() {
        let mut state = parse(level_reestimate())["state"].to_string();
        for game in 0..3 {
            let view = parse(level_observe(&state, &plies(0.5, "good", 40), "own"));
            assert_eq!(view["gameCount"], game + 1);
            assert_eq!(
                view["displayed"],
                game == 2,
                "shown only from the third game"
            );
            state = view["state"].to_string();
        }
        let strong = parse(level_view(&state));
        assert_eq!(strong["level"], "expert");
        assert_eq!(strong["voice"], "proficient");

        let mut weak = parse(level_reestimate())["state"].to_string();
        for _ in 0..3 {
            weak = parse(level_observe(&weak, &plies(35.0, "blunder", 40), "own"))["state"]
                .to_string();
        }
        let weak = parse(level_view(&weak));
        assert_eq!(weak["level"], "entry");
        assert_eq!(weak["voice"], "beginner");
    }

    #[test]
    fn imported_and_assisted_games_leave_the_state_unchanged() {
        let start = parse(level_reestimate())["state"].to_string();
        for provenance in ["imported", "assisted"] {
            let view = parse(level_observe(&start, &plies(0.5, "good", 40), provenance));
            assert_eq!(
                view["state"],
                parse(level_view(&start))["state"],
                "{provenance}"
            );
            assert_eq!(view["gameCount"], 0);
        }
        let bad = parse(level_observe(&start, &plies(0.5, "good", 40), "mystery"));
        assert!(bad["error"].is_string());
    }

    #[test]
    fn a_manual_level_freezes_the_estimate_until_it_is_cleared() {
        let start = parse(level_reestimate())["state"].to_string();
        let manual = parse(level_set_manual(&start, "intermediate"));
        assert_eq!(manual["level"], "intermediate");
        assert_eq!(manual["manual"], true);
        assert_eq!(manual["displayed"], true);
        let state = manual["state"].to_string();
        let after = parse(level_observe(&state, &plies(35.0, "blunder", 40), "own"));
        assert_eq!(after["level"], "intermediate");
        assert_eq!(after["gameCount"], 0);
        let cleared = parse(level_reestimate());
        assert_eq!(cleared["manual"], false);
        assert!(parse(level_set_manual(&state, "grandmaster"))["error"].is_string());
    }

    #[test]
    fn bad_input_is_reported_not_trusted() {
        assert!(parse(level_view("not json"))["error"].is_string());
        let start = parse(level_reestimate())["state"].to_string();
        assert!(
            parse(level_observe(&start, "[]", "own"))["error"].is_string(),
            "no moves"
        );
        assert!(
            parse(level_observe(
                &start,
                "[{\"lossPercent\":1,\"classification\":\"nope\"}]",
                "own"
            ))["error"]
                .is_string()
        );
    }

    #[test]
    fn the_engine_levels_land_in_their_own_bands() {
        // Mean scores of the frozen 6.4.1 games (levels 2, 4, 6, 8, 10) must be classified as
        // Entry, Beginner, Intermediate, Proficient, Expert: the bands are the midpoints between
        // consecutive level means. A constant mean loss `m` with no blunders scores exactly -m.
        let means = [35.529, 31.627, 12.091, 4.345, 0.648];
        let expected = ["entry", "beginner", "intermediate", "proficient", "expert"];
        for (loss, level) in means.into_iter().zip(expected) {
            let mut state = parse(level_reestimate())["state"].to_string();
            for _ in 0..3 {
                state = parse(level_observe(&state, &plies(loss, "good", 40), "own"))["state"]
                    .to_string();
            }
            assert_eq!(
                parse(level_view(&state))["level"],
                level,
                "mean loss {loss}"
            );
        }
    }

    #[test]
    fn marking_follows_the_level_policy() {
        assert!(!level_shows("entry", "doubtful_move"));
        assert!(level_shows("intermediate", "doubtful_move"));
        assert!(!level_shows("intermediate", "inaccuracy"));
        assert!(level_shows("expert", "inaccuracy"));
        assert!(level_shows("entry", "missed_mate"));
        assert!(!level_shows("expert", "good"));
        assert!(!level_shows("no_such_level", "blunder"));
    }
}
