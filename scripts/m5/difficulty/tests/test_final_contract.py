import hashlib
import json
import tempfile
import shutil
import contextlib
import io
import unittest
import unittest.mock
from pathlib import Path

from final_contract import (
    FinalContractError,
    create_final_freeze,
    select_final_openings,
    verify_final_selection,
    validate_final_contract_inputs,
    audit_final_series,
    write_final_selection,
    parse_profile_table,
    _create_registered_selection,
    _select_from_recorded_event,
    verify_uci_product_interface,
)
from difficulty_match import (
    BASELINE_OPTIONS, MAX_PLY, WORKERS, SEED_SCHEME, DifficultyMatchError,
    _opening_set_digest, _decision_trace_entry, aggregate_pair,
    apply_run_kind_gate, schedule_pair,
)


class FinalFreezeTests(unittest.TestCase):
    def test_current_product_options_exclude_withdrawn_search_flags(self):
        self.assertEqual(BASELINE_OPTIONS, {
            "RootAlpha": "true", "CheckExtensions": "true",
            "KillerHistoryOrdering": "true", "MultiPV": "1",
            "Strategy": "difficulty",
        })
        self.assertNotIn("NullMove", BASELINE_OPTIONS)
        self.assertNotIn("LateMoveReductions", BASELINE_OPTIONS)

    def test_actual_product_profile_source_parses_all_ten_levels(self):
        source = Path(__file__).resolve().parents[4] / "crates/xq-engine/src/difficulty.rs"
        profiles = parse_profile_table(source)
        self.assertEqual(len(profiles), 10)
        self.assertEqual(profiles[0]["noise_cp"], 1200)

    def test_synthetic_population_cannot_enter_production_freeze(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = make_fixture(Path(tmp))
            fake = Path(tmp) / "fake-eligible.jsonl"
            fake.write_text(Path(fixture["freeze_args"]["eligible_path"]).read_text())
            fixture["freeze_args"]["eligible_path"] = fake
            with self.assertRaises(FinalContractError):
                create_final_freeze(**fixture["freeze_args"])

    def test_freeze_rejects_a_different_actual_pipeline_checkout(self):
        import final_contract
        import subprocess

        pipeline_files = (
            "scripts/m5/difficulty/cli.py",
            "scripts/m5/difficulty/difficulty_match.py",
            "scripts/m5/difficulty/final_contract.py",
            "scripts/m4/match.py",
            "scripts/m4/future_openings.py",
            "scripts/m4/audit_q_capture.py",
            "scripts/m4/composite_statistics.py",
            "scripts/m5/audit.py",
            "scripts/m5/protocol.py",
            "scripts/m5/calibration/calibration.py",
        )

        def make_pipeline(root, marker):
            entry = root / "scripts/m5/difficulty/final_contract.py"
            for relative in pipeline_files:
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(f"# {marker}: {relative}\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(root), "init", "-q"], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.name", "Fixture"], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.email", "fixture@example.invalid"], check=True)
            subprocess.run(["git", "-C", str(root), "add", "."], check=True)
            subprocess.run(["git", "-C", str(root), "commit", "-qm", "fixture pipeline"], check=True)
            return entry

        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as fixture_dir:
            root = Path(tmp)
            pipeline_a = make_pipeline(root / "pipeline-a", "caller-a")
            pipeline_b = make_pipeline(root / "pipeline-b", "caller-b")
            fixture = make_fixture(Path(fixture_dir))
            with unittest.mock.patch.object(final_contract, "__file__", str(pipeline_a)):
                freeze = create_final_freeze(**fixture["freeze_args"])
                tool_root = pipeline_a.parents[3]
                self.assertEqual(freeze["pipeline"]["git_head"],
                                 subprocess.check_output(["git", "-C", str(tool_root), "rev-parse", "HEAD"], text=True).strip())
                self.assertEqual(set(freeze["pipeline"]["files_sha256"]), set(pipeline_files))
                self.assertIn("untracked_files_sha256", freeze["pipeline"])
                final_contract._verify_freeze(freeze)
                (tool_root / "scripts/m5/difficulty/cli.py").write_text("# changed caller\n", encoding="utf-8")
                with self.assertRaisesRegex(FinalContractError, "pipeline"):
                    final_contract._verify_freeze(freeze)
            with unittest.mock.patch.object(final_contract, "__file__", str(pipeline_b)):
                with self.assertRaisesRegex(FinalContractError, "pipeline"):
                    final_contract._verify_freeze(freeze)
                selection_dir = root / "must-not-register"
                with unittest.mock.patch.object(
                    final_contract.secrets, "token_bytes", side_effect=AssertionError("entropy accessed")
                ), self.assertRaisesRegex(FinalContractError, "pipeline"):
                    select_final_openings(freeze, selection_dir)
                self.assertFalse(selection_dir.exists())
                with self.assertRaisesRegex(FinalContractError, "pipeline"):
                    validate_final_contract_inputs(freeze, {}, [], 1, "", 1)

    def test_old_freeze_without_pipeline_pin_cannot_be_promoted(self):
        import final_contract

        with tempfile.TemporaryDirectory() as tmp:
            freeze = create_final_freeze(**make_fixture(Path(tmp))["freeze_args"])
            legacy = dict(freeze)
            legacy.pop("pipeline")
            legacy["schema"] = "m5-difficulty-final-freeze-v1"
            legacy.pop("freeze_sha256")
            legacy["freeze_sha256"] = final_contract._canonical_sha(legacy)
            with self.assertRaisesRegex(FinalContractError, "pipeline source pin"):
                final_contract._verify_freeze(legacy)

    def test_public_freeze_cli_preflights_without_sampling_or_entropy(self):
        from scripts.m5.difficulty.cli import main as cli_main
        from scripts.m5.difficulty import final_contract

        with tempfile.TemporaryDirectory() as tmp:
            fixture = make_fixture(Path(tmp))
            args = fixture["freeze_args"]
            output = Path(tmp) / "final-freeze.json"
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout), unittest.mock.patch.object(
                final_contract.secrets, "token_bytes", side_effect=AssertionError("sampling entropy accessed")
            ):
                self.assertEqual(cli_main([
                    "freeze-final", "--source-repo", str(args["source_repo"]),
                    "--binary", str(args["binary_path"]), "--profile", str(args["profile_path"]),
                    "--eligible", str(args["eligible_path"]), "--pilot", str(args["pilot_path"]),
                    "--master-seed", str(args["master_seed"]), "--freeze-time", args["freeze_time"],
                    "--binary-build-source-head", args["binary_build_source_head"],
                    "--output", str(output),
                ]), 0)
            result = json.loads(stdout.getvalue())
            self.assertFalse(result["sampling_started"])
            self.assertEqual(json.loads(output.read_text())["profiles"], fixture["profiles"])
            self.assertFalse((args["source_repo"] / ".git/m5-difficulty-final-selection-locks").exists())

    def test_public_selector_accepts_only_a_freeze_and_output_path(self):
        import inspect
        from scripts.m5.difficulty.cli import main as cli_main

        self.assertEqual(list(inspect.signature(select_final_openings).parameters),
                         ["freeze", "output_dir"])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            cli_main(["select-final", "--freeze", "frozen.json", "--output-dir", "selection",
                      "--entropy-hex", "a1" * 32])

    def test_candidate_gets_only_one_registered_entropy_selection(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = make_fixture(Path(tmp))
            freeze = create_final_freeze(**fixture["freeze_args"])
            first = _create_registered_selection(freeze, Path(tmp) / "selection-a",
                                                 entropy_event("a1" * 32, "2026-10-07T00:01:00Z"))
            self.assertTrue(verify_final_selection(freeze, first))
            with self.assertRaises(FinalContractError):
                _create_registered_selection(freeze, Path(tmp) / "selection-b",
                                             entropy_event("b2" * 32, "2026-10-07T00:02:00Z"))
            changed_freeze_args = dict(fixture["freeze_args"], freeze_time="2026-10-07T00:03:00Z")
            changed_freeze = create_final_freeze(**changed_freeze_args)
            with self.assertRaises(FinalContractError):
                _create_registered_selection(changed_freeze, Path(tmp) / "selection-c",
                                             entropy_event("c3" * 32, "2026-10-07T00:04:00Z"))

    def test_actual_uci_handshake_rejects_withdrawn_option_advertisement(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = make_fixture(Path(tmp))
            binary = fixture["freeze_args"]["binary_path"]
            script = binary.read_text(encoding="utf-8")
            script = script.replace("option name RootAlpha",
                                    "option name NullMove type check default false\noption name RootAlpha")
            binary.write_text(script, encoding="utf-8")
            with self.assertRaisesRegex(FinalContractError, "withdrawn options"):
                verify_uci_product_interface(binary)

    def test_final_freeze_rejects_withdrawn_options(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = dict(make_fixture(Path(tmp))["freeze_args"])
            args["engine_options"] = dict(BASELINE_OPTIONS, NullMove="false", LateMoveReductions="false")
            with self.assertRaises(FinalContractError):
                create_final_freeze(**args)

    def test_freeze_pins_all_ten_profiles_before_fresh_entropy_selection(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = make_fixture(Path(tmp))
            freeze = create_final_freeze(**fixture["freeze_args"])
            self.assertEqual(freeze["profiles"], fixture["profiles"])
            self.assertEqual(freeze["accepted_engine_options"], fixture["engine_options"])
            self.assertEqual(freeze["population"]["row_count"], 203)
            self.assertEqual(freeze["pilot_selection"]["row_count"], 50)
            selection = _create_registered_selection(
                freeze, Path(tmp) / "selection", entropy_event("a1" * 32, "2026-10-07T00:01:00Z"))
            self.assertEqual(selection["eligible_after_pilot"]["rows"], 124)
            self.assertEqual(selection["eligible_after_pilot"]["components"], 83)
            self.assertEqual(len(selection["openings"]), 50)
            self.assertTrue(verify_final_selection(freeze, selection))

    def test_entropy_order_is_deterministic_but_new_entropy_changes_selection(self):
        with tempfile.TemporaryDirectory() as tmp:
            freeze = create_final_freeze(**make_fixture(Path(tmp))["freeze_args"])
            first = _select_from_recorded_event(freeze, entropy_event("a1" * 32, "2026-10-07T00:01:00Z"))
            same = _select_from_recorded_event(freeze, entropy_event("a1" * 32, "2026-10-07T00:01:00Z"))
            other = _select_from_recorded_event(freeze, entropy_event("b2" * 32, "2026-10-07T00:02:00Z"))
            self.assertEqual(first["opening_ids"], same["opening_ids"])
            self.assertNotEqual(first["opening_ids"], other["opening_ids"])

    def test_selection_rejects_pre_freeze_entropy_and_modified_freeze(self):
        with tempfile.TemporaryDirectory() as tmp:
            freeze = create_final_freeze(**make_fixture(Path(tmp))["freeze_args"])
            with self.assertRaises(FinalContractError):
                _select_from_recorded_event(freeze, entropy_event("a1" * 32, "2026-10-06T23:59:59Z"))
            altered = dict(freeze)
            altered["profiles"] = [dict(row, noise_cp=row["noise_cp"] + 1) for row in freeze["profiles"]]
            with self.assertRaises(FinalContractError):
                verify_final_selection(altered, _select_from_recorded_event(
                    freeze, entropy_event("a1" * 32, "2026-10-07T00:01:00Z")))

    def test_selection_rejects_tampering_and_source_component_leakage(self):
        with tempfile.TemporaryDirectory() as tmp:
            freeze = create_final_freeze(**make_fixture(Path(tmp))["freeze_args"])
            selection = _create_registered_selection(
                freeze, Path(tmp) / "selection", entropy_event("a1" * 32, "2026-10-07T00:01:00Z"))
            changed = json.loads(json.dumps(selection))
            changed["openings"][0]["source_group_sha256"] = "f" * 64
            with self.assertRaises(FinalContractError):
                verify_final_selection(freeze, changed)

    def test_final_audit_requires_all_eight_independently_audited_batches(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = make_fixture(Path(tmp))
            freeze = create_final_freeze(**fixture["freeze_args"])
            selection = _create_registered_selection(
                freeze, Path(tmp) / "selection", entropy_event("a1" * 32, "2026-10-07T00:01:00Z"))
            with self.assertRaises(FinalContractError):
                audit_final_series(freeze, selection, {})

    def test_selection_artifacts_are_runner_compatible_and_never_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = make_fixture(Path(tmp))
            freeze = create_final_freeze(**fixture["freeze_args"])
            selection = _create_registered_selection(
                freeze, Path(tmp) / "selection", entropy_event("a1" * 32, "2026-10-07T00:01:00Z"))
            paths = {"jsonl_path": str(Path(tmp) / "selection/selected-openings.jsonl"),
                     "tsv_path": str(Path(tmp) / "selection/selected-openings.tsv")}
            self.assertEqual(len(Path(paths["jsonl_path"]).read_text().splitlines()), 50)
            self.assertEqual(Path(paths["tsv_path"]).read_text().splitlines()[0],
                             "opening_id\tsource_ref\ticcs_prefix")
            with self.assertRaises(FinalContractError):
                write_final_selection(selection, Path(tmp) / "selection")

    def test_final_series_rejects_synthetic_rows_that_do_not_start_with_frozen_prefix(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture = make_fixture(root)
            freeze = create_final_freeze(**fixture["freeze_args"])
            selection = _create_registered_selection(
                freeze, root / "selection", entropy_event("a1" * 32, "2026-10-07T00:01:00Z"))
            batch_dirs = {}
            for lower in range(1, 9):
                batch_dirs[lower] = make_final_batch(root / f"pair-{lower}", freeze, selection, lower)
            manifest_path = batch_dirs[1] / "run-manifest.json"
            original_manifest = manifest_path.read_text(encoding="utf-8")
            changed_manifest = json.loads(original_manifest)
            changed_manifest["engine_options"] = dict(BASELINE_OPTIONS, NullMove="true")
            manifest_path.write_text(json.dumps(changed_manifest), encoding="utf-8")
            with self.assertRaises(FinalContractError):
                audit_final_series(freeze, selection, batch_dirs)
            manifest_path.write_text(original_manifest, encoding="utf-8")
            with self.assertRaisesRegex(DifficultyMatchError, "move sequence does not start with the frozen prefix"):
                audit_final_series(freeze, selection, batch_dirs)


def entropy_event(value, observed_at):
    return {"entropy_hex": value, "event_id": "external-event-001",
            "source": "recorded entropy for synthetic test only", "observed_at": observed_at}


DRAW_CYCLE = ["h0g2", "h9g7", "g2h0", "g7h9"] * 2


def make_final_batch(output, freeze, selection, lower_level):
    """Build a synthetic, replayable draw batch; never represents real matches."""
    from pathlib import Path

    def read_jsonl(path):
        return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line]

    output.mkdir(parents=True)
    openings = selection["openings"]
    identity = {"freeze_sha256": freeze["freeze_sha256"],
                "selection_sha256": selection["selection_sha256"]}
    rows = schedule_pair(openings, lower_level=lower_level,
                         master_seed=freeze["runtime"]["master_seed"], run_kind="final")
    games = []
    worker_logs = {worker: {actor: [] for actor in ("A", "B")}
                   for worker in range(1, WORKERS + 1)}
    batch_context = {
        "schema": "m5-difficulty-raw-v1", "run_kind": "final",
        "lower_level": lower_level, "higher_level": lower_level + 2,
        "master_seed": freeze["runtime"]["master_seed"], "seed_scheme": SEED_SCHEME,
        "opening_set_sha256": _opening_set_digest(openings),
        "final_contract_identity": identity,
    }
    for worker in range(1, WORKERS + 1):
        for actor in ("A", "B"):
            worker_logs[worker][actor].append(
                "context: batch " + json.dumps(batch_context, sort_keys=True, separators=(",", ":")))

    for index, base in enumerate(rows):
        game = dict(base)
        game.update({"moves": list(DRAW_CYCLE), "nodes": 100000, "max_ply": MAX_PLY,
                     "master_seed": freeze["runtime"]["master_seed"],
                     "terminal_outcome": "draw", "terminal_raw": ["info string outcome draw"],
                     "result_for_high": "draw", "unfinished_reason": None,
                     "protocol_error": None})
        game["decision_trace"] = [
            _decision_trace_entry(game, absolute_ply, decision_index)
            for decision_index, absolute_ply in enumerate(range(len(DRAW_CYCLE) + 1))
        ]
        games.append(game)
        worker = index % WORKERS + 1
        for actor, level in (("A", game["high_level"]), ("B", game["low_level"])):
            log = worker_logs[worker][actor]
            log.extend(f"stdin: setoption name {name} value {value}"
                       for name, value in {**BASELINE_OPTIONS, "DifficultyLevel": str(level)}.items())
        for decision in game["decision_trace"]:
            actor = decision["actor"]
            log = worker_logs[worker][actor]
            log.append(f"context: game_id={game['game_id']} actor={actor} decision_index={decision['decision_index']}")
            log.append(f"stdin: setoption name RandomSeed value {decision['random_seed']}")
            position = DRAW_CYCLE[:decision["decision_index"]]
            log.append("stdin: position startpos moves " + " ".join(position))
            log.append("stdin: go nodes 100000")
            if decision["decision_index"] == len(DRAW_CYCLE):
                log.append("stdout: info string outcome draw")
                log.append("stdout: bestmove 0000")
            else:
                move = DRAW_CYCLE[decision["decision_index"]]
                log.append(f"stdout: info string difficulty-selected {move} level {decision['level']}")
                log.append(f"stdout: bestmove {move}")

    engine = freeze["engine"]
    manifest = {
        "schema": "m5-difficulty-pair-v1", "status": "awaiting_independent_game_and_raw_audit",
        "run_kind": "final", "lower_level": lower_level, "higher_level": lower_level + 2,
        "opening_count": len(openings), "requested_games": 100, "observed_games": len(games),
        "caller_nodes": 100000, "max_ply": MAX_PLY, "workers": WORKERS,
        "engine_timeout_seconds": 30.0, "master_seed": freeze["runtime"]["master_seed"],
        "seed_scheme": SEED_SCHEME, "engine_options": BASELINE_OPTIONS,
        "opening_source_groups": sorted({row["source_group_sha256"] for row in openings}),
        "pilot_source_groups": sorted({row["source_pgn_sha256"] for row in
                                         read_jsonl(freeze["pilot_selection"]["path"])}),
        "opening_set_sha256": _opening_set_digest(openings),
        "pilot_source_groups_sha256": hashlib.sha256("\n".join(sorted(
            {row["source_pgn_sha256"] for row in read_jsonl(freeze["pilot_selection"]["path"])}
        )).encode()).hexdigest(),
        "engine": {"command": engine["path"], "path": engine["path"], "sha256": engine["sha256"]},
        "final_contract_identity": identity,
    }
    (output / "run-manifest.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
    (output / "games.jsonl").write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in games))
    workers_root = output / "workers"
    workers_root.mkdir()
    for worker, actors in worker_logs.items():
        worker_root = workers_root / f"worker-{worker:02d}"
        worker_root.mkdir()
        for actor, lines in actors.items():
            (worker_root / f"engine-{actor.lower()}.log").write_text("\n".join(lines) + "\n")
    summary = apply_run_kind_gate(aggregate_pair(games, openings, lower_level=lower_level,
                                                 run_kind="final"), "final")
    (output / "summary.json").write_text(json.dumps(summary, sort_keys=True, indent=2) + "\n")
    return output


def make_fixture(root):
    repo = root / "candidate"
    repo.mkdir(parents=True)
    source_root = Path(__file__).resolve().parents[4]
    (repo / "crates/xq-engine/src").mkdir(parents=True)
    shutil.copy2(source_root / "crates/xq-engine/src/difficulty.rs",
                 repo / "crates/xq-engine/src/difficulty.rs")
    (repo / "docs/research/m4-openings").mkdir(parents=True)
    for name in ("eligible-population.jsonl", "selected-50.jsonl"):
        shutil.copy2(source_root / "docs/research/m4-openings" / name,
                     repo / "docs/research/m4-openings" / name)
    import subprocess
    subprocess.run(["git", "-C", str(repo), "init", "-q"], check=True)
    subprocess.run(["git", "-C", str(repo), "add", "crates", "docs"], check=True)
    subprocess.run(["git", "-C", str(repo), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                    "commit", "-qm", "freeze canonical candidate"], check=True)
    binary = root / "xq-uci-fixture"
    binary.write_text("#!/bin/sh\ncat <<'UCI'\nid name test-fixture\noption name UCI_Variant type combo default xiangqi var xiangqi\noption name MultiPV type spin default 1 min 1 max 16\noption name Strategy type combo default search var search var random var greedy var difficulty\noption name DifficultyLevel type spin default 10 min 1 max 10\noption name RandomSeed type spin default 1 min 0 max 18446744073709551615\noption name RootAlpha type check default true\noption name CheckExtensions type check default true\noption name KillerHistoryOrdering type check default true\nuciok\nUCI\n", encoding="utf-8")
    binary.chmod(0o755)
    population_path = repo / "docs/research/m4-openings/eligible-population.jsonl"
    pilot_path = repo / "docs/research/m4-openings/selected-50.jsonl"
    profiles = parse_profile_table(repo / "crates/xq-engine/src/difficulty.rs")
    from difficulty_match import BASELINE_OPTIONS
    args = {"source_repo": repo, "binary_path": binary,
            "profile_path": repo / "crates/xq-engine/src/difficulty.rs",
            "eligible_path": population_path, "pilot_path": pilot_path,
            "engine_options": dict(BASELINE_OPTIONS), "master_seed": 271828182,
            "freeze_time": "2026-10-07T00:00:00Z",
            "binary_build_source_head": subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"],
                                                       check=True, capture_output=True, text=True).stdout.strip()}
    pilot = [json.loads(line) for line in pilot_path.read_text(encoding="utf-8").splitlines()]
    return {"freeze_args": args, "profiles": profiles, "engine_options": BASELINE_OPTIONS,
            "pilot_openings": pilot}


if __name__ == "__main__":
    unittest.main()
