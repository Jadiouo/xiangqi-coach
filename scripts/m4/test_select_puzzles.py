import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("select_puzzles.py")


class PuzzleManifestTests(unittest.TestCase):
    def test_selects_lexicographically_first_complete_unique_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidates = [
                {"id": "mate1-b", "mate_in_attacker_moves": 1, "fen": "fen-b", "claimed_first_move": "b2b3", "source_url": "url", "source_page_sha256": "abc"},
                {"id": "mate1-a", "mate_in_attacker_moves": 1, "fen": "fen-a", "claimed_first_move": "a2a3", "source_url": "url", "source_page_sha256": "abc"},
                {"id": "mate1-c", "mate_in_attacker_moves": 1, "fen": "fen-c", "claimed_first_move": "c2c3", "source_url": "url", "source_page_sha256": "abc"},
            ]
            proof_rows = [
                {"id": "mate1-b", "proof_status": "complete", "unique_claim_matches_source": True},
                {"id": "mate1-a", "proof_status": "complete", "unique_claim_matches_source": True},
                {"id": "mate1-c", "proof_status": "incomplete", "unique_claim_matches_source": False},
            ]
            source = root / "candidates.jsonl"
            proof = root / "proofs.jsonl"
            output = root / "manifest.json"
            source.write_text("".join(json.dumps(row) + "\n" for row in candidates), encoding="utf-8")
            proof.write_text("".join(json.dumps(row) + "\n" for row in proof_rows), encoding="utf-8")
            subprocess.run(
                [sys.executable, str(SCRIPT), "--candidates", str(source), "--proofs", str(proof),
                 "--per-depth", "1", "--output", str(output)],
                check=True,
            )
            manifest = json.loads(output.read_text())
            self.assertEqual([row["id"] for row in manifest["selected"]], ["mate1-a"])
            self.assertEqual(manifest["status"], "candidate-only-pending-external-oracle")


if __name__ == "__main__":
    unittest.main()
