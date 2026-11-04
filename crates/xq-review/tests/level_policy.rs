use xq_review::{
    CalibrationBands, Classification, GameScore, LevelError, LevelEstimate, LevelProvenance,
    ScoredPly, SkillLevel, game_score,
};

fn bands() -> CalibrationBands {
    CalibrationBands::new([-2.0, -1.0, 1.0, 2.0]).unwrap()
}

fn eligible() -> LevelProvenance {
    LevelProvenance::OwnGame
}

#[test]
fn defaults_to_beginner_until_three_eligible_games() {
    let mut estimate = LevelEstimate::new();
    assert_eq!(estimate.level(), SkillLevel::Beginner);
    assert!(!estimate.is_calibrated());
    for _ in 0..2 {
        estimate
            .observe(GameScore::new(0.0).unwrap(), eligible(), bands())
            .unwrap();
    }
    assert_eq!(estimate.level(), SkillLevel::Beginner);
    assert!(!estimate.is_calibrated());
    estimate
        .observe(GameScore::new(0.0).unwrap(), eligible(), bands())
        .unwrap();
    assert!(estimate.is_calibrated());
    assert_eq!(estimate.level(), SkillLevel::Intermediate);
}

#[test]
fn subsequent_game_score_uses_thirty_percent_weight() {
    let mut estimate = LevelEstimate::new();
    for _ in 0..3 {
        estimate
            .observe(GameScore::new(0.0).unwrap(), eligible(), bands())
            .unwrap();
    }
    estimate
        .observe(GameScore::new(10.0).unwrap(), eligible(), bands())
        .unwrap();
    assert_eq!(estimate.auto_score(), Some(3.0));
}

#[test]
fn excluded_sources_and_invalid_observations_do_not_change_state() {
    let mut estimate = LevelEstimate::new();
    estimate
        .observe(GameScore::new(0.0).unwrap(), eligible(), bands())
        .unwrap();
    let before = estimate.clone();
    for provenance in [LevelProvenance::AssistedGame, LevelProvenance::ImportedGame] {
        estimate
            .observe(GameScore::new(10.0).unwrap(), provenance, bands())
            .unwrap();
    }
    assert_eq!(estimate, before);
    assert!(matches!(
        GameScore::new(f64::NAN),
        Err(LevelError::NonFiniteScore)
    ));
    assert!(matches!(
        GameScore::new(f64::INFINITY),
        Err(LevelError::NonFiniteScore)
    ));
    assert_eq!(estimate, before);
}

#[test]
fn manual_level_freezes_updates_until_reestimate_clears_history() {
    let mut estimate = LevelEstimate::new();
    for _ in 0..3 {
        estimate
            .observe(GameScore::new(0.0).unwrap(), eligible(), bands())
            .unwrap();
    }
    estimate.set_manual_level(SkillLevel::Expert);
    estimate
        .observe(GameScore::new(-10.0).unwrap(), eligible(), bands())
        .unwrap();
    assert_eq!(estimate.level(), SkillLevel::Expert);
    assert_eq!(estimate.auto_score(), Some(0.0));
    estimate.reestimate();
    assert_eq!(estimate.level(), SkillLevel::Beginner);
    assert_eq!(estimate.game_count(), 0);
    assert_eq!(estimate.auto_score(), None);
    assert!(!estimate.is_manual());
}

#[test]
fn calibration_bands_must_be_finite_and_strictly_increasing() {
    for values in [
        [0.0, 0.0, 1.0, 2.0],
        [0.0, 2.0, 1.0, 3.0],
        [0.0, 1.0, f64::NAN, 3.0],
        [0.0, 1.0, 2.0, f64::INFINITY],
    ] {
        assert!(matches!(
            CalibrationBands::new(values),
            Err(LevelError::InvalidBands)
        ));
    }
}

#[test]
fn annotation_filter_tracks_the_three_spec_groupings() {
    use Classification::*;
    assert!(!SkillLevel::Beginner.shows(Inaccuracy));
    assert!(!SkillLevel::Beginner.shows(DoubtfulMove));
    assert!(SkillLevel::Beginner.shows(Mistake));
    assert!(!SkillLevel::Intermediate.shows(Inaccuracy));
    assert!(SkillLevel::Intermediate.shows(DoubtfulMove));
    assert!(SkillLevel::Expert.shows(Inaccuracy));
    assert!(SkillLevel::Expert.shows(DoubtfulMove));
    assert!(SkillLevel::Expert.shows(Blunder));
    assert!(!SkillLevel::Expert.shows(Good));
    assert!(!SkillLevel::Expert.shows(UniqueMove));
}

