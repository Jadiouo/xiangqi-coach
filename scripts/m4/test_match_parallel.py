import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from match import verify_batch_games


SCRIPT = Path(__file__).with_name("match.py")


def write_deterministic_uci(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "#!/usr/bin/env python3\n"
        "import os, sys\n"
        "moves = []\n"
        "for raw in sys.stdin:\n"
        " line = raw.strip()\n"
        " if line == 'uci':\n"
        "  print('option name Strategy type combo default search var search var random var greedy', flush=True)\n"
        "  print('option name RandomSeed type spin default 1 min 0 max 18446744073709551615', flush=True)\n"
        "  print('uciok', flush=True)\n"
        " elif line == 'isready': print('readyok', flush=True)\n"
        " elif line.startswith('position startpos moves '):\n"
        "  moves = line.removeprefix('position startpos moves ').split()\n"
        " elif line.startswith('go '):\n"
        "  if os.environ.get('FAKE_BAD_TERMINAL') == '1':\n"
        "   print('info string outcome winner', flush=True)\n"
        "   print('bestmove 0000', flush=True)\n"
        "  elif len(moves) >= 6:\n"
        "   print('info string outcome draw', flush=True)\n"
        "   print('bestmove 0000', flush=True)\n"
        "  else:\n"
        "   print('bestmove ' + ('a3a4' if len(moves) % 2 == 0 else 'a6a5'), flush=True)\n"
        " elif line == 'quit': break\n",
        encoding="utf-8",
    )
    path.chmod(0o755)
    return path


def run_small_batch(root: Path, *, workers: int | None, bad_terminal: bool = False):
    root.mkdir(parents=True, exist_ok=True)
    engine = write_deterministic_uci(root / "fake-uci.py")
    openings = root / "openings.tsv"
    openings.write_text(
        "opening_id\tsource_ref\ticcs_prefix\n"
        "opening-a\tsource-a\th2e2 h9g7 h0g2 i9h9\n"
        "opening-b\tsource-b\th2e2 h9g7 h0g2 i9h9\n",
        encoding="utf-8",
    )
    output = root / ("workers-1" if workers == 1 else "workers-4" if workers == 4 else "default")
    command = [
        sys.executable, str(SCRIPT), "--engine-a", f"{sys.executable} {engine}",
        "--engine-b", f"{sys.executable} {engine}", "--openings", str(openings),
        "--nodes", "100", "--games", "4", "--global-round-start", "3",
        "--global-round-count", "1", "--seed", "77", "--strategy-a", "search",
        "--strategy-b", "random", "--output", str(output),
    ]
    if workers is not None:
        command.extend(["--workers", str(workers)])
    environment = os.environ.copy()
    if bad_terminal:
        environment["FAKE_BAD_TERMINAL"] = "1"
    completed = subprocess.run(command, check=False, capture_output=True, text=True, env=environment)
    games_path = output / "games.jsonl"
    games = [json.loads(line) for line in games_path.read_text(encoding="utf-8").splitlines()] if games_path.exists() else []
    summary = json.loads((output / "summary.json").read_text(encoding="utf-8")) if (output / "summary.json").exists() else None
    manifest_path = output / "run-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else None
    logs = {
        str(path.relative_to(output)): path.read_text(encoding="utf-8")
        for path in output.rglob("*.log")
    } if output.exists() else {}
    return completed, output, games, summary, manifest, logs


