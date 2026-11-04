import json
import contextlib
import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
import sys


SCRIPT = Path(__file__).with_name("match.py")
ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(Path(__file__).parent))
from match import summarize_results


def write_formal_uci(path: Path, marker: str = "") -> Path:
    path.write_text(
        "#!/usr/bin/env python3\n"
        f"# {marker}\n"
        "import sys\n"
        "for line in sys.stdin:\n"
        " line=line.strip()\n"
        " if line=='uci':\n"
        "  print('option name CheckExtensions type check default false', flush=True)\n"
        "  print('option name MoveHints type check default false', flush=True)\n"
        "  print('option name RootAlpha type check default false', flush=True)\n"
        "  print('uciok', flush=True)\n"
        " elif line=='isready': print('readyok', flush=True)\n"
        " elif line.startswith('go '):\n"
        "  print('info string outcome draw', flush=True)\n"
        "  print('bestmove 0000', flush=True)\n"
        " elif line=='quit': break\n",
        encoding="utf-8",
    )
    path.chmod(0o755)
    return path


def formal_move_hints_command(engine_a: Path, engine_b: Path, output: Path, **overrides: str) -> list[str]:
    values = {
        "nodes": "10000", "global-round-start": "1", "global-round-count": "2",
        "max-ply": "4096", "seed": "1", "look": "1", "games": "200",
    }
    values.update(overrides)
    args = [
        sys.executable, str(SCRIPT), "--engine-a", str(engine_a), "--engine-b", str(engine_b),
        "--strategy-a", "search", "--strategy-b", "search", "--experiment", "move-hints",
        "--engine-a-options", '{"CheckExtensions":"false","MoveHints":"true"}',
        "--engine-b-options", '{"CheckExtensions":"false","MoveHints":"false"}',
        "--openings", str(ROOT / "docs/research/m4-openings/selected-50.tsv"),
        "--selection-protocol", str(ROOT / "docs/research/m4-openings/opening-selection-protocol.json"),
    ]
    for flag in ("nodes", "global-round-start", "global-round-count", "max-ply", "seed", "look", "games"):
        args.extend([f"--{flag}", values[flag]])
    args.extend(["--output", str(output)])
    return args


def write_q_capture_uci(path: Path) -> Path:
    path.write_text(
        "#!/usr/bin/env python3\n"
        "import sys\n"
        "for line in sys.stdin:\n"
        " line=line.strip()\n"
        " if line=='uci':\n"
        "  print('option name QCaptureOrder type check default false', flush=True)\n"
        "  print('uciok', flush=True)\n"
        " elif line=='isready': print('readyok', flush=True)\n"
        " elif line.startswith('go '):\n"
        "  print('info string outcome draw', flush=True)\n"
        "  print('bestmove 0000', flush=True)\n"
        " elif line=='quit': break\n",
        encoding="utf-8",
    )
    path.chmod(0o755)
    return path


def formal_q_capture_order_command(engine_a: Path, engine_b: Path, output: Path, **overrides: str) -> list[str]:
    values = {
        "nodes": "10000", "global-round-start": "1", "global-round-count": "2",
        "max-ply": "4096", "seed": "1", "look": "1", "games": "200",
    }
    values.update(overrides)
    args = [
        sys.executable, str(SCRIPT), "--engine-a", str(engine_a), "--engine-b", str(engine_b),
        "--strategy-a", "search", "--strategy-b", "search", "--experiment", "q-capture-order",
        "--engine-a-options", '{"QCaptureOrder":"true"}',
        "--engine-b-options", '{"QCaptureOrder":"false"}',
        "--openings", str(ROOT / "docs/research/m4-openings/selected-50.tsv"),
        "--selection-protocol", str(ROOT / "docs/research/m4-openings/opening-selection-protocol.json"),
    ]
    for flag in ("nodes", "global-round-start", "global-round-count", "max-ply", "seed", "look", "games"):
        args.extend([f"--{flag}", values[flag]])
    args.extend(["--workers", "4", "--output", str(output)])
    return args