// ---- TEST_PLAN 6.4.3 to 6.4.7 ------------------------------------------------------------

#[test]
fn six_four_three_fewer_than_three_games_show_no_level() {
    // 6.4.3: before the third eligible game the estimate is uncalibrated, so the page must not
    // present a level (it shows the Beginner default only as an unlabeled fallback).
    let mut estimate = LevelEstimate::new();
    for game in 0..2 {
        estimate
            .observe(GameScore::new(10.0).unwrap(), eligible(), bands())
            .unwrap();
        assert!(!estimate.is_calibrated(), "after {} games", game + 1);
        assert_eq!(estimate.displayed_level(), None);
        assert_eq!(estimate.level(), SkillLevel::Beginner);
    }
    estimate
        .observe(GameScore::new(10.0).unwrap(), eligible(), bands())
        .unwrap();
    assert_eq!(estimate.displayed_level(), Some(SkillLevel::Expert));
}

#[test]
fn six_four_four_five_strong_games_raise_the_score_and_five_weak_games_lower_it() {
    let mut estimate = LevelEstimate::new();
    for _ in 0..3 {
        estimate
            .observe(GameScore::new(0.0).unwrap(), eligible(), bands())
            .unwrap();
    }
    let mut previous = estimate.auto_score().unwrap();
    for _ in 0..5 {
        estimate
            .observe(GameScore::new(10.0).unwrap(), eligible(), bands())
            .unwrap();
        let now = estimate.auto_score().unwrap();
        assert!(now > previous, "{now} should exceed {previous}");
        previous = now;
    }
    let peak = previous;
    for _ in 0..5 {
        estimate
            .observe(GameScore::new(-10.0).unwrap(), eligible(), bands())
            .unwrap();
        let now = estimate.auto_score().unwrap();
        assert!(now < previous, "{now} should be below {previous}");
        previous = now;
    }
    assert!(previous < peak);
}

#[test]
fn six_four_five_a_manual_level_survives_newly_reviewed_games() {
    let mut estimate = LevelEstimate::new();
    estimate.set_manual_level(SkillLevel::Intermediate);
    for score in [-50.0, 50.0, -50.0, 50.0] {
        estimate
            .observe(GameScore::new(score).unwrap(), eligible(), bands())
            .unwrap();
        assert_eq!(estimate.level(), SkillLevel::Intermediate);
        assert_eq!(estimate.displayed_level(), Some(SkillLevel::Intermediate));
    }
}

#[test]
fn six_four_six_assisted_and_imported_games_never_move_the_estimate() {
    let mut estimate = LevelEstimate::new();
    for _ in 0..3 {
        estimate
            .observe(GameScore::new(0.0).unwrap(), eligible(), bands())
            .unwrap();
    }
    let before = estimate.clone();
    for provenance in [LevelProvenance::AssistedGame, LevelProvenance::ImportedGame] {
        for _ in 0..10 {
            estimate
                .observe(GameScore::new(100.0).unwrap(), provenance, bands())
                .unwrap();
        }
    }
    assert_eq!(estimate, before);
}

fn spread_game() -> Vec<Classification> {
    use Classification::*;
    vec![
        Good,
        UniqueMove,
        Unclassified,
        Inaccuracy,
        Inaccuracy,
        DoubtfulMove,
        DoubtfulMove,
        Mistake,
        Blunder,
        MissedMate,
        Good,
        Inaccuracy,
    ]
}

fn marked(level: SkillLevel, game: &[Classification]) -> usize {
    game.iter().filter(|class| level.shows(**class)).count()
}

#[test]
fn six_four_seven_the_same_game_gets_more_marks_as_the_level_rises() {
    let game = spread_game();
    let entry = marked(SkillLevel::Entry, &game);
    let beginner = marked(SkillLevel::Beginner, &game);
    let intermediate = marked(SkillLevel::Intermediate, &game);
    let proficient = marked(SkillLevel::Proficient, &game);
    let expert = marked(SkillLevel::Expert, &game);
    // SPEC 8.5 groups Entry+Beginner, Intermediate, Proficient+Expert: strictly more per group.
    assert!(
        entry < intermediate && intermediate < proficient,
        "{entry} {intermediate} {proficient}"
    );
    assert_eq!(entry, beginner);
    assert_eq!(proficient, expert);
    // The exact counts for this fixed game: mistakes/blunders (+missed mate) only, then + doubtful,
    // then + inaccuracies.
    assert_eq!((entry, intermediate, proficient), (3, 5, 8));
}

