import unittest

from extract_puzzles import flatboard_to_fen, parse_embedded_pool, solution_to_iccs


class XiangqiPlayExtractionTests(unittest.TestCase):
    def test_embedded_pool_is_parsed_from_escaped_rsc_json(self):
        html = r'''<script>self.__next_f.push([1,"$L30",null,{\"mode\":\"play\",\"pool\":[{\"id\":\"mate1-01\",\"fen\":\".h...g...\",\"side\":\"r\",\"solutions\":[{\"from\":{\"row\":6,\"col\":0},\"to\":{\"row\":6,\"col\":5}}]}]}]);</script>'''
        self.assertEqual(parse_embedded_pool(html)[0]["id"], "mate1-01")

    def test_flatboard_converts_to_project_fen_and_iccs(self):
        flat = ".h...g...............H................................R...............H....G............C."
        self.assertEqual(
            flatboard_to_fen(flat, "r"),
            "1n3k3/9/3N5/9/9/9/R8/7N1/3K5/7C1 w - - 0 1",
        )
        self.assertEqual(
            solution_to_iccs({"from": {"row": 6, "col": 0}, "to": {"row": 6, "col": 5}}),
            "a3f3",
        )


if __name__ == "__main__":
    unittest.main()
