import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from evaluate_pikafish import score_lines


SCRIPT = Path(__file__).with_name("evaluate_pikafish.py")


FAKE_ENGINE = r'''#!/usr/bin/env python3
import os
import sys

count = 0
log = open(os.environ["FAKE_UCI_COMMAND_LOG"], "a", encoding="utf-8")
for line in sys.stdin:
    command = line.strip()
    log.write(command + "\n")
    log.flush()
    if command == "uci":
        print("id name Fake Pikafish 2026-09-06", flush=True)
        print("uciok", flush=True)
    elif command == "isready":
        print("readyok", flush=True)
    elif command.startswith("go nodes"):
        count += 1
        if count == 1:
            print("info depth 4 score cp 50 nodes 100000 pv a3a4", flush=True)
            print("info depth 5 score cp 70 lowerbound nodes 100023 pv c3c4", flush=True)
            print("bestmove c3c4", flush=True)
        elif count == 2:
            print("info depth 4 score cp 50 nodes 80000 pv c3c4", flush=True)
            print("info depth 5 score mate 1 nodes 100000 pv a3a4", flush=True)
            print("bestmove a3a4", flush=True)
        elif count == 3:
            print("info depth 4 score cp 50 nodes 80000 pv g3g4", flush=True)
            print("info depth 5 score cp 45 nodes 100000 pv e3e4", flush=True)
            print("bestmove a3a4", flush=True)
        elif count == 4:
            print("info depth 4 score cp 50 nodes 100000 pv a3a4", flush=True)
            print("bestmove a3a4", flush=True)
        elif count == 5:
            print("info depth 4 score cp -101 nodes 100000 pv c3c4", flush=True)
            print("bestmove c3c4", flush=True)
        else:
            print("info depth 5 score cp 70 lowerbound nodes 100000 pv e3e4", flush=True)
            print("bestmove e3e4", flush=True)
    elif command == "quit":
        break
log.close()
'''


