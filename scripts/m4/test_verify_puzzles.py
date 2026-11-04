import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("verify_puzzles.py")


class PuzzleProofRunnerTests(unittest.TestCase):
    def test_records_complete_unique_and_incomplete_proofs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / "fake_proof.py"
            fake.write_text(
                "import sys\n"
                "if sys.argv[1].startswith('bad'):\n"
                " print('invalid FEN: bad input', file=sys.stderr); sys.exit(2)\n"
                "if sys.argv[2]=='1':\n"
                " print('complete\\ttrue\\nnodes\\t4\\nroot_branches_checked\\t2\\nmate\\ta3f3\\t1\\nunique\\ta3f3')\n"
                "else:\n"
                " print('complete\\tfalse\\nnodes\\t8\\nroot_branches_checked\\t1\\nunique\\t-'); sys.exit(3)\n",
                encoding="utf-8",
            )
            source = root / "candidates.jsonl"
            candidates = [
                {"id": "unique", "fen": "good fen", "mate_in_attacker_moves": 1, "claimed_first_move": "a3f3"},
                {"id": "capped", "fen": "good fen", "mate_in_attacker_moves": 2, "claimed_first_move": "a3f3"},
            ]
            source.write_text("".join(json.dumps(row) + "\n" for row in candidates), encoding="utf-8")
            output = root / "proofs.jsonl"
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--input", str(source), "--binary", f"{sys.executable} {fake}",
                 "--node-limit", "100", "--output", str(output)],
                check=True,
                capture_output=True,
                text=True,
            )
            rows = [json.loads(line) for line in output.read_text().splitlines()]
            self.assertEqual([row["proof_status"] for row in rows], ["complete", "incomplete"])
            self.assertTrue(rows[0]["unique_claim_matches_source"])
            self.assertFalse(rows[1]["unique_claim_matches_source"])
            self.assertIn('"count": 2', result.stdout)

    def test_resume_reuses_only_matching_checkpoint_and_rejects_changed_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / "fake_proof.py"
            calls = root / "calls.txt"
            fake.write_text(
                "import pathlib,sys\n"
                f"pathlib.Path({str(calls)!r}).open('a').write(sys.argv[1]+'\\n')\n"
                "print('complete\\ttrue\\nnodes\\t4\\nroot_branches_checked\\t2\\nmate\\ta3f3\\t1\\nunique\\ta3f3')\n",
                encoding="utf-8",
            )
            source = root / "candidates.jsonl"
            candidates = [
                {"id": f"candidate-{index}", "fen": f"fen-{index}",
                 "mate_in_attacker_moves": 1, "claimed_first_move": "a3f3"}
                for index in range(2)
            ]
            source.write_text("".join(json.dumps(row) + "\n" for row in candidates), encoding="utf-8")
            output = root / "proofs.jsonl"
            command = [sys.executable, str(SCRIPT), "--input", str(source), "--binary", f"{sys.executable} {fake}",
                       "--node-limit", "100", "--timeout-seconds", "1", "--output", str(output)]
            subprocess.run(command, check=True, capture_output=True, text=True)
            checkpoint = output.with_suffix(output.suffix + ".meta.json")
            self.assertTrue(checkpoint.exists())
            self.assertEqual(len(calls.read_text().splitlines()), 2)

            subprocess.run(command + ["--resume"], check=True, capture_output=True, text=True)
            self.assertEqual(len(calls.read_text().splitlines()), 2)
            self.assertEqual(len(output.read_text().splitlines()), 2)

            source.write_text(source.read_text() + "\n", encoding="utf-8")
            rejected = subprocess.run(command + ["--resume"], capture_output=True, text=True)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("checkpoint does not match", rejected.stderr)

    def test_resume_discards_only_an_unterminated_partial_row_and_checks_row_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / "fake_proof.py"
            fake.write_text(
                "print('complete\\ttrue\\nnodes\\t4\\nroot_branches_checked\\t2\\nmate\\ta3f3\\t1\\nunique\\ta3f3')\n",
                encoding="utf-8",
            )
            source = root / "candidates.jsonl"
            candidates = [
                {"id": f"candidate-{index}", "fen": f"fen-{index}",
                 "mate_in_attacker_moves": 1, "claimed_first_move": "a3f3"}
                for index in range(2)
            ]
            source.write_text("".join(json.dumps(row) + "\n" for row in candidates), encoding="utf-8")
            output = root / "proofs.jsonl"
            command = [sys.executable, str(SCRIPT), "--input", str(source), "--binary", f"{sys.executable} {fake}",
                       "--node-limit", "100", "--timeout-seconds", "1", "--output", str(output)]
            subprocess.run(command, check=True, capture_output=True, text=True)

            output.write_bytes(output.read_bytes() + b'{"id":"partial')
            resumed = subprocess.run(command + ["--resume"], capture_output=True, text=True)
            self.assertEqual(resumed.returncode, 0, resumed.stderr)
            self.assertEqual(len(output.read_text().splitlines()), 2)

            rows = [json.loads(line) for line in output.read_text().splitlines()]
            rows[0]["fen"] = "tampered fen"
            output.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            tampered = subprocess.run(command + ["--resume"], capture_output=True, text=True)
            self.assertNotEqual(tampered.returncode, 0)
            self.assertIn("checkpoint row does not match candidate", tampered.stderr)


if __name__ == "__main__":
    unittest.main()