def formal_correctness_repair_command(
    engine_a: Path, engine_b: Path, output: Path, **overrides: str
) -> list[str]:
    workers = overrides.pop("workers", "4")
    engine_timeout = overrides.pop("engine_timeout", "30")
    command = formal_move_hints_command(engine_a, engine_b, output, **overrides)
    command[command.index("move-hints")] = "correctness-repair"
    command[command.index('{"CheckExtensions":"false","MoveHints":"true"}')] = "{}"
    command[command.index('{"CheckExtensions":"false","MoveHints":"false"}')] = "{}"
    command.extend(["--workers", workers, "--engine-timeout", engine_timeout])
    return command


class PairedMatchTests(unittest.TestCase):
    def test_final_ra_ce_profile_rejects_non_four_worker_batch_before_launch(self):
        from unittest.mock import patch
        from match import main

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "batch"
            stderr = io.StringIO()
            argv = [
                "match.py", "--engine-a", sys.executable, "--engine-b", sys.executable,
                "--openings", str(ROOT / "docs/research/m4-openings/selected-50.tsv"),
                "--selection-protocol", str(ROOT / "docs/research/m4-openings/opening-selection-protocol.json"),
                "--nodes", "10000", "--games", "200", "--global-round-start", "1",
                "--global-round-count", "2", "--max-ply", "4096", "--engine-timeout", "30",
                "--workers", "1", "--strategy-a", "search", "--strategy-b", "random",
                "--engine-a-options", '{"CheckExtensions":"true","RootAlpha":"true"}',
                "--engine-b-options", '{"CheckExtensions":"true","RootAlpha":"true"}',
                "--baseline-profile", "final-ra-ce", "--seed", "1", "--output", str(output),
            ]
            with patch.object(sys, "argv", argv), contextlib.redirect_stderr(stderr):
                with self.assertRaises(SystemExit) as error:
                    main()
        self.assertEqual(error.exception.code, 2)
        self.assertIn("final-ra-ce profile requires max-ply=4096, engine-timeout=30, workers=4", stderr.getvalue())
        self.assertFalse(output.exists())

    def test_correctness_repair_allows_distinct_binary_and_records_nonregression_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = write_formal_uci(root / "candidate", "fixed TT exact guard")
            baseline = write_formal_uci(root / "baseline", "clean TT baseline")
            out = root / "correctness-repair"
            result = subprocess.run(
                formal_correctness_repair_command(candidate, baseline, out),
                check=True, capture_output=True, text=True,
            )
            summary = json.loads(result.stdout)
            manifest = json.loads((out / "run-manifest.json").read_text())
            self.assertEqual(summary["correctness_repair_gate"]["score_mean"], 0.5)
            self.assertTrue(summary["correctness_repair_gate"]["passed"])
            self.assertEqual(summary["decision_status"], "non_regression_pass")
            self.assertEqual(manifest["experiment"], "correctness-repair")
            self.assertEqual(manifest["engine_a_options"], {})
            self.assertEqual(manifest["engine_b_options"], {})
            self.assertNotEqual(
                manifest["engine_a_executable"]["sha256"],
                manifest["engine_b_executable"]["sha256"],
            )

    def test_correctness_repair_rejects_nonfrozen_settings_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = write_formal_uci(root / "candidate", "fixed")
            baseline = write_formal_uci(root / "baseline", "baseline")
            invalid = [
                ({"nodes": "1"}, "nodes=10000"),
                ({"seed": "2"}, "seed=1"),
                ({"max-ply": "4000"}, "max-ply=4096"),
                ({"games": "100", "global-round-count": "1"}, "games=200"),
                ({"global-round-start": "3", "look": "1"}, "rounds 1–2"),
                ({"look": "2"}, "look=1"),
                ({"workers": "2"}, "workers=4"),
            ]
            for index, (overrides, message) in enumerate(invalid):
                with self.subTest(overrides=overrides):
                    out = root / f"invalid-{index}"
                    result = subprocess.run(
                        formal_correctness_repair_command(candidate, baseline, out, **overrides),
                        check=False, capture_output=True, text=True,
                    )
                    self.assertEqual(result.returncode, 2)
                    self.assertIn(message, result.stderr)
                    self.assertFalse(out.exists())

    def test_correctness_repair_preflight_locks_engine_timeout_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = write_formal_uci(root / "candidate", "fixed")
            baseline = write_formal_uci(root / "baseline", "baseline")
            out = root / "wrong-timeout"
            result = subprocess.run(
                formal_correctness_repair_command(
                    candidate, baseline, out, engine_timeout="30.5",
                ),
                check=False, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("engine-timeout=30", result.stderr)
            self.assertFalse(out.exists())

    def test_correctness_repair_requires_same_options_to_be_empty_and_binaries_distinct(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = write_formal_uci(root / "candidate", "fixed")
            baseline = write_formal_uci(root / "baseline", "baseline")
            for side in ("--engine-a-options", "--engine-b-options"):
                out = root / side.removeprefix("--")
                command = formal_correctness_repair_command(candidate, baseline, out)
                command[command.index(side) + 1] = '{"CheckExtensions":"false"}'
                result = subprocess.run(command, check=False, capture_output=True, text=True)
                self.assertEqual(result.returncode, 2)
                self.assertIn("requires A options {} and B options {}", result.stderr)
                self.assertFalse(out.exists())

            same_binary_out = root / "same-binary"
            result = subprocess.run(
                formal_correctness_repair_command(candidate, candidate, same_binary_out),
                check=False, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("distinct executable SHA-256", result.stderr)
            self.assertFalse(same_binary_out.exists())

    def test_correctness_repair_requires_full_frozen_sample_and_search_engines(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = write_formal_uci(root / "candidate", "fixed")
            baseline = write_formal_uci(root / "baseline", "baseline")
            missing_protocol_out = root / "missing-protocol"
            command = formal_correctness_repair_command(candidate, baseline, missing_protocol_out)
            protocol_index = command.index("--selection-protocol")
            del command[protocol_index:protocol_index + 2]
            result = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("full frozen 50-opening selection", result.stderr)
            self.assertFalse(missing_protocol_out.exists())

            wrong_strategy_out = root / "wrong-strategy"
            command = formal_correctness_repair_command(candidate, baseline, wrong_strategy_out)
            command[command.index("--strategy-b") + 1] = "random"
            result = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("applies only to search-v-search", result.stderr)
            self.assertFalse(wrong_strategy_out.exists())

    def test_correctness_repair_gate_uses_complete_200_and_inclusive_45_percent(self):
        from match import correctness_repair_gate

        exact = correctness_repair_gate(
            {"win": 80, "draw": 20, "loss": 100, "unfinished": 0},
            requested_games=200, protocol_verified=True,
        )
        self.assertEqual(exact["score_mean"], 0.45)
        self.assertTrue(exact["passed"])

        below = correctness_repair_gate(
            {"win": 79, "draw": 21, "loss": 100, "unfinished": 0},
            requested_games=200, protocol_verified=True,
        )
        self.assertEqual(below["score_mean"], 0.4475)
        self.assertFalse(below["passed"])

        missing = correctness_repair_gate(
            {"win": 80, "draw": 20, "loss": 99, "unfinished": 1},
            requested_games=200, protocol_verified=True,
        )
        self.assertFalse(missing["complete"])
        self.assertIsNone(missing["score_mean"])
        self.assertFalse(missing["passed"])

    def test_random_and_greedy_baseline_gates_still_count_wins_only(self):
        from match import baseline_gate

        gate_inputs = dict(
            requested_games=1000, nodes_per_move=10000,
            selection_verified=True, selected_opening_count=50,
            paired_games_complete=True,
        )
        random_with_draw = baseline_gate(
            "search", "random", {"win": 999, "draw": 1, "loss": 0, "unfinished": 0},
            **gate_inputs,
        )
        self.assertFalse(random_with_draw["passed"])
        greedy_at_floor = baseline_gate(
            "search", "greedy", {"win": 980, "draw": 20, "loss": 0, "unfinished": 0},
            **gate_inputs,
        )
        self.assertTrue(greedy_at_floor["passed"])
        greedy_below_floor = baseline_gate(
            "search", "greedy", {"win": 979, "draw": 21, "loss": 0, "unfinished": 0},
            **gate_inputs,
        )
        self.assertFalse(greedy_below_floor["passed"])

    def test_q_capture_order_uses_only_its_new_engine_option(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = write_q_capture_uci(root / "q-only-engine")
            out = root / "q-capture-order"
            result = subprocess.run(
                formal_q_capture_order_command(engine, engine, out),
                check=True, capture_output=True, text=True,
            )
            summary = json.loads(result.stdout)
            manifest = json.loads((out / "run-manifest.json").read_text())
            self.assertTrue(summary["formal_decision_ready"])
            self.assertEqual(summary["experiment"], "q-capture-order")
            self.assertEqual(manifest["engine_a_options"], {"QCaptureOrder": "true"})
            self.assertEqual(manifest["engine_b_options"], {"QCaptureOrder": "false"})
            self.assertEqual(manifest["workers"], 4)

    def test_q_capture_order_rejects_old_engine_options_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = write_q_capture_uci(root / "q-only-engine")
            out = root / "invalid-q-capture-order"
            command = formal_q_capture_order_command(engine, engine, out)
            command[command.index('{"QCaptureOrder":"true"}')] = (
                '{"QCaptureOrder":"true","MoveHints":"false"}'
            )
            result = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("q-capture-order experiment requires", result.stderr)
            self.assertFalse(out.exists())

    def test_exact_formal_root_alpha_protocol_records_locked_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = write_formal_uci(root / "engine")
            out = root / "root-alpha"
            command = formal_move_hints_command(engine, engine, out)
            command[command.index("move-hints")] = "root-alpha"
            command[command.index('{"CheckExtensions":"false","MoveHints":"true"}')] = (
                '{"CheckExtensions":"false","MoveHints":"false","RootAlpha":"true"}'
            )
            command[command.index('{"CheckExtensions":"false","MoveHints":"false"}')] = (
                '{"CheckExtensions":"false","MoveHints":"false","RootAlpha":"false"}'
            )
            result = subprocess.run(command, check=True, capture_output=True, text=True)
            summary = json.loads(result.stdout)
            manifest = json.loads((out / "run-manifest.json").read_text())
            self.assertTrue(summary["formal_decision_ready"])
            self.assertEqual(summary["experiment"], "root-alpha")
            self.assertEqual(manifest["engine_a_options"], {
                "CheckExtensions": "false", "MoveHints": "false", "RootAlpha": "true",
            })
            self.assertEqual(manifest["engine_b_options"], {
                "CheckExtensions": "false", "MoveHints": "false", "RootAlpha": "false",
            })

    def test_root_alpha_rejects_other_feature_options_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = write_formal_uci(root / "engine")
            out = root / "invalid-root-alpha"
            command = formal_move_hints_command(engine, engine, out)
            command[command.index("move-hints")] = "root-alpha"
            result = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("root-alpha experiment requires", result.stderr)
            self.assertFalse(out.exists())

    def test_summary_does_not_mark_non_protocol_search_as_formal(self):
        summary = summarize_results(
            requested_games=200,
            totals={"win": 200, "draw": 0, "loss": 0, "unfinished": 0},
            opening_scores={f"o{i}": [1.0, 1.0] for i in range(50)},
            strategy_a="search", strategy_b="search", population_size=203,
            finite_population_verified=True, selected_opening_count=50, look=1,
            nodes_per_move=1, selection_verified=True, paired_games_complete=True,
        )
        self.assertFalse(summary["formal_decision_ready"])
        self.assertEqual(summary["decision_status"], "inconclusive")

    def test_formal_move_hints_preflight_rejects_wrong_node_cap(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = write_formal_uci(root / "engine")
            out = root / "invalid-nodes"
            command = formal_move_hints_command(engine, engine, out, nodes="1")
            result = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("formal move-hints protocol requires nodes=10000", result.stderr)
            self.assertFalse(out.exists())

    def test_formal_move_hints_preflight_locks_seed_cap_rounds_and_look(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = write_formal_uci(root / "engine")
            invalid = [
                ({"seed": "2"}, "seed=1"),
                ({"max-ply": "4000"}, "max-ply=4096"),
                ({"global-round-start": "1", "look": "2"}, "look 2 requires rounds 3–4"),
                ({"global-round-start": "2"}, "look 1 requires rounds 1–2"),
            ]
            for index, (overrides, message) in enumerate(invalid):
                with self.subTest(overrides=overrides):
                    out = root / f"invalid-{index}"
                    result = subprocess.run(
                        formal_move_hints_command(engine, engine, out, **overrides),
                        check=False, capture_output=True, text=True,
                    )
                    self.assertEqual(result.returncode, 2)
                    self.assertIn(message, result.stderr)
                    self.assertFalse(out.exists())

    def test_formal_move_hints_preflight_rejects_different_engine_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine_a = write_formal_uci(root / "engine-a", "first executable")
            engine_b = write_formal_uci(root / "engine-b", "second executable")
            out = root / "different-executables"
            command = formal_move_hints_command(engine_a, engine_b, out)
            result = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("must use identical executable SHA-256", result.stderr)
            self.assertFalse(out.exists())

    def test_strength_experiment_profiles_still_reject_distinct_binaries(self):
        profile_options = {
            "check-extensions": ('{"CheckExtensions":"true"}', '{"CheckExtensions":"false"}'),
            "move-hints": (
                '{"CheckExtensions":"false","MoveHints":"true"}',
                '{"CheckExtensions":"false","MoveHints":"false"}',
            ),
            "root-alpha": (
                '{"CheckExtensions":"false","MoveHints":"false","RootAlpha":"true"}',
                '{"CheckExtensions":"false","MoveHints":"false","RootAlpha":"false"}',
            ),
            "q-capture-order": ('{"QCaptureOrder":"true"}', '{"QCaptureOrder":"false"}'),
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine_a = write_formal_uci(root / "engine-a", "first executable")
            engine_b = write_formal_uci(root / "engine-b", "second executable")
            for experiment, (options_a, options_b) in profile_options.items():
                with self.subTest(experiment=experiment):
                    out = root / experiment
                    command = formal_move_hints_command(engine_a, engine_b, out)
                    command[command.index("move-hints")] = experiment
                    command[command.index('{"CheckExtensions":"false","MoveHints":"true"}')] = options_a
                    command[command.index('{"CheckExtensions":"false","MoveHints":"false"}')] = options_b
                    if experiment == "q-capture-order":
                        # The helper's old A value appears only once after the first replacement.
                        command[command.index(options_a)] = options_a
                    result = subprocess.run(command, check=False, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn("must use identical executable SHA-256", result.stderr)
                    self.assertFalse(out.exists())

    def test_exact_formal_move_hints_protocol_marks_complete_200_game_run_formal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = write_formal_uci(root / "engine")
            out = root / "valid-formal-run"
            result = subprocess.run(
                formal_move_hints_command(engine, engine, out),
                check=True, capture_output=True, text=True,
            )
            summary = json.loads(result.stdout)
            manifest = json.loads((out / "run-manifest.json").read_text())
            self.assertTrue(summary["formal_decision_ready"])
            self.assertEqual(summary["experiment"], "move-hints")
            self.assertEqual(manifest["experiment"], "move-hints")
            self.assertEqual(manifest["global_rounds"], [1, 2])
            self.assertEqual(manifest["nodes_per_move"], 10000)
            self.assertEqual(manifest["max_ply"], 4096)
            self.assertEqual(manifest["master_seed"], 1)

    def test_legacy_check_extensions_flags_remain_formal_without_experiment_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = write_formal_uci(root / "engine")
            out = root / "legacy-check-extensions"
            command = formal_move_hints_command(engine, engine, out)
            experiment_index = command.index("--experiment")
            del command[experiment_index:experiment_index + 2]
            command[command.index("--engine-a-options") + 1] = '{"CheckExtensions":"true"}'
            command[command.index("--engine-b-options") + 1] = '{"CheckExtensions":"false"}'
            result = subprocess.run(command, check=True, capture_output=True, text=True)
            summary = json.loads(result.stdout)
            self.assertTrue(summary["formal_decision_ready"])
            self.assertEqual(summary["experiment"], "check-extensions")

    def test_pilot_comparison_remains_available_but_is_not_formal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = write_formal_uci(root / "engine")
            out = root / "pilot"
            result = subprocess.run(
                formal_move_hints_command(engine, engine, out, **{"games": "100", "global-round-count": "1"}),
                check=True, capture_output=True, text=True,
            )
            summary = json.loads(result.stdout)
            self.assertTrue(summary["complete"])
            self.assertFalse(summary["formal_decision_ready"])
            self.assertEqual(summary["decision_status"], "inconclusive")

    def test_configure_rejects_an_option_not_advertised_during_uci(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / "no_options.py"
            fake.write_text(
                "import sys\n"
                "for line in sys.stdin:\n"
                " if line.strip()=='uci': print('uciok', flush=True)\n"
                " elif line.strip()=='isready': print('readyok', flush=True)\n"
                " elif line.strip()=='quit': break\n",
                encoding="utf-8",
            )
            from match import UciEngine
            engine = UciEngine.start(f"{sys.executable} {fake}")
            try:
                with self.assertRaisesRegex(ValueError, "not advertised"):
                    engine.configure({"CheckExtensions": "true"})
            finally:
                engine.close()

    def test_terminal_result_mapping_covers_both_colors_and_draw(self):
        from match import terminal_result_for_a
        self.assertEqual(terminal_result_for_a("red", True), "win")
        self.assertEqual(terminal_result_for_a("black", True), "loss")
        self.assertEqual(terminal_result_for_a("red", False), "loss")
        self.assertEqual(terminal_result_for_a("black", False), "win")
        self.assertEqual(terminal_result_for_a("draw", True), "draw")
        self.assertEqual(terminal_result_for_a("draw", False), "draw")

    def test_bestmove_0000_without_known_outcome_is_protocol_error_with_raw_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / "unknown_outcome.py"
            fake.write_text(
                "import sys\n"
                "for line in sys.stdin:\n"
                " line=line.strip()\n"
                " if line=='uci':\n"
                "  print('option name CheckExtensions type check default false', flush=True)\n"
                "  print('uciok', flush=True)\n"
                " elif line=='isready': print('readyok', flush=True)\n"
                " elif line.startswith('go '): print('bestmove 0000', flush=True)\n"
                " elif line=='quit': break\n",
                encoding="utf-8",
            )
            from match import MatchProtocolError, UciEngine
            log_path = root / "raw-uci.log"
            engine = UciEngine.start(f"{sys.executable} {fake}", log_path=log_path)
            try:
                with self.assertRaises(MatchProtocolError) as caught:
                    engine.bestmove([], 100, "search", 1)
                self.assertIn("bestmove 0000", caught.exception.raw_lines)
            finally:
                engine.close()
            self.assertIn("stdout: bestmove 0000", log_path.read_text(encoding="utf-8"))

    def test_bestmove_0000_rejects_unknown_outcome(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / "unknown_outcome.py"
            fake.write_text(
                "import sys\n"
                "for line in sys.stdin:\n"
                " line=line.strip()\n"
                " if line=='uci': print('uciok', flush=True)\n"
                " elif line=='isready': print('readyok', flush=True)\n"
                " elif line.startswith('go '):\n"
                "  print('info string outcome winner', flush=True)\n"
                "  print('bestmove 0000', flush=True)\n"
                " elif line=='quit': break\n",
                encoding="utf-8",
            )
            from match import MatchProtocolError, UciEngine
            engine = UciEngine.start(f"{sys.executable} {fake}")
            try:
                with self.assertRaises(MatchProtocolError):
                    engine.bestmove([], 100, "search", 1)
            finally:
                engine.close()

    def test_terminal_outcome_followed_by_playable_bestmove_is_protocol_error(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / "contradictory_uci.py"
            fake.write_text(
                "import sys\n"
                "for line in sys.stdin:\n"
                " line=line.strip()\n"
                " if line=='uci': print('uciok', flush=True)\n"
                " elif line=='isready': print('readyok', flush=True)\n"
                " elif line.startswith('go '):\n"
                "  print('info string outcome red', flush=True)\n"
                "  print('bestmove h0h1', flush=True)\n"
                " elif line=='quit': break\n",
                encoding="utf-8",
            )
            from match import MatchProtocolError, UciEngine
            engine = UciEngine.start(f"{sys.executable} {fake}")
            try:
                with self.assertRaisesRegex(MatchProtocolError, "terminal outcome with non-null bestmove"):
                    engine.bestmove([], 100, "search", 1)
            finally:
                engine.close()

    def test_unknown_terminal_is_persisted_as_unfinished_with_raw_protocol(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / "unknown_outcome.py"
            fake.write_text(
                "import sys\n"
                "for line in sys.stdin:\n"
                " line=line.strip()\n"
                " if line=='uci': print('uciok', flush=True)\n"
                " elif line=='isready': print('readyok', flush=True)\n"
                " elif line.startswith('go '):\n"
                "  print('info string outcome winner', flush=True)\n"
                "  print('bestmove 0000', flush=True)\n"
                " elif line=='quit': break\n",
                encoding="utf-8",
            )
            openings = root / "openings.tsv"
            openings.write_text("opening_id\tsource_ref\ticcs_prefix\nsample\tsource\th2e2 h9g7 h0g2 i9h9\n")
            out = root / "run"
            result = subprocess.run([
                sys.executable, str(SCRIPT), "--engine-a", f"{sys.executable} {fake}",
                "--engine-b", f"{sys.executable} {fake}", "--openings", str(openings),
                "--nodes", "100", "--games", "2", "--output", str(out),
            ], check=False, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            games = [json.loads(line) for line in (out / "games.jsonl").read_text().splitlines()]
            self.assertEqual(len(games), 2)
            self.assertTrue(all(game["result_for_a"] == "unfinished" for game in games))
            self.assertTrue(all("unknown engine outcome" in game["protocol_error"] for game in games))
            self.assertTrue(all(game["raw_response"] == ["info string outcome winner", "bestmove 0000"] for game in games))

    def test_color_swapped_pair_and_opening_cluster_score(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / "fake_uci.py"
            fake.write_text(
                "import sys\n"
                "for line in sys.stdin:\n"
                " line=line.strip()\n"
                " if line=='uci':\n"
                "  print('option name CheckExtensions type check default false', flush=True)\n"
                "  print('uciok', flush=True)\n"
                " elif line=='isready': print('readyok', flush=True)\n"
                " elif line.startswith('go '):\n"
                "  print('info string outcome red', flush=True)\n"
                "  print('bestmove 0000', flush=True)\n"
                " elif line=='quit': break\n",
                encoding="utf-8",
            )
            openings = root / "openings.tsv"
            openings.write_text(
                "opening_id\tsource_ref\ticcs_prefix\n"
                "sample\tfixture-source\th2e2 h9g7 h0g2 i9h9\n",
                encoding="utf-8",
            )
            out = root / "runs"
            command = [
                sys.executable, str(SCRIPT), "--engine-a", f"{sys.executable} {fake}",
                "--engine-b", f"{sys.executable} {fake}", "--strategy-a", "search",
                "--strategy-b", "search", "--openings", str(openings), "--nodes", "100",
                "--games", "2", "--seed", "42", "--global-round-start", "3",
                "--engine-a-options", '{"CheckExtensions":"true"}',
                "--engine-b-options", '{"CheckExtensions":"false"}', "--output", str(out),
            ]
            result = subprocess.run(command, check=True, capture_output=True, text=True)
            summary = json.loads(result.stdout)
            games = [json.loads(line) for line in (out / "games.jsonl").read_text().splitlines()]
            self.assertEqual(summary["completed_opening_clusters"], 1)
            self.assertEqual(summary["wdl_for_a"]["win"], 1)
            self.assertEqual(summary["wdl_for_a"]["loss"], 1)
            self.assertEqual(summary["score_mean"], 0.5)
            self.assertEqual([game["a_is_red"] for game in games], [True, False])
            self.assertEqual([game["result_for_a"] for game in games], ["win", "loss"])
            self.assertTrue(all(game["max_ply"] == 4096 for game in games))
            self.assertEqual([game["global_round"] for game in games], [3, 3])
            self.assertEqual(len({game["game_id"] for game in games}), 2)
            self.assertTrue(all(game["seed"] != 42 for game in games))
            manifest = json.loads((out / "run-manifest.json").read_text())
            self.assertEqual(manifest["experiment"], "check-extensions")
            self.assertEqual(manifest["engine_a_options"], {"CheckExtensions": "true"})
            self.assertEqual(manifest["engine_b_options"], {"CheckExtensions": "false"})
            self.assertEqual(manifest["global_rounds"], [3])
            self.assertIn("sha256", summary["engine_a_executable"])
            self.assertIn("sha256", summary["engine_b_executable"])
            for label, option_value in (("engine-a", "true"), ("engine-b", "false")):
                transcript = (out / f"{label}.log").read_text()
                self.assertIn("stdout: option name CheckExtensions type check default false", transcript)
                self.assertIn(f"stdin: setoption name CheckExtensions value {option_value}", transcript)
            self.assertEqual(games[0]["terminal_raw"], ["info string outcome red", "bestmove 0000"])
            saved_games = (out / "games.jsonl").read_bytes()
            rerun = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(rerun.returncode, 2)
            self.assertIn("choose a new path", rerun.stderr)
            self.assertEqual((out / "games.jsonl").read_bytes(), saved_games)

    def test_move_hints_experiment_requires_locked_options_and_records_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / "fake_uci.py"
            fake.write_text(
                "import sys\n"
                "for line in sys.stdin:\n"
                " line=line.strip()\n"
                " if line=='uci':\n"
                "  print('option name CheckExtensions type check default false', flush=True)\n"
                "  print('option name MoveHints type check default false', flush=True)\n"
                "  print('uciok', flush=True)\n"
                " elif line=='isready': print('readyok', flush=True)\n"
                " elif line.startswith('go '):\n"
                "  print('info string outcome red', flush=True)\n"
                "  print('bestmove 0000', flush=True)\n"
                " elif line=='quit': break\n",
                encoding="utf-8",
            )
            openings = root / "openings.tsv"
            openings.write_text("opening_id\tsource_ref\ticcs_prefix\nsample\tsource\th2e2 h9g7 h0g2 i9h9\n")
            out = root / "move-hints"
            command = [
                sys.executable, str(SCRIPT), "--engine-a", f"{sys.executable} {fake}",
                "--engine-b", f"{sys.executable} {fake}", "--strategy-a", "search",
                "--strategy-b", "search", "--experiment", "move-hints",
                "--engine-a-options", '{"CheckExtensions":"false","MoveHints":"true"}',
                "--engine-b-options", '{"CheckExtensions":"false","MoveHints":"false"}',
                "--openings", str(openings), "--nodes", "100", "--games", "2",
                "--output", str(out),
            ]
            result = subprocess.run(command, check=True, capture_output=True, text=True)
            manifest = json.loads((out / "run-manifest.json").read_text())
            self.assertEqual(manifest["experiment"], "move-hints")
            self.assertEqual(manifest["engine_a_options"], {"CheckExtensions": "false", "MoveHints": "true"})
            self.assertEqual(manifest["engine_b_options"], {"CheckExtensions": "false", "MoveHints": "false"})
            self.assertEqual(json.loads(result.stdout)["finished_games"], 2)

    def test_move_hints_experiment_rejects_wrong_feature_configuration_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / "unused.py"
            fake.write_text("", encoding="utf-8")
            openings = root / "openings.tsv"
            openings.write_text("opening_id\tsource_ref\ticcs_prefix\nsample\tsource\th2e2 h9g7 h0g2 i9h9\n")
            out = root / "rejected"
            result = subprocess.run([
                sys.executable, str(SCRIPT), "--engine-a", f"{sys.executable} {fake}",
                "--engine-b", f"{sys.executable} {fake}", "--strategy-a", "search",
                "--strategy-b", "search", "--experiment", "move-hints",
                "--engine-a-options", '{"CheckExtensions":"true","MoveHints":"true"}',
                "--engine-b-options", '{"CheckExtensions":"false","MoveHints":"false"}',
                "--openings", str(openings), "--nodes", "100", "--games", "2",
                "--output", str(out),
            ], check=False, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("move-hints experiment requires", result.stderr)
            self.assertFalse(out.exists())

    def test_engine_handshake_timeout_preserves_stderr_log(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / "hung_uci.py"
            fake.write_text(
                "import sys, time\n"
                "print('fake startup diagnostic', file=sys.stderr, flush=True)\n"
                "for line in sys.stdin: time.sleep(1)\n",
                encoding="utf-8",
            )
            from match import UciEngine
            log_path = root / "engine-a.log"
            started = __import__("time").monotonic()
            with self.assertRaises(TimeoutError):
                UciEngine.start(f"{sys.executable} {fake}", timeout_seconds=0.1, log_path=log_path)
            self.assertLess(__import__("time").monotonic() - started, 1.0)
            self.assertIn("fake startup diagnostic", log_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
