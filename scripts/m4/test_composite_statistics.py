import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from composite_statistics import calculate_combined_statistics, should_run_second_look


def make_look(prefix, result, rounds=(1, 2)):
    rows = {}
    for opening in range(50):
        oid = f"{prefix}-{opening:02d}"
        for a_is_red in (True, False):
            for round_number in rounds:
                rows[(oid, a_is_red, round_number)] = ((), "draw", result)
    return rows


class CompositeStatisticsTests(unittest.TestCase):
    def test_two_disjoint_looks_form_one_hundred_clusters_in_population_153(self):
        look1 = make_look("first", "win")
        look2 = make_look("second", "loss", (3, 4))
        stats = calculate_combined_statistics(look1, look2)
        self.assertEqual(stats["opening_cluster_count"], 100)
        self.assertEqual(stats["finite_population_size"], 153)
        self.assertAlmostEqual(stats["score_mean"], 0.5)
        self.assertAlmostEqual(stats["decision_97_5_score_interval"][0], 0.5 - (0.5 * (1 - 99 / 153) * __import__("math").log(80) / 100) ** 0.5)
        self.assertEqual(stats["per_look_cluster_counts"], {"look1": 50, "look2": 50})

    def test_second_look_requires_first_interval_to_cross_half(self):
        self.assertTrue(should_run_second_look([0.4, 0.6]))
        self.assertTrue(should_run_second_look([0.5, 0.7]))
        self.assertFalse(should_run_second_look([0.51, 0.8]))
        self.assertFalse(should_run_second_look([0.1, 0.49]))

    def test_overlapping_or_incomplete_opening_sets_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "overlap"):
            calculate_combined_statistics(
                make_look("same", "win"), make_look("same", "loss", (3, 4))
            )
        incomplete = make_look("first", "win")
        first_id = next(iter(incomplete))[0]
        incomplete = {key: value for key, value in incomplete.items() if key[0] != first_id}
        with self.assertRaisesRegex(ValueError, "exactly 50"):
            calculate_combined_statistics(incomplete, make_look("second", "loss", (3, 4)))


if __name__ == "__main__":
    unittest.main()
