import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from select_openings import eligible_rows, select_rows


class SelectOpeningsTests(unittest.TestCase):
    def setUp(self):
        self.rows = [
            {"opening_id": f"opening-{index:03}", "position_key": f"key-{index:03}"}
            for index in range(80)
        ]

    def test_uses_sorted_population_and_fixed_seed_for_exact_unique_sample(self):
        sample = select_rows(list(reversed(self.rows)), seed=1328726801112436425, count=50)
        repeated = select_rows(self.rows, seed=1328726801112436425, count=50)

        self.assertEqual(sample, repeated)
        self.assertEqual(len(sample), 50)
        self.assertEqual(len({row["position_key"] for row in sample}), 50)
        expected = random.Random(1328726801112436425).sample(sorted(self.rows, key=lambda r: r["position_key"]), 50)
        self.assertEqual(sample, expected)

    def test_rejects_population_smaller_than_requested_sample(self):
        with self.assertRaisesRegex(ValueError, "eligible population"):
            select_rows(self.rows[:49], seed=1328726801112436425, count=50)

    def test_eligibility_requires_final_exact_score_and_legal_matching_bestmove(self):
        exact = {
            "opening_id": "exact",
            "position_key": "b-board w",
            "red_to_move_after_cutoff": True,
            "root_legal_moves": ["a3a4"],
            "reference_balance": {
                "score_cp_stm": -100,
                "score_cp_red": -100,
                "bound": "none",
                "bestmove": "a3a4",
                "final_info": {"score_type": "cp", "score": -100, "bound": None, "pv": ["a3a4"]},
            },
            "validation": {"balanced": True, "acceptance_reason": "within_external_balance_threshold"},
        }
        unknown = {
            "opening_id": "unknown",
            "position_key": "a-board w",
            "validation": {"balanced": None, "acceptance_reason": "unknown_final_bound"},
        }
        accepted = eligible_rows([unknown, exact])
        self.assertEqual([row["opening_id"] for row in accepted], ["exact"])

    def test_rejects_a_claimed_eligible_row_that_fails_the_balance_gate(self):
        invalid = {
            "opening_id": "bad",
            "position_key": "board w",
            "root_legal_moves": ["a3a4"],
            "reference_balance": {
                "score_cp_stm": 80,
                "bound": "none",
                "bestmove": "a3a4",
                "final_info": {"score_type": "mate", "score": 1, "bound": None, "pv": ["a3a4"]},
            },
            "validation": {"balanced": True, "acceptance_reason": "within_external_balance_threshold"},
        }
        with self.assertRaisesRegex(ValueError, "balance gate"):
            eligible_rows([invalid])


if __name__ == "__main__":
    unittest.main()
