import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from match import stable_game_id, stable_seed, verify_batch_games


def records(opening_ids, rounds):
    result = []
    for round_number in rounds:
        for opening_id in opening_ids:
            for a_is_red in (True, False):
                game_id = stable_game_id(round_number, opening_id, a_is_red)
                result.append({
                    "game_id": game_id,
                    "global_round": round_number,
                    "opening_id": opening_id,
                    "a_is_red": a_is_red,
                    "seed": stable_seed(123, game_id),
                    "nodes": 10000,
                    "result_for_a": "win",
                })
    return result


class MatchBatchingTests(unittest.TestCase):
    def test_game_seed_and_id_do_not_depend_on_batch_or_iteration_order(self):
        game_id = stable_game_id(7, "opening-023", False)
        expected = stable_seed(1328726801112436425, game_id)
        reordered = list(reversed([stable_game_id(7, item, False) for item in ("opening-023", "opening-014")]))
        self.assertEqual(stable_seed(1328726801112436425, game_id), expected)
        self.assertIn(game_id, reordered)
        self.assertNotEqual(expected, stable_seed(1328726801112436425, stable_game_id(7, "opening-023", True)))

    def test_verifier_requires_each_opening_round_color_pair_exactly_once(self):
        openings = [f"opening-{index:03}" for index in range(50)]
        games = records(openings, range(1, 11))
        self.assertTrue(verify_batch_games(games, openings, range(1, 11), 10000)["complete"])

        for mutate in (
            lambda rows: rows.pop(),
            lambda rows: rows.append(dict(rows[0])),
            lambda rows: rows[0].update(nodes=5000),
            lambda rows: rows[0].update(result_for_a="unfinished"),
            lambda rows: rows[0].update(game_id="wrong-id"),
        ):
            damaged = [dict(row) for row in games]
            mutate(damaged)
            with self.subTest(mutation=mutate):
                self.assertFalse(verify_batch_games(damaged, openings, range(1, 11), 10000)["complete"])


if __name__ == "__main__":
    unittest.main()
