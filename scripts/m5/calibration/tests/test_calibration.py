import math
import unittest

from calibration import (
    CalibrationError,
    calibrate,
    compare_heldout,
    deduplicate_replays,
    fit_k,
    game_log_loss,
    logistic_probability,
    separate_mate_summary,
    split_source_groups,
)


class SourceSplitTests(unittest.TestCase):
    def test_shared_position_unions_source_pgns_before_deterministic_split(self):
        rows = [
            {"source_pgn_sha256": "a", "position_key": "board-X w", "id": "1"},
            {"source_pgn_sha256": "b", "position_key": "board-X w", "id": "2"},
            {"source_pgn_sha256": "c", "position_key": "board-Y b", "id": "3"},
        ]
        first = split_source_groups(rows, salt="fixed", train_fraction=0.5)
        self.assertEqual(first, split_source_groups(rows, salt="fixed", train_fraction=0.5))
        self.assertEqual(first["a"], first["b"])
        self.assertIn(first["c"], {"train", "heldout"})


class ReplayDedupTests(unittest.TestCase):
    def test_seed_does_not_make_same_replay_a_new_game(self):
        rows = [
            {"starting_fen": "full fen A", "iccs_moves": ["a0a1", "b9b8"], "seed": 1, "split": "train"},
            {"starting_fen": "full fen A", "iccs_moves": ["a0a1", "b9b8"], "seed": 999, "split": "train"},
        ]
        self.assertEqual(len(deduplicate_replays(rows)), 1)

    def test_duplicate_replay_across_splits_is_hard_error(self):
        rows = [
            {"starting_fen": "full fen A", "iccs_moves": ["a0a1"], "split": "train"},
            {"starting_fen": "full fen A", "iccs_moves": ["a0a1"], "split": "heldout"},
        ]
        with self.assertRaises(CalibrationError):
            deduplicate_replays(rows)


class CalibrationTests(unittest.TestCase):
    def test_logistic_is_symmetric_monotone_and_stable_at_extremes(self):
        self.assertEqual(logistic_probability(0, 300), 0.5)
        self.assertAlmostEqual(logistic_probability(300, 300) + logistic_probability(-300, 300), 1.0)
        self.assertLess(logistic_probability(-100, 300), 0.5)
        self.assertGreater(logistic_probability(100, 300), 0.5)
        self.assertTrue(math.isfinite(logistic_probability(10**9, 10)))
        self.assertTrue(math.isfinite(logistic_probability(-(10**9), 10)))
        extreme_win = {"cp": 10**308, "outcome": "red_win", "perspective": "red", "game_id": "extreme"}
        self.assertEqual(game_log_loss([extreme_win], 10), 0.0)

    def test_cp_and_outcome_use_the_same_side_perspective_and_draw_is_half(self):
        red_win = {"cp": 300, "outcome": "red_win", "perspective": "red", "game_id": "r"}
        black_win = {"cp": 300, "outcome": "black_win", "perspective": "black", "game_id": "b"}
        draw = {"cp": 300, "outcome": "draw", "perspective": "red", "game_id": "d"}
        self.assertAlmostEqual(game_log_loss([red_win], 300), game_log_loss([black_win], 300))
        p = logistic_probability(300, 300)
        self.assertAlmostEqual(game_log_loss([draw], 300), -0.5 * (math.log(p) + math.log1p(-p)))

    def test_each_game_has_equal_weight_despite_different_sample_counts(self):
        one = [{"cp": 300, "outcome": "red_win", "perspective": "red", "game_id": "one"}]
        many = [{"cp": -300, "outcome": "red_win", "perspective": "red", "game_id": "many"}] * 8
        combined = game_log_loss(one + many, 300)
        self.assertAlmostEqual(combined, (game_log_loss(one, 300) + game_log_loss(many, 300)) / 2)

    def test_fit_uses_train_only_and_heldout_comparison_uses_same_records(self):
        train = [
            {"cp": cp, "outcome": outcome, "perspective": "red", "game_id": f"g{i}"}
            for i, (cp, outcome) in enumerate([(50, "red_win"), (100, "red_win"), (-50, "black_win"), (-100, "black_win")] * 8)
        ]
        heldout = [{"cp": 100, "outcome": "red_win", "perspective": "red", "game_id": "h"}]
        first = calibrate(train, heldout)
        changed_heldout = calibrate(train, [{"cp": -10000, "outcome": "black_win", "perspective": "red", "game_id": "h2"}])
        self.assertEqual(first.fit.k, changed_heldout.fit.k)
        self.assertNotEqual(first.comparison.fitted_log_loss, changed_heldout.comparison.fitted_log_loss)
        report = first.comparison
        self.assertEqual(report.sample_games, 1)
        self.assertEqual(report.baseline_k, 300)
        self.assertIn(report.status, {"improved", "not_improved"})

    def test_synthetic_curve_can_improve_baseline_and_no_improvement_is_reported(self):
        calibrated = [
            {"cp": cp, "outcome": outcome, "perspective": "red", "game_id": f"g{i}"}
            for i, (cp, outcome) in enumerate([(1000, "red_win"), (1000, "red_win"), (-1000, "black_win"), (-1000, "black_win")] * 10)
        ]
        fit = fit_k(calibrated)
        self.assertEqual(fit.k, 10)
        report = compare_heldout(fit, calibrated)
        self.assertEqual(report.status, "improved")
        self.assertTrue(fit.boundary_hit)
        flat = [{"cp": 0, "outcome": "draw", "perspective": "red", "game_id": f"z{i}"} for i in range(5)]
        flat_report = compare_heldout(fit_k(flat), flat)
        self.assertEqual(flat_report.status, "not_improved")

    def test_mate_records_are_excluded_from_k_fit(self):
        train = [{"cp": 0, "outcome": "draw", "perspective": "red", "game_id": "g"}]
        with self.assertRaises(CalibrationError):
            fit_k(train + [{"mate": 1, "outcome": "red_win", "perspective": "red", "game_id": "g"}])

    def test_mate_binary_summary_is_separate_from_draw_half_score(self):
        rows = [
            {"mate": "win", "outcome": "red_win", "perspective": "red"},
            {"mate": "loss", "outcome": "draw", "perspective": "red"},
        ]
        self.assertEqual(separate_mate_summary(rows), {"count": 2, "actual_positive": 1, "correct": 2})


if __name__ == "__main__":
    unittest.main()