#[test]
fn game_score_is_minus_the_mean_loss_and_fifty_times_the_blunder_rate() {
    let ply = |loss_percent, classification| ScoredPly {
        loss_percent,
        classification,
    };
    let quiet = [
        ply(0.0, Classification::Good),
        ply(0.0, Classification::Good),
        ply(10.0, Classification::Mistake),
        ply(10.0, Classification::Mistake),
    ];
    assert_eq!(game_score(&quiet).unwrap().value(), -5.0);
    // One blunder in four plies adds 50 * 0.25 to the penalty; MissedMate counts as a blunder.
    for class in [Classification::Blunder, Classification::MissedMate] {
        let plies = [
            ply(0.0, Classification::Good),
            ply(0.0, Classification::Good),
            ply(0.0, Classification::Good),
            ply(0.0, class),
        ];
        assert_eq!(game_score(&plies).unwrap().value(), -12.5);
    }
    assert_eq!(game_score(&[]), Err(LevelError::NoMoves));
    assert!(matches!(
        game_score(&[ply(f64::NAN, Classification::Good)]),
        Err(LevelError::NonFiniteScore)
    ));
}

#[test]
fn a_cleaner_game_always_scores_higher() {
    let ply = |loss_percent, classification| ScoredPly {
        loss_percent,
        classification,
    };
    let clean = vec![ply(1.0, Classification::Good); 40];
    let sloppy = vec![ply(8.0, Classification::DoubtfulMove); 40];
    let blundering: Vec<_> = (0..40)
        .map(|i| {
            if i % 8 == 0 {
                ply(40.0, Classification::Blunder)
            } else {
                ply(1.0, Classification::Good)
            }
        })
        .collect();
    let (c, s, b) = (
        game_score(&clean).unwrap().value(),
        game_score(&sloppy).unwrap().value(),
        game_score(&blundering).unwrap().value(),
    );
    assert!(c > s && c > b, "{c} {s} {b}");
}

#[test]
fn a_missed_mate_is_marked_at_every_level() {
    // SPEC 8.3: in a decided position the mate check replaces the loss percentage, so a
    // missed mate is never filtered out by a low level.
    for level in [
        SkillLevel::Entry,
        SkillLevel::Beginner,
        SkillLevel::Intermediate,
        SkillLevel::Proficient,
        SkillLevel::Expert,
    ] {
        assert!(level.shows(Classification::MissedMate), "{level:?}");
    }
}

#[test]
fn skill_levels_have_stable_names_and_a_review_voice() {
    let all = [
        (SkillLevel::Entry, "entry", "beginner"),
        (SkillLevel::Beginner, "beginner", "beginner"),
        (SkillLevel::Intermediate, "intermediate", "intermediate"),
        (SkillLevel::Proficient, "proficient", "proficient"),
        (SkillLevel::Expert, "expert", "proficient"),
    ];
    for (level, name, voice) in all {
        assert_eq!(level.name(), name);
        assert_eq!(SkillLevel::from_name(name), Some(level));
        assert_eq!(level.voice(), voice, "SPEC 8.5 wording groups");
    }
    assert_eq!(SkillLevel::from_name("grandmaster"), None);
}

#[test]
fn an_estimate_round_trips_through_its_stored_parts() {
    let mut estimate = LevelEstimate::new();
    for score in [0.0, 5.0, 10.0] {
        estimate
            .observe(GameScore::new(score).unwrap(), eligible(), bands())
            .unwrap();
    }
    let restored = LevelEstimate::from_parts(
        estimate.auto_score(),
        estimate.game_count(),
        estimate.manual_level(),
        bands(),
    );
    assert_eq!(restored, estimate);
    let manual = LevelEstimate::from_parts(Some(0.0), 7, Some(SkillLevel::Expert), bands());
    assert_eq!(manual.level(), SkillLevel::Expert);
    assert_eq!(manual.manual_level(), Some(SkillLevel::Expert));
    assert_eq!(manual.game_count(), 7);
}
