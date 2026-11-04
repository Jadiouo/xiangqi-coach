import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("pikafish_reference.py")


FAKE_ENGINE = r'''#!/usr/bin/env python3
import sys
for raw in sys.stdin:
    line = raw.strip()
    if line == 'uci':
        print('id name Fake Reference 1', flush=True)
        print('id author fixture', flush=True)
        print('option name Threads type spin default 1 min 1 max 4', flush=True)
        print('option name MultiPV type spin default 1 min 1 max 8', flush=True)
        print('uciok', flush=True)
    elif line == 'isready':
        print('readyok', flush=True)
    elif line.startswith('go perft '):
        print('a3f3: 1', flush=True)
        print('a3a9: 1', flush=True)
        print('Nodes searched: 2', flush=True)
    elif line.startswith('go '):
        move = line.split('searchmoves ')[1].split()[0] if 'searchmoves ' in line else 'a3f3'
        print(f'info depth 2 score mate 1 nodes 10 pv {move}', flush=True)
        print(f'bestmove {move}', flush=True)
    elif line == 'quit':
        break
'''


class ExternalUciReferenceTests(unittest.TestCase):
    def test_captures_threads_version_perft_multipv_and_root_searchmoves(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = root / "fake-engine"
            engine.write_text(FAKE_ENGINE, encoding="utf-8")
            engine.chmod(0o755)
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"selected": [{
                "id": "fake-01", "fen": "4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1",
                "mate_in_attacker_moves": 1, "claimed_first_move": "a3f3",
            }]}), encoding="utf-8")
            output = root / "reference"
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--engine", str(engine), "--manifest", str(manifest),
                 "--output", str(output), "--nodes", "100", "--depth", "2", "--timeout-seconds", "3"],
                check=True, capture_output=True, text=True,
            )
            record = json.loads((output / "results.jsonl").read_text().splitlines()[0])
            raw = json.loads((output / "raw" / "fake-01.json").read_text())
            self.assertEqual(record["run_status"], "complete")
            self.assertEqual(record["depth_search"]["bestmove"], "a3f3")
            self.assertEqual(record["perft"]["1"]["nodes"], 2)
            self.assertEqual(record["perft"]["1"]["root_moves"], ["a3a9", "a3f3"])
            self.assertEqual(sorted(record["root_searches"]), ["a3a9", "a3f3"])
            self.assertEqual(raw["stdin"], record["raw_io"]["stdin"])
            metadata = json.loads((output / "engine.json").read_text())
            self.assertEqual(metadata["engine_name"], "Fake Reference 1")
            self.assertEqual(metadata["settings"]["threads"], 1)
            self.assertTrue(any(command == "setoption name Threads value 1" for command in metadata["raw_io"]["stdin"]))
            self.assertIn('"complete": 1', result.stdout)

    def test_perft_only_screen_checks_source_compatibility_without_search(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = root / "fake-engine"
            engine.write_text(FAKE_ENGINE, encoding="utf-8")
            engine.chmod(0o755)
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"selected": [{
                "id": "screen-01", "fen": "4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1",
                "mate_in_attacker_moves": 1, "claimed_first_move": "a3f3",
            }]}), encoding="utf-8")
            output = root / "screen"
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--engine", str(engine), "--manifest", str(manifest),
                 "--output", str(output), "--perft-only", "--timeout-seconds", "3"],
                check=True, capture_output=True, text=True,
            )
            record = json.loads((output / "results.jsonl").read_text().splitlines()[0])
            self.assertTrue(record["perft_only"])
            self.assertTrue(record["claimed_first_move_legal"])
            self.assertEqual(sorted(record["perft"]["1"]["root_moves"]), ["a3a9", "a3f3"])
            self.assertFalse(any(command.startswith("go depth ") or command.startswith("go nodes ")
                                 for command in record["raw_io"]["stdin"]))
            self.assertIn('"complete": 1', result.stdout)

    def test_perft_only_records_unsupported_position_and_continues_all_ids(self):
        rejecting_engine = FAKE_ENGINE.replace(
            "for raw in sys.stdin:\n    line = raw.strip()",
            "for raw in sys.stdin:\n    line = raw.strip()\n    if line.startswith('position fen bad'):\n        print('info string CRITICAL ERROR: unsupported position', flush=True)\n        sys.exit(0)",
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = root / "fake-engine"
            engine.write_text(rejecting_engine, encoding="utf-8")
            engine.chmod(0o755)
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"selected": [
                {"id": "reject-01", "fen": "bad", "mate_in_attacker_moves": 1, "claimed_first_move": "a3f3"},
                {"id": "accept-02", "fen": "valid", "mate_in_attacker_moves": 2, "claimed_first_move": "a3f3"},
            ]}), encoding="utf-8")
            output = root / "screen"
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--engine", str(engine), "--manifest", str(manifest),
                 "--output", str(output), "--perft-only", "--timeout-seconds", "3"],
                capture_output=True, text=True,
            )
            records = [json.loads(line) for line in (output / "results.jsonl").read_text().splitlines()]
            self.assertEqual(result.returncode, 1)
            self.assertEqual([row["id"] for row in records], ["reject-01", "accept-02"])
            self.assertEqual([row["run_status"] for row in records], ["protocol_error", "complete"])
            self.assertIn("unsupported position", "\n".join(records[0]["raw_io"]["stdout"]))
            self.assertTrue(records[1]["perft_only"])
            self.assertEqual(json.loads((output / "summary.json").read_text())["statuses"],
                             {"protocol_error": 1, "complete": 1})

    def test_timeout_is_recorded_and_returns_failure(self):
        timeout_engine = FAKE_ENGINE.replace(
            "elif line.startswith('go '):\n        move =",
            "elif line.startswith('go '):\n        import time; time.sleep(1)\n        move =",
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = root / "slow-engine"
            engine.write_text(timeout_engine, encoding="utf-8")
            engine.chmod(0o755)
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"selected": [{
                "id": "slow-01", "fen": "4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1",
                "mate_in_attacker_moves": 1, "claimed_first_move": "a3f3",
            }]}), encoding="utf-8")
            output = root / "reference"
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--engine", str(engine), "--manifest", str(manifest),
                 "--output", str(output), "--timeout-seconds", "0.1"],
                capture_output=True, text=True,
            )
            record = json.loads((output / "results.jsonl").read_text().splitlines()[0])
            raw = json.loads((output / "raw" / "slow-01.json").read_text())
            self.assertEqual(result.returncode, 1)
            self.assertEqual(record["run_status"], "timeout")
            self.assertTrue(any(command == "go depth 6" for command in raw["stdin"]))
            self.assertEqual(json.loads((output / "summary.json").read_text())["statuses"], {"timeout": 1})


if __name__ == "__main__":
    unittest.main()