class ParallelMatchTests(unittest.TestCase):
    def test_batch_verifier_rejects_wdl_winner_row_marked_unfinished(self):
        with tempfile.TemporaryDirectory() as directory:
            _, _, games, _, _, _ = run_small_batch(Path(directory), workers=4)
        games[0]["unfinished_reason"] = "max_ply"
        opening = {game["opening_id"]: {"source": game["source"], "prefix": game["prefix"]}
                   for game in games}
        checked = verify_batch_games(
            games, list(opening), [games[0]["global_round"]], 100,
            games[0]["master_seed"], opening_data=opening, max_ply=4096,
        )
        self.assertFalse(checked["complete"])
        self.assertIn("unfinished_reason", " ".join(checked["errors"]))

    def test_serial_default_and_four_workers_preserve_each_game_identity_and_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            serial, _, serial_games, serial_summary, serial_manifest, serial_logs = run_small_batch(root / "serial", workers=None)
            parallel, _, parallel_games, parallel_summary, manifest, parallel_logs = run_small_batch(root / "parallel", workers=4)

        self.assertEqual(serial.returncode, 0, serial.stderr)
        self.assertEqual(parallel.returncode, 0, parallel.stderr)
        self.assertTrue(serial_summary["complete"])
        self.assertTrue(parallel_summary["complete"])
        self.assertEqual(serial_manifest["workers"], 1)
        self.assertEqual(len(serial_games), 4)
        self.assertEqual(len(parallel_games), 4)
        self.assertEqual(len({row["game_id"] for row in parallel_games}), 4)
        fields = ("game_id", "global_round", "opening_id", "a_is_red", "seed",
                  "decision_seeds", "moves", "result_for_a", "terminal_outcome")
        serial_by_id = {row["game_id"]: tuple(row[field] for field in fields) for row in serial_games}
        parallel_by_id = {row["game_id"]: tuple(row[field] for field in fields) for row in parallel_games}
        self.assertEqual(parallel_by_id, serial_by_id)
        self.assertEqual(len({seed for row in parallel_games for seed in row["decision_seeds"]}), 12)
        self.assertEqual([row["a_is_red"] for row in serial_games], [True, False, True, False])

        self.assertEqual(manifest["workers"], 4)
        self.assertEqual(
            manifest["runner_source_sha256"],
            __import__("hashlib").sha256(SCRIPT.read_bytes()).hexdigest(),
        )
        self.assertRegex(manifest["runner_git_head"], r"^[0-9a-f]{40}$")
        for worker in range(1, 5):
            for actor in ("engine-a", "engine-b"):
                trace = f"workers/worker-{worker:02d}/{actor}.log"
                self.assertIn(trace, parallel_logs)
                contents = parallel_logs[trace]
                self.assertIn("context: game_id=round-03/", contents)
                self.assertIn(f"actor={'A' if actor == 'engine-a' else 'B'}", contents)
        self.assertIn("engine-a.log", serial_logs)
        self.assertIn("engine-b.log", serial_logs)

    def test_bad_terminal_from_workers_remains_unfinished_and_cannot_pass_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            completed, _, games, summary, _, _ = run_small_batch(Path(directory), workers=4, bad_terminal=True)
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(len(games), 4)
        self.assertTrue(all(game["result_for_a"] == "unfinished" for game in games))
        self.assertTrue(all(game["protocol_error"] for game in games))
        self.assertFalse(summary["complete"])
        self.assertFalse(summary["formal_decision_ready"])
        self.assertFalse(summary["baseline_gate"]["eligible_for_formal_gate"])
        self.assertFalse(summary["baseline_gate"]["passed"])

    def test_workers_must_be_positive_and_not_exceed_requested_games(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = write_deterministic_uci(root / "fake-uci.py")
            openings = root / "openings.tsv"
            openings.write_text(
                "opening_id\tsource_ref\ticcs_prefix\n"
                "opening-a\tsource-a\th2e2 h9g7 h0g2 i9h9\n",
                encoding="utf-8",
            )
            for workers in ("0", "3"):
                output = root / f"invalid-{workers}"
                result = subprocess.run([
                    sys.executable, str(SCRIPT), "--engine-a", f"{sys.executable} {engine}",
                    "--engine-b", f"{sys.executable} {engine}", "--openings", str(openings),
                    "--nodes", "100", "--games", "2", "--workers", workers, "--output", str(output),
                ], check=False, capture_output=True, text=True)
                self.assertEqual(result.returncode, 2)
                self.assertIn("workers", result.stderr)
                self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
