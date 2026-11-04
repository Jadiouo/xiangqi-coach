//! TEST_PLAN 6.4.1, 6.4.2 and the real-data half of 6.4.7.
//!
//! The games are engine self-play at difficulty 2, 4, 6, 8 and 10 (30 per level, fixed
//! openings), generated once by `level-games` and frozen in `fixtures/level-games/`. The
//! protocol (what counts as the user, the score formula, the 80% rule over all pairs) is fixed
//! in docs/DECISIONS.md and must not be changed after seeing results.

use std::collections::BTreeMap;

use xq_core::{Game, GameOutcome, Move, Position};
use xq_review::{Classification, ScoredPly, SkillLevel, game_score};

const GAMES: &str = include_str!("fixtures/level-games/games.tsv");
const PLIES: &str = include_str!("fixtures/level-games/plies.tsv");
const LEVELS: [u8; 5] = [2, 4, 6, 8, 10];

fn class(name: &str) -> Classification {
    match name {
        "Unclassified" => Classification::Unclassified,
        "Good" => Classification::Good,
        "UniqueMove" => Classification::UniqueMove,
        "Inaccuracy" => Classification::Inaccuracy,
        "DoubtfulMove" => Classification::DoubtfulMove,
        "Mistake" => Classification::Mistake,
        "Blunder" => Classification::Blunder,
        "MissedMate" => Classification::MissedMate,
        other => panic!("unknown classification {other}"),
    }
}

/// (level, game index) -> reviewed plies of the user side.
fn reviewed() -> BTreeMap<(u8, u32), Vec<ScoredPly>> {
    let mut map: BTreeMap<(u8, u32), Vec<ScoredPly>> = BTreeMap::new();
    for line in PLIES.lines().filter(|line| !line.is_empty()) {
        let cols: Vec<&str> = line.split('\t').collect();
        if cols[0] == "S" {
            continue; // a skipped (unreviewable) ply, listed in the fixture for the record
        }
        assert_eq!(cols[0], "P", "{line}");
        map.entry((cols[1].parse().unwrap(), cols[2].parse().unwrap()))
            .or_default()
            .push(ScoredPly {
                loss_percent: cols[5].parse().unwrap(),
                classification: class(cols[6]),
            });
    }
    map
}

fn scores() -> BTreeMap<u8, Vec<f64>> {
    let data = reviewed();
    let mut by_level: BTreeMap<u8, Vec<f64>> = BTreeMap::new();
    for ((level, _), plies) in &data {
        by_level
            .entry(*level)
            .or_default()
            .push(game_score(plies).unwrap().value());
    }
    by_level
}

#[test]
fn the_frozen_games_are_thirty_legal_games_for_each_of_the_five_levels() {
    let mut seen: BTreeMap<u8, u32> = BTreeMap::new();
    for line in GAMES.lines().filter(|line| !line.is_empty()) {
        let cols: Vec<&str> = line.split('\t').collect();
        assert_eq!(cols[0], "G");
        let level: u8 = cols[1].parse().unwrap();
        let mut game = Game::new(Position::startpos());
        for token in cols[7].split_whitespace() {
            game.play(Move::from_iccs(token).unwrap())
                .unwrap_or_else(|error| panic!("{line}: {token}: {error:?}"));
        }
        let ended = game.outcome().is_some();
        assert_eq!(ended, cols[5] != "cap", "{}: result column", cols[3]);
        if let Some(GameOutcome::Win(_)) = game.outcome() {
            assert_ne!(cols[5], "draw");
        }
        *seen.entry(level).or_default() += 1;
    }
    assert_eq!(seen, LEVELS.iter().map(|level| (*level, 30)).collect());
    let data = reviewed();
    for level in LEVELS {
        for index in 0..30 {
            assert!(
                data.contains_key(&(level, index)),
                "no reviewed plies for {level}/{index}"
            );
        }
    }
}

#[test]
fn six_four_one_mean_score_rises_strictly_with_difficulty() {
    let by_level = scores();
    let means: Vec<f64> = LEVELS
        .iter()
        .map(|level| {
            let values = &by_level[level];
            assert_eq!(values.len(), 30);
            values.iter().sum::<f64>() / values.len() as f64
        })
        .collect();
    eprintln!("6.4.1 mean score per level 2/4/6/8/10: {means:.3?}");
    for pair in means.windows(2) {
        assert!(
            pair[0] < pair[1],
            "mean scores must strictly increase: {means:.3?}"
        );
    }
}

#[test]
fn six_four_two_the_estimator_picks_the_stronger_of_any_two_games_at_least_80_percent() {
    let by_level = scores();
    let (mut correct, mut total) = (0_u32, 0_u32);
    for (position, low) in LEVELS.iter().enumerate() {
        for high in &LEVELS[position + 1..] {
            for weak in &by_level[low] {
                for strong in &by_level[high] {
                    total += 1;
                    // A tie does not identify the stronger game, so it counts as wrong.
                    if strong > weak {
                        correct += 1;
                    }
                }
            }
        }
    }
    assert_eq!(total, 9_000);
    let accuracy = f64::from(correct) / f64::from(total);
    eprintln!("6.4.2 pairwise accuracy: {correct}/{total} = {accuracy:.4}");
    assert!(
        accuracy >= 0.80,
        "accuracy {accuracy:.4} ({correct}/{total})"
    );
}

#[test]
fn six_four_seven_on_real_games_marks_rise_with_the_level() {
    let data = reviewed();
    let mut totals = [0_usize; 3];
    let mut strictly = 0;
    for plies in data.values() {
        let count = |level: SkillLevel| {
            plies
                .iter()
                .filter(|ply| level.shows(ply.classification))
                .count()
        };
        let (entry, middle, expert) = (
            count(SkillLevel::Entry),
            count(SkillLevel::Intermediate),
            count(SkillLevel::Expert),
        );
        assert!(entry <= middle && middle <= expert);
        assert_eq!(entry, count(SkillLevel::Beginner));
        assert_eq!(expert, count(SkillLevel::Proficient));
        if entry < middle && middle < expert {
            strictly += 1;
        }
        totals[0] += entry;
        totals[1] += middle;
        totals[2] += expert;
    }
    eprintln!(
        "6.4.7 marks over all games (entry/intermediate/expert): {totals:?}, strictly ordered games: {strictly}"
    );
    assert!(totals[0] < totals[1] && totals[1] < totals[2]);
    assert!(
        strictly > 0,
        "at least one real game separates all three groups"
    );
}