class EvaluatePikafishTests(unittest.TestCase):
    def test_no_move_from_engine_is_a_rejection_when_core_has_legal_moves(self):
        result = score_lines(
            [
                "<< info depth 5 score cp 0 nodes 100000 pv a3a4",
                "<< bestmove 0000",
            ],
            red_to_move=True,
            root_legal_moves=["a3a4"],
        )
        self.assertEqual(result["acceptance_reason"], "engine_rejected_position")

    def test_fixed_node_protocol_logs_exact_scores_and_marks_unresolved_rows(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fake_engine = root / "fake-engine"
            fake_engine.write_text(FAKE_ENGINE, encoding="utf-8")
            fake_engine.chmod(0o755)
            nnue = root / "pikafish.nnue"
            nnue.write_bytes(b"test weights")
            commands = root / "commands.txt"
            candidates = root / "candidates.jsonl"
            scores = root / "scores.jsonl"
            logs = root / "raw"
            first = {
                "opening_id": "opening-a",
                "position_key": "board-a w",
                "fen": "board-a w - - 0 3",
                "red_to_move_after_cutoff": True,
                "validation": {"duplicate": False},
            }
            duplicate = {**first, "opening_id": "opening-a-duplicate", "validation": {"duplicate": True}}
            mate_after_exact = {
                "opening_id": "opening-b",
                "position_key": "board-b w",
                "fen": "board-b w - - 0 3",
                "red_to_move_after_cutoff": True,
                "validation": {"duplicate": False},
            }
            mismatch = {
                "opening_id": "opening-c",
                "position_key": "board-c w",
                "fen": "board-c w - - 0 3",
                "red_to_move_after_cutoff": True,
                "validation": {"duplicate": False},
            }
            exact = {
                "opening_id": "opening-d",
                "position_key": "board-d w",
                "fen": "board-d w - - 0 3",
                "red_to_move_after_cutoff": True,
                "validation": {"duplicate": False},
            }
            outside = {
                "opening_id": "opening-e",
                "position_key": "board-e b",
                "fen": "board-e b - - 0 3",
                "red_to_move_after_cutoff": False,
                "validation": {"duplicate": False},
            }
            unresolved = {
                "opening_id": "opening-f",
                "position_key": "board-f w",
                "fen": "board-f w - - 0 3",
                "red_to_move_after_cutoff": True,
                "validation": {"duplicate": False},
            }
            candidates.write_text(
                "".join(
                    json.dumps(row) + "\n"
                    for row in [first, duplicate, mate_after_exact, mismatch, exact, outside, unresolved]
                ),
                encoding="utf-8",
            )

            env = {**os.environ, "FAKE_UCI_COMMAND_LOG": str(commands)}
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--input",
                    str(candidates),
                    "--output",
                    str(scores),
                    "--log-dir",
                    str(logs),
                    "--engine",
                    str(fake_engine),
                    "--nnue",
                    str(nnue),
                    "--expected-binary-sha256",
                    hashlib.sha256(fake_engine.read_bytes()).hexdigest(),
                    "--expected-nnue-sha256",
                    hashlib.sha256(nnue.read_bytes()).hexdigest(),
                    "--expected-engine-name",
                    "Fake Pikafish 2026-09-06",
                ],
                check=False,
                capture_output=True,
                text=True,
                env=env,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            rows = [json.loads(line) for line in scores.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(rows), 6)
            self.assertEqual(rows[0]["validation"]["acceptance_reason"], "unknown_final_bound")
            self.assertIsNone(rows[0]["validation"]["balanced"])
            self.assertIsNone(rows[0]["reference_balance"]["score_cp_stm"])
            self.assertEqual(rows[0]["reference_balance"]["last_exact_score"]["score"], 50)
            self.assertEqual(rows[1]["validation"]["acceptance_reason"], "unknown_final_mate_score")
            self.assertIsNone(rows[1]["validation"]["balanced"])
            self.assertEqual(rows[2]["validation"]["acceptance_reason"], "unknown_bestmove_pv_mismatch")
            self.assertIsNone(rows[2]["validation"]["balanced"])
            self.assertEqual(rows[3]["reference_balance"]["score_cp_stm"], 50)
            self.assertEqual(rows[3]["reference_balance"]["score_cp_red"], 50)
            self.assertTrue(rows[3]["validation"]["balanced"])
            self.assertEqual(rows[4]["reference_balance"]["score_cp_red"], 101)
            self.assertFalse(rows[4]["validation"]["balanced"])
            self.assertEqual(rows[5]["validation"]["acceptance_reason"], "unknown_no_exact_score")
            for row in rows:
                self.assertTrue(Path(row["reference_balance"]["raw_log_path"]).is_file())
                self.assertEqual(len(row["reference_balance"]["raw_log_sha256"]), 64)

            commands_text = commands.read_text(encoding="utf-8")
            self.assertEqual(commands_text.count("go nodes 100000"), 6)
            self.assertEqual(commands_text.count("ucinewgame"), 6)
            self.assertEqual(commands_text.count("setoption name Clear Hash"), 6)
            self.assertEqual(commands_text.count("setoption name Threads value 1"), 1)
            self.assertEqual(commands_text.count("setoption name Hash value 64"), 1)

    def test_illegal_bestmove_is_preserved_and_stops_the_batch(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fake_engine = root / "fake-engine"
            fake_engine.write_text(
                """#!/usr/bin/env python3
import sys
for line in sys.stdin:
    command = line.strip()
    if command == 'uci':
        print('id name Fake Pikafish 2026-09-06', flush=True)
        print('uciok', flush=True)
    elif command == 'isready':
        print('readyok', flush=True)
    elif command.startswith('go nodes'):
        print('info depth 5 score cp 50 nodes 100000 pv e3e4', flush=True)
        print('bestmove e3e4', flush=True)
    elif command == 'quit':
        break
""",
                encoding="utf-8",
            )
            fake_engine.chmod(0o755)
            nnue = root / "pikafish.nnue"
            nnue.write_bytes(b"test weights")
            candidates = root / "candidates.jsonl"
            scores = root / "scores.jsonl"
            logs = root / "raw"
            row = {
                "opening_id": "opening-illegal-bestmove",
                "position_key": "board-illegal w",
                "fen": "board-illegal w - - 0 3",
                "red_to_move_after_cutoff": True,
                "root_legal_moves": ["a3a4"],
                "validation": {"duplicate": False},
            }
            candidates.write_text(json.dumps(row) + "\n", encoding="utf-8")
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--input", str(candidates),
                    "--output", str(scores),
                    "--log-dir", str(logs),
                    "--engine", str(fake_engine),
                    "--nnue", str(nnue),
                    "--expected-binary-sha256", hashlib.sha256(fake_engine.read_bytes()).hexdigest(),
                    "--expected-nnue-sha256", hashlib.sha256(nnue.read_bytes()).hexdigest(),
                    "--expected-engine-name", "Fake Pikafish 2026-09-06",
                ],
                check=False,
                capture_output=True,
                text=True,
                env={**os.environ, "FAKE_UCI_COMMAND_LOG": str(root / "commands.txt")},
            )
            self.assertNotEqual(result.returncode, 0)
            stored = json.loads(scores.read_text(encoding="utf-8").splitlines()[0])
            self.assertEqual(stored["validation"]["acceptance_reason"], "engine_rejected_position")
            self.assertIsNone(stored["validation"]["balanced"])
            raw = Path(stored["reference_balance"]["raw_log_path"])
            self.assertTrue(raw.is_file())
            self.assertIn("bestmove e3e4", raw.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
