import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from aggregate_matches import aggregate_batch_directories
from match import stable_seed


ROOT = Path(__file__).parents[2]
OPENINGS = ROOT / "docs/research/m4-openings/selected-50.tsv"
PROTOCOL = ROOT / "docs/research/m4-openings/opening-selection-protocol.json"


def _rewrite_json(path, value):
    path.write_text(json.dumps(value))


def _rewrite_manifest(batch, manifest):
    manifest.pop("config_sha256", None)
    manifest["config_sha256"] = hashlib.sha256(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    manifest_path = batch / "run-manifest.json"
    manifest_path.write_text(json.dumps(manifest))
    summary_path = batch / "summary.json"
    if summary_path.exists():
        summary = json.loads(summary_path.read_text())
        summary["run_manifest_sha256"] = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        summary_path.write_text(json.dumps(summary))


def make_batches(root, *, damaged=None, missing_terminal_raw=False,
                strategy_a="search", strategy_b="random", options_a=None, options_b=None,
                corrupt_terminal_result=False, experiment=None, engine_b_hash=None,
                master_seed=77, look=1, baseline_profile=None, workers=4,
                engine_timeout_seconds=30.0):
    rows = OPENINGS.read_text().splitlines()[1:]
    opening_rows = [row.split("\t") for row in rows]
    openings = [row[0] for row in opening_rows]
    executable = {"path": sys.executable, "sha256": "fake-hash-for-unit-test"}
    for batch_number in range(5):
        start = batch_number * 2 + 1
        directory = root / f"batch-{batch_number + 1}"
        directory.mkdir()
        manifest = {
            "schema_version": "m4-match-batch-v1",
            "experiment": experiment if experiment is not None else (
                "check-extensions" if strategy_a == "search" and strategy_b == "search" else None
            ),
            "baseline_profile": baseline_profile,
            "global_round_start": start,
            "global_round_count": 2,
            "global_rounds": [start, start + 1],
            "requested_games": 200,
            "master_seed": master_seed,
            "nodes_per_move": 10000,
            "max_ply": 4096,
            "look": look,
            "workers": workers,
            "engine_timeout_seconds": engine_timeout_seconds,
            "strategy_a": strategy_a,
            "strategy_b": strategy_b,
            "candidate_side": "A",
            "baseline_side": "B",
            "engine_a_options": options_a or {},
            "engine_b_options": options_b or {},
            "openings_sha256": __import__("hashlib").sha256(OPENINGS.read_bytes()).hexdigest(),
            "selection_protocol_sha256": __import__("hashlib").sha256(PROTOCOL.read_bytes()).hexdigest(),
            "selection": {"frozen_protocol_verified": True, "full_selected_sample": True},
            "engine_a_executable": executable,
            "engine_b_executable": {**executable, "sha256": engine_b_hash} if engine_b_hash else executable,
            "engine_a_command": sys.executable,
            "engine_b_command": sys.executable,
        }
        if baseline_profile in ("final-ra-ce", "final-ra-ce-kh"):
            runner = ROOT / "scripts/m4/match.py"
            manifest["runner_git_head"] = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
            ).strip()
            manifest["runner_source_sha256"] = hashlib.sha256(runner.read_bytes()).hexdigest()
        manifest["config_sha256"] = hashlib.sha256(
            json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        manifest_path = directory / "run-manifest.json"
        manifest_path.write_text(json.dumps(manifest))
        games = []
        for global_round in (start, start + 1):
            for opening_id, source, prefix_text in opening_rows:
                for a_is_red in (True, False):
                    game_id = f"round-{global_round:02d}/{opening_id}/A-{'red' if a_is_red else 'black'}"
                    outcome = "red" if a_is_red else "black"
                    games.append({"game_id": game_id, "global_round": global_round,
                                  "opening_id": opening_id, "source": source, "a_is_red": a_is_red,
                                  "nodes": 10000, "seed": stable_seed(master_seed, game_id), "master_seed": master_seed,
                                  "prefix": prefix_text.split(), "moves": prefix_text.split(),
                                  "decision_seeds": [stable_seed(master_seed, game_id, 0)], "result_for_a": "win",
                                  "terminal_outcome": outcome, "winner": "A",
                                  "terminal_raw": [f"info string outcome {outcome}", "bestmove 0000"]})
        if missing_terminal_raw and batch_number == 0:
            games[0]["terminal_raw"] = []
        if corrupt_terminal_result and batch_number == 0:
            games[0]["result_for_a"] = "loss"
        if damaged == batch_number:
            games.pop()
        (directory / "games.jsonl").write_text("".join(json.dumps(game) + "\n" for game in games))
        if baseline_profile in ("final-ra-ce", "final-ra-ce-kh"):
            totals = {result: sum(game["result_for_a"] == result for game in games)
                      for result in ("win", "draw", "loss")}
            (directory / "summary.json").write_text(json.dumps({
                "baseline_profile": baseline_profile, "complete": len(games) == 200,
                "requested_games": 200, "games_written": len(games),
                "finished_games": len(games), "unfinished_games": 0, "wdl_for_a": totals,
                "run_manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
            }))
            launcher = root / f"launcher-batch-{batch_number + 1}"
            launcher.mkdir()
            final_options = {"CheckExtensions": "true", "RootAlpha": "true"}
            if baseline_profile == "final-ra-ce-kh":
                final_options["KillerHistoryOrdering"] = "true"
            command = [
                sys.executable, str(runner.resolve()), "--engine-a", manifest["engine_a_command"],
                "--engine-b", manifest["engine_b_command"], "--openings", str(OPENINGS.resolve()),
                "--nodes", "10000", "--games", "200", "--global-round-start", str(start),
                "--global-round-count", "2", "--max-ply", "4096", "--engine-timeout", "30",
                "--workers", "4", "--strategy-a", "search", "--strategy-b", strategy_b,
                "--engine-a-options", json.dumps(final_options, separators=(",", ":")),
                "--engine-b-options", json.dumps(final_options, separators=(",", ":")),
                "--baseline-profile", baseline_profile, "--seed", "1", "--look", "1",
                "--selection-protocol", str(PROTOCOL.resolve()), "--output", str(directory.resolve()),
            ]
            (launcher / "command.json").write_text(json.dumps({
                "schema_version": "m4-baseline-command-v1", "cwd": str(ROOT.resolve()),
                "command": command, "engine_sha256": manifest["engine_a_executable"]["sha256"],
                "output": str(directory.resolve()), "runner_git_head": manifest["runner_git_head"],
                "runner_source_sha256": manifest["runner_source_sha256"],
                "openings_sha256": manifest["openings_sha256"],
                "selection_protocol_sha256": manifest["selection_protocol_sha256"],
            }))
            for filename in ("stdout.log", "stderr.log"):
                (launcher / filename).write_text("")
            (launcher / "exit-status.json").write_text(json.dumps({"exit_code": 0, "finished_unix": 1.0}))
            (launcher / "launch.json").write_text(json.dumps({
                "schema_version": "m4-baseline-launch-v1", "launcher_pid": 1, "pgid": 1, "sid": 1,
                "started_unix": 1.0, "cwd": str(ROOT.resolve()),
                "runner_head": manifest["runner_git_head"], "runner_source_path": str(runner.resolve()),
                "runner_source_sha256": manifest["runner_source_sha256"],
                "command": str((launcher / "command.json").resolve()),
                "stdout": str((launcher / "stdout.log").resolve()),
                "stderr": str((launcher / "stderr.log").resolve()),
                "exit_status": str((launcher / "exit-status.json").resolve()),
                "output": str(directory.resolve()), "engine_sha256": manifest["engine_a_executable"]["sha256"],
                "runner_pid": 2,
            }))


class AggregateMatchesTests(unittest.TestCase):
    def test_final_baseline_profile_accepts_only_locked_ra_ce_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            final_options = {"CheckExtensions": "true", "RootAlpha": "true"}
            make_batches(root, master_seed=1, baseline_profile="final-ra-ce",
                         options_a=final_options, options_b=final_options)
            summary = aggregate_batch_directories(
                [root / f"batch-{index}" for index in range(1, 6)], OPENINGS, PROTOCOL,
                master_seed=1, strategy_a="search", strategy_b="random",
                baseline_profile="final-ra-ce",
                batch_launchers=[root / f"launcher-batch-{index}" for index in range(1, 6)],
            )
        self.assertTrue(summary["baseline_gate"]["passed"])
        self.assertEqual(summary["batch_validation"]["baseline_profile"], "final-ra-ce")

    def test_final_kh_baseline_requires_exact_options_and_launcher_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            kh_options = {"CheckExtensions": "true", "RootAlpha": "true", "KillerHistoryOrdering": "true"}
            make_batches(root, master_seed=1, baseline_profile="final-ra-ce-kh",
                         options_a=kh_options, options_b=kh_options)
            summary = aggregate_batch_directories(
                [root / f"batch-{index}" for index in range(1, 6)], OPENINGS, PROTOCOL,
                master_seed=1, strategy_a="search", strategy_b="random",
                baseline_profile="final-ra-ce-kh",
                batch_launchers=[root / f"launcher-batch-{index}" for index in range(1, 6)],
            )
            self.assertTrue(summary["baseline_gate"]["passed"])
            self.assertEqual(summary["batch_validation"]["baseline_profile"], "final-ra-ce-kh")
            manifest_path = root / "batch-1/run-manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["engine_a_options"] = {"CheckExtensions": "true", "RootAlpha": "true"}
            _rewrite_manifest(root / "batch-1", manifest)
            with self.assertRaisesRegex(ValueError, "invalid explicit options"):
                aggregate_batch_directories(
                    [root / f"batch-{index}" for index in range(1, 6)], OPENINGS, PROTOCOL,
                    master_seed=1, strategy_a="search", strategy_b="random",
                    baseline_profile="final-ra-ce-kh",
                    batch_launchers=[root / f"launcher-batch-{index}" for index in range(1, 6)],
                )

    def test_final_baseline_profile_rejects_wrong_options_and_runtime_settings(self):
        mutations = [
            ({"engine_a_options": {"CheckExtensions": "true", "RootAlpha": "false"}}, "options"),
            ({"workers": 1}, "workers=4"),
            ({"engine_timeout_seconds": 29.0}, "engine_timeout_seconds=30"),
            ({"max_ply": 200}, "max_ply=4096"),
            ({"master_seed": 2}, "master_seed does not match"),
        ]
        for changes, message in mutations:
            with self.subTest(changes=changes), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                options = {"CheckExtensions": "true", "RootAlpha": "true"}
                make_batches(root, master_seed=1, baseline_profile="final-ra-ce",
                             options_a=options, options_b=options)
                manifest_path = root / "batch-1" / "run-manifest.json"
                manifest = json.loads(manifest_path.read_text())
                manifest.update(changes)
                manifest.pop("config_sha256")
                manifest["config_sha256"] = hashlib.sha256(
                    json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
                ).hexdigest()
                manifest_path.write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, message):
                    aggregate_batch_directories(
                        [root / f"batch-{index}" for index in range(1, 6)], OPENINGS, PROTOCOL,
                        master_seed=1, strategy_a="search", strategy_b="random",
                        baseline_profile="final-ra-ce",
                        batch_launchers=[root / f"launcher-batch-{index}" for index in range(1, 6)],
                    )

    def test_final_baseline_profile_rejects_different_binary_or_unrequested_profile(self):
        options = {"CheckExtensions": "true", "RootAlpha": "true"}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_batches(root, master_seed=1, baseline_profile="final-ra-ce",
                         options_a=options, options_b=options,
                         engine_b_hash="different-final-binary")
            with self.assertRaisesRegex(ValueError, "same immutable binary"):
                aggregate_batch_directories(
                    [root / f"batch-{index}" for index in range(1, 6)], OPENINGS, PROTOCOL,
                    master_seed=1, strategy_a="search", strategy_b="random",
                    baseline_profile="final-ra-ce",
                    batch_launchers=[root / f"launcher-batch-{index}" for index in range(1, 6)],
                )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_batches(root, master_seed=1, baseline_profile="final-ra-ce",
                         options_a=options, options_b=options)
            with self.assertRaisesRegex(ValueError, "baseline_profile does not match"):
                aggregate_batch_directories(
                    [root / f"batch-{index}" for index in range(1, 6)], OPENINGS, PROTOCOL,
                    master_seed=1, strategy_a="search", strategy_b="random",
                )

    def test_final_baseline_requires_true_summary_and_launcher_exit_per_batch(self):
        final_options = {"CheckExtensions": "true", "RootAlpha": "true"}
        batch_paths = lambda root: [root / f"batch-{index}" for index in range(1, 6)]
        launcher_paths = lambda root: [root / f"launcher-batch-{index}" for index in range(1, 6)]
        cases = (
            ("missing summary", lambda root: (root / "batch-1/summary.json").unlink(), "summary"),
            ("missing exit", lambda root: (root / "launcher-batch-1/exit-status.json").unlink(), "exit-status"),
            ("nonzero exit", lambda root: _rewrite_json(root / "launcher-batch-1/exit-status.json", {"exit_code": 1, "finished_unix": 1.0}), "exit code"),
            ("summary wdl mismatch", lambda root: _rewrite_json(root / "batch-1/summary.json", {"baseline_profile": "final-ra-ce", "complete": True, "requested_games": 200, "games_written": 200, "finished_games": 200, "unfinished_games": 0, "wdl_for_a": {"win": 199, "draw": 0, "loss": 0}, "run_manifest_sha256": hashlib.sha256((root / "batch-1/run-manifest.json").read_bytes()).hexdigest()}), "summary WDL"),
            ("wrong command target", lambda root: _rewrite_json(root / "launcher-batch-1/command.json", {"schema_version": "m4-baseline-command-v1", "cwd": str(ROOT.resolve()), "command": [sys.executable, str(ROOT / "scripts/m4/match.py"), "--output", str(root / "batch-2")], "engine_sha256": "fake-hash-for-unit-test", "output": str(root / "batch-2"), "runner_git_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(), "runner_source_sha256": hashlib.sha256((ROOT / "scripts/m4/match.py").read_bytes()).hexdigest(), "openings_sha256": hashlib.sha256(OPENINGS.read_bytes()).hexdigest(), "selection_protocol_sha256": hashlib.sha256(PROTOCOL.read_bytes()).hexdigest()}), "command"),
        )
        for name, mutate, message in cases:
            with self.subTest(case=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                make_batches(root, master_seed=1, baseline_profile="final-ra-ce",
                             options_a=final_options, options_b=final_options)
                mutate(root)
                with self.assertRaisesRegex(ValueError, message):
                    aggregate_batch_directories(
                        batch_paths(root), OPENINGS, PROTOCOL, master_seed=1,
                        strategy_a="search", strategy_b="random", baseline_profile="final-ra-ce",
                        batch_launchers=launcher_paths(root),
                    )

    def test_final_baseline_requires_pinned_runner_source_across_all_batches(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            final_options = {"CheckExtensions": "true", "RootAlpha": "true"}
            make_batches(root, master_seed=1, baseline_profile="final-ra-ce",
                         options_a=final_options, options_b=final_options)
            manifest_path = root / "batch-3/run-manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["runner_git_head"] = "f" * 40
            _rewrite_manifest(root / "batch-3", manifest)
            with self.assertRaisesRegex(ValueError, "runner_git_head"):
                aggregate_batch_directories(
                    [root / f"batch-{index}" for index in range(1, 6)], OPENINGS, PROTOCOL,
                    master_seed=1, strategy_a="search", strategy_b="random",
                    baseline_profile="final-ra-ce",
                    batch_launchers=[root / f"launcher-batch-{index}" for index in range(1, 6)],
                )

    def test_q_capture_order_batches_allow_only_q_capture_option(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_batches(
                root, strategy_b="search", experiment="q-capture-order",
                options_a={"QCaptureOrder": "true"},
                options_b={"QCaptureOrder": "false"}, master_seed=1,
            )
            summary = aggregate_batch_directories(
                [root / f"batch-{index}" for index in range(1, 6)], OPENINGS, PROTOCOL,
                master_seed=1, strategy_a="search", strategy_b="search",
            )
        self.assertEqual(summary["batch_validation"]["experiment"], "q-capture-order")
        self.assertEqual(summary["batch_validation"]["engine_a_options"], {"QCaptureOrder": "true"})

    def test_q_capture_order_batches_reject_legacy_engine_flags(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_batches(
                root, strategy_b="search", experiment="q-capture-order",
                options_a={"QCaptureOrder": "true", "MoveHints": "false"},
                options_b={"QCaptureOrder": "false", "MoveHints": "false"}, master_seed=1,
            )
            with self.assertRaisesRegex(ValueError, "q-capture-order experiment has invalid A/B options"):
                aggregate_batch_directories(
                    [root / f"batch-{index}" for index in range(1, 6)], OPENINGS, PROTOCOL,
                    master_seed=1, strategy_a="search", strategy_b="search",
                )

    def test_root_alpha_batches_cannot_be_mixed_with_move_hints(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_batches(
                root, strategy_b="search", experiment="root-alpha",
                options_a={"CheckExtensions": "false", "MoveHints": "false", "RootAlpha": "true"},
                options_b={"CheckExtensions": "false", "MoveHints": "false", "RootAlpha": "false"},
                master_seed=1,
            )
            manifest_path = root / "batch-2" / "run-manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["experiment"] = "move-hints"
            manifest["engine_a_options"] = {"CheckExtensions": "false", "MoveHints": "true"}
            manifest["engine_b_options"] = {"CheckExtensions": "false", "MoveHints": "false"}
            manifest.pop("config_sha256")
            manifest["config_sha256"] = hashlib.sha256(
                json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
            manifest_path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "experiment_mismatch"):
                aggregate_batch_directories(
                    [root / f"batch-{index}" for index in range(1, 6)], OPENINGS, PROTOCOL,
                    master_seed=1, strategy_a="search", strategy_b="search",
                )

    def test_search_ab_aggregation_locks_seed_max_ply_and_look(self):
        mutations = [
            ("master_seed", 2, "master_seed does not match aggregation protocol"),
            ("max_ply", 4000, "max_ply=4096"),
            ("look", 3, "look=1 or look=2"),
        ]
        for field, value, message in mutations:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                make_batches(
                    root, strategy_b="search", experiment="move-hints",
                    options_a={"CheckExtensions": "false", "MoveHints": "true"},
                    options_b={"CheckExtensions": "false", "MoveHints": "false"},
                    master_seed=1,
                )
                manifest_path = root / "batch-1" / "run-manifest.json"
                manifest = json.loads(manifest_path.read_text())
                manifest[field] = value
                manifest.pop("config_sha256")
                manifest["config_sha256"] = hashlib.sha256(
                    json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
                ).hexdigest()
                manifest_path.write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, message):
                    aggregate_batch_directories(
                        [root / f"batch-{index}" for index in range(1, 6)], OPENINGS, PROTOCOL,
                        master_seed=1, strategy_a="search", strategy_b="search",
                    )

    def test_search_ab_rejects_different_executable_hashes_within_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_batches(
                root, strategy_b="search", experiment="move-hints",
                options_a={"CheckExtensions": "false", "MoveHints": "true"},
                options_b={"CheckExtensions": "false", "MoveHints": "false"},
                engine_b_hash="different-executable-hash", master_seed=1,
            )
            with self.assertRaisesRegex(ValueError, "identical executable SHA-256"):
                aggregate_batch_directories(
                    [root / f"batch-{index}" for index in range(1, 6)], OPENINGS, PROTOCOL,
                    master_seed=1, strategy_a="search", strategy_b="search",
                )

    def test_aggregates_five_complete_batches_into_1000_paired_games(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_batches(root)
            summary = aggregate_batch_directories(
                [root / f"batch-{index}" for index in range(1, 6)], OPENINGS, PROTOCOL,
                master_seed=77, strategy_a="search", strategy_b="random",
            )
        self.assertTrue(summary["complete"])
        self.assertTrue(summary["baseline_gate"]["passed"])
        self.assertEqual(summary["finished_games"], 1000)
        self.assertEqual(summary["effective_cluster_count"], 50)

    def test_missing_batch_game_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_batches(root, damaged=2)
            with self.assertRaisesRegex(ValueError, "incomplete"):
                aggregate_batch_directories(
                    [root / f"batch-{index}" for index in range(1, 6)], OPENINGS, PROTOCOL,
                    master_seed=77, strategy_a="search", strategy_b="random",
                )

    def test_games_without_terminal_transcript_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_batches(root, missing_terminal_raw=True)
            with self.assertRaisesRegex(ValueError, "terminal_evidence"):
                aggregate_batch_directories(
                    [root / f"batch-{index}" for index in range(1, 6)], OPENINGS, PROTOCOL,
                    master_seed=77, strategy_a="search", strategy_b="random",
                )

    def test_terminal_outcome_and_a_color_must_match_recorded_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_batches(root, corrupt_terminal_result=True)
            with self.assertRaisesRegex(ValueError, "terminal_result_mismatch"):
                aggregate_batch_directories(
                    [root / f"batch-{index}" for index in range(1, 6)], OPENINGS, PROTOCOL,
                    master_seed=77, strategy_a="search", strategy_b="random",
                )

    def test_search_ab_requires_candidate_a_extension_and_baseline_b_off(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_batches(root, strategy_b="search", options_a={"CheckExtensions": "false"},
                         options_b={"CheckExtensions": "true"}, master_seed=1)
            with self.assertRaisesRegex(ValueError, "check-extensions experiment has invalid A/B options"):
                aggregate_batch_directories(
                    [root / f"batch-{index}" for index in range(1, 6)], OPENINGS, PROTOCOL,
                    master_seed=1, strategy_a="search", strategy_b="search",
                )

    def test_search_ab_keeps_candidate_result_and_option_orientation_as_a(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_batches(root, strategy_b="search", options_a={"CheckExtensions": "true"},
                         options_b={"CheckExtensions": "false"}, master_seed=1)
            summary = aggregate_batch_directories(
                [root / f"batch-{index}" for index in range(1, 6)], OPENINGS, PROTOCOL,
                master_seed=1, strategy_a="search", strategy_b="search",
            )
        self.assertEqual(summary["batch_validation"]["candidate_side"], "A")
        self.assertEqual(summary["batch_validation"]["baseline_side"], "B")
        self.assertEqual(summary["batch_validation"]["score_for_candidate"], "wdl_for_a")
        self.assertEqual(summary["batch_validation"]["engine_a_options"]["CheckExtensions"], "true")

    def test_search_ab_allows_only_locked_move_hints_options(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_batches(
                root, strategy_b="search", experiment="move-hints",
                options_a={"CheckExtensions": "false", "MoveHints": "true"},
                options_b={"CheckExtensions": "false", "MoveHints": "false"},
                master_seed=1,
            )
            summary = aggregate_batch_directories(
                [root / f"batch-{index}" for index in range(1, 6)], OPENINGS, PROTOCOL,
                master_seed=1, strategy_a="search", strategy_b="search",
            )
        self.assertEqual(summary["batch_validation"]["experiment"], "move-hints")
        self.assertEqual(summary["batch_validation"]["engine_a_options"]["MoveHints"], "true")

    def test_batches_from_different_named_experiments_cannot_be_mixed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_batches(
                root, strategy_b="search", options_a={"CheckExtensions": "true"},
                options_b={"CheckExtensions": "false"}, master_seed=1,
            )
            manifest_path = root / "batch-2" / "run-manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["experiment"] = "move-hints"
            manifest["engine_a_options"] = {"CheckExtensions": "false", "MoveHints": "true"}
            manifest["engine_b_options"] = {"CheckExtensions": "false", "MoveHints": "false"}
            manifest.pop("config_sha256")
            manifest["config_sha256"] = hashlib.sha256(
                json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
            manifest_path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "experiment_mismatch"):
                aggregate_batch_directories(
                    [root / f"batch-{index}" for index in range(1, 6)], OPENINGS, PROTOCOL,
                    master_seed=1, strategy_a="search", strategy_b="search",
                )


if __name__ == "__main__":
    unittest.main()
