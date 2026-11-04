import unittest

from select_puzzle_manifest_v2 import build_manifest


def rows():
    candidates = []
    proofs = []
    oracle = []
    for depth, identifier in ((1, "mate1-02"), (2, "mate2-01"), (3, "mate3-01")):
        candidates.append({
            "id": identifier, "fen": f"fen-{identifier}", "mate_in_attacker_moves": depth,
            "claimed_first_move": "a0a1", "source_url": "https://example.test/puzzle",
            "source_page_sha256": f"sha-{depth}",
        })
        proofs.append({"id": identifier, "proof_status": "complete", "complete": True,
                       "unique_claim_matches_source": True, "unique": "a0a1"})
        oracle.append({
            "id": identifier, "run_status": "complete", "perft_only": True,
            "claimed_first_move_legal": True,
            "perft": {"1": {"nodes": 1, "root_moves": ["a0a1"]},
                      "2": {"nodes": 2}, "3": {"nodes": 3}},
        })
    return candidates, proofs, oracle


class PuzzleManifestV2Tests(unittest.TestCase):
    def test_selects_only_complete_source_unique_and_external_perft_accepted_rows(self):
        candidates, proofs, oracle = rows()
        oracle[1] = {"id": "mate2-01", "run_status": "protocol_error"}
        manifest = build_manifest(candidates, proofs, oracle, 1, "c", "p", "o")
        self.assertEqual(manifest["status"], "insufficient-external-compatible-candidates")
        self.assertEqual([row["id"] for row in manifest["selected"]], ["mate1-02", "mate3-01"])
        self.assertEqual(manifest["external_compatible_counts_by_depth"], {"1": 1, "2": 0, "3": 1})

    def test_requires_oracle_coverage_of_the_entire_source_unique_pool(self):
        candidates, proofs, oracle = rows()
        with self.assertRaisesRegex(ValueError, "oracle and source-unique IDs must match exactly"):
            build_manifest(candidates, proofs, oracle[:-1], 1, "c", "p", "o")


if __name__ == "__main__":
    unittest.main()
