import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from match import baseline_gate, bounded_mean_interval, summarize_results


class MatchStatisticsTests(unittest.TestCase):
    def test_all_wins_still_have_finite_lower_bound_and_clipped_upper_elo(self):
        low, high = bounded_mean_interval([1.0] * 50, alpha=0.025, population_size=203)
        self.assertAlmostEqual(low, 1 - 0.18233, places=4)
        self.assertEqual(high, 1.0)

    def test_finite_population_serfling_and_hoeffding_bounds_are_separate(self):
        serfling = bounded_mean_interval([0.5] * 50, alpha=0.025, population_size=203)
        hoeffding = bounded_mean_interval([0.5] * 50, alpha=0.025, population_size=None)
        self.assertAlmostEqual(serfling[1] - 0.5, 0.18233, places=4)
        self.assertAlmostEqual(hoeffding[1] - 0.5, (4.382026634673881 / 100) ** 0.5, places=8)
        self.assertLess(serfling[1] - 0.5, hoeffding[1] - 0.5)

    def test_unfinished_games_stay_in_requested_denominator_and_block_gate(self):
        totals = {"win": 2, "draw": 0, "loss": 0, "unfinished": 1}
        summary = summarize_results(
            requested_games=3,
            totals=totals,
            opening_scores={"opening-1": [1.0]},
            strategy_a="search",
            strategy_b="random",
            population_size=203,
            selected_opening_count=50,
            finite_population_verified=True,
        )
        self.assertEqual(summary["finished_games"], 2)
        self.assertEqual(summary["unfinished_games"], 1)
        self.assertEqual(summary["requested_games"], 3)
        self.assertFalse(summary["complete"])
        self.assertFalse(summary["baseline_gate"]["passed"])

    def test_greedy_gate_counts_wins_only_and_all_ties_do_not_pass(self):
        verified = dict(nodes_per_move=10000, selection_verified=True,
                        selected_opening_count=50, paired_games_complete=True)
        all_ties = baseline_gate("search", "greedy", {"win": 0, "draw": 1000, "loss": 0, "unfinished": 0}, 1000, **verified)
        enough_wins = baseline_gate("search", "greedy", {"win": 980, "draw": 20, "loss": 0, "unfinished": 0}, 1000, **verified)
        self.assertFalse(all_ties["passed"])
        self.assertEqual(all_ties["required_wins"], 980)
        self.assertTrue(enough_wins["passed"])

    def test_random_gate_requires_one_thousand_completed_wins(self):
        verified = dict(nodes_per_move=10000, selection_verified=True,
                        selected_opening_count=50, paired_games_complete=True)
        passed = baseline_gate("search", "random", {"win": 1000, "draw": 0, "loss": 0, "unfinished": 0}, 1000, **verified)
        tied = baseline_gate("search", "random", {"win": 999, "draw": 1, "loss": 0, "unfinished": 0}, 1000, **verified)
        self.assertTrue(passed["passed"])
        self.assertFalse(tied["passed"])

    def test_fake_thousand_game_totals_cannot_pass_without_frozen_protocol_and_nodes(self):
        totals = {"win": 1000, "draw": 0, "loss": 0, "unfinished": 0}
        for kwargs in (
            {},
            {"nodes_per_move": 10000, "selected_opening_count": 2,
             "paired_games_complete": True},
            {"nodes_per_move": 5000, "selection_verified": True,
             "selected_opening_count": 50, "paired_games_complete": True},
            {"nodes_per_move": 10000, "selection_verified": True,
             "selected_opening_count": 50, "paired_games_complete": False},
        ):
            with self.subTest(kwargs=kwargs):
                gate = baseline_gate("search", "random", totals, 1000, **kwargs)
                self.assertFalse(gate["passed"])

    def test_repeated_rounds_on_same_opening_remain_one_effective_cluster(self):
        summary = summarize_results(
            requested_games=4,
            totals={"win": 2, "draw": 2, "loss": 0, "unfinished": 0},
            opening_scores={"opening-1": [0.5, 1.0]},
            strategy_a="search",
            strategy_b="search",
            population_size=203,
            selected_opening_count=1,
        )
        self.assertEqual(summary["effective_cluster_count"], 1)
        self.assertEqual(summary["cluster_score_means"]["opening-1"], 0.75)
        self.assertFalse(summary["formal_decision_ready"])

    def test_user_supplied_population_size_does_not_verify_selection_protocol(self):
        summary = summarize_results(
            requested_games=200,
            totals={"win": 100, "draw": 0, "loss": 100, "unfinished": 0},
            opening_scores={f"opening-{index}": [0.5, 0.5] for index in range(50)},
            strategy_a="search",
            strategy_b="search",
            population_size=203,
            selected_opening_count=50,
        )
        self.assertFalse(summary["formal_decision_ready"])
        self.assertEqual(summary["finite_population_size"], None)
        self.assertIn("not verified", summary["decision_interval_method"])

    def test_all_losses_report_negative_decision_without_comparing_elo_strings(self):
        summary = summarize_results(
            requested_games=200,
            totals={"win": 0, "draw": 0, "loss": 200, "unfinished": 0},
            opening_scores={f"opening-{index}": [0.0, 0.0] for index in range(50)},
            strategy_a="search",
            strategy_b="search",
            population_size=203,
            selected_opening_count=50,
            finite_population_verified=True,
        )
        self.assertEqual(summary["decision_status"], "inconclusive")
        self.assertGreater(summary["decision_97_5_score_interval"][1], 0.0)
        self.assertAlmostEqual(summary["decision_97_5_score_interval"][1], 0.1823265221, places=9)
        self.assertLess(summary["decision_97_5_score_interval"][1], 0.5)


if __name__ == "__main__":
    unittest.main()
