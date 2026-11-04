import sys
import hashlib
import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import match

ROOT = Path(__file__).parents[2]


class M5IntegrationGateTests(unittest.TestCase):
    def test_integrated_nonregression_gate_uses_200_game_score_and_never_promotes_audit(self):
        passed = match.integration_nonregression_gate(
            {"win": 80, "draw": 20, "loss": 100, "unfinished": 0}, requested_games=200,
            protocol_verified=True,
        )
        self.assertEqual(passed, {
            "complete": True, "finished_games": 200, "unfinished_games": 0,
            "score_mean": 0.45, "minimum_score_mean": 0.45,
            "score_threshold_met": True, "provisional_pass": True,
            "formal_decision_ready": False, "formal_status": "await_raw_game_audit",
        })
        failed = match.integration_nonregression_gate(
            {"win": 79, "draw": 21, "loss": 100, "unfinished": 0}, requested_games=200,
            protocol_verified=True,
        )
        self.assertTrue(failed["score_threshold_met"] is False)
        self.assertFalse(failed["provisional_pass"])
        self.assertEqual(failed["score_mean"], 0.4475)

    def test_incomplete_or_unverified_integration_run_never_passes(self):
        for totals, requested, verified in (
            ({"win": 100, "draw": 0, "loss": 99, "unfinished": 1}, 200, True),
            ({"win": 100, "draw": 0, "loss": 99, "unfinished": 0}, 200, True),
            ({"win": 100, "draw": 0, "loss": 100, "unfinished": 0}, 200, False),
        ):
            gate = match.integration_nonregression_gate(
                totals, requested_games=requested, protocol_verified=verified,
            )
            self.assertFalse(gate["provisional_pass"])
            self.assertFalse(gate["formal_decision_ready"])

    def test_product_provenance_checks_real_git_source_core_and_build_proof_bytes(self):
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        core = subprocess.check_output(["git", "show", f"{head}:crates/xq-engine/src/lib.rs"], cwd=ROOT)
        core_sha = hashlib.sha256(core).hexdigest()
        with tempfile.TemporaryDirectory(dir=ROOT / ".scratch") as temp:
            proof = Path(temp) / "build-proof.txt"
            proof.write_bytes(b"frozen build command and exit evidence\n")
            proof_sha = hashlib.sha256(proof.read_bytes()).hexdigest()
            verified = match.validate_product_provenance(
                repo_root=ROOT, source_head=head, expected_core_sha256=core_sha,
                build_proof=proof, expected_build_proof_sha256=proof_sha,
            )
            self.assertEqual(verified["source_head"], head)
            self.assertEqual(verified["core_sha256"], core_sha)
            self.assertEqual(verified["build_proof_sha256"], proof_sha)
            self.assertEqual(verified["validation_status"], "external_preflight_required")
            for source_head, expected_core, proof_path, expected_proof, message in (
                ("x", core_sha, proof, proof_sha, "40-character"),
                ("f" * 40, core_sha, proof, proof_sha, "absent from this repository"),
                (head, "x", proof, proof_sha, "64-character"),
                (head, "0" * 64, proof, proof_sha, "core SHA-256 mismatch"),
                (head, core_sha, Path(temp) / "absent", proof_sha, "proof file does not exist"),
                (head, core_sha, proof, "0" * 64, "build proof SHA-256 mismatch"),
            ):
                with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                    match.validate_product_provenance(
                        repo_root=ROOT, source_head=source_head, expected_core_sha256=expected_core,
                        build_proof=proof_path, expected_build_proof_sha256=expected_proof,
                    )

    def test_cli_rejects_core_pin_mismatch_before_starting_any_match(self):
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        core = subprocess.check_output(["git", "show", f"{head}:crates/xq-engine/src/lib.rs"], cwd=ROOT)
        core_sha = hashlib.sha256(core).hexdigest()
        with tempfile.TemporaryDirectory(dir=ROOT / ".scratch") as temp:
            root = Path(temp)
            engine_a = root / "a"
            engine_b = root / "b"
            engine_a.write_bytes(b"engine a\n")
            engine_b.write_bytes(b"engine b\n")
            proof = root / "build-proof"
            proof.write_bytes(b"proof\n")
            engine_a.chmod(0o755)
            engine_b.chmod(0o755)
            args = [
                "match.py", "--engine-a", str(engine_a), "--engine-b", str(engine_b),
                "--openings", str(ROOT / "docs/research/m4-openings/selected-50.tsv"),
                "--selection-protocol", str(ROOT / "docs/research/m4-openings/opening-selection-protocol.json"),
                "--nodes", "10000", "--games", "200", "--global-round-start", "1",
                "--global-round-count", "2", "--max-ply", "4096", "--engine-timeout", "30",
                "--workers", "4", "--strategy-a", "search", "--strategy-b", "search",
                "--engine-a-options", '{"CheckExtensions":"true","KillerHistoryOrdering":"true","RootAlpha":"true"}',
                "--engine-b-options", '{"CheckExtensions":"true","RootAlpha":"true"}',
                "--experiment", "integration-nonregression", "--seed", "1", "--look", "1",
                "--expected-engine-a-sha256", hashlib.sha256(engine_a.read_bytes()).hexdigest(),
                "--expected-engine-b-sha256", hashlib.sha256(engine_b.read_bytes()).hexdigest(),
                "--product-source-head", head, "--product-core-sha256", core_sha,
                "--product-build-proof", str(proof), "--expected-product-build-proof-sha256",
                hashlib.sha256(proof.read_bytes()).hexdigest(), "--output", str(root / "run"),
            ]
            for flag, value in (("--product-core-sha256", "0" * 64),
                                ("--expected-product-build-proof-sha256", "0" * 64)):
                invocation = list(args)
                invocation[invocation.index(flag) + 1] = value
                invocation[invocation.index("--output") + 1] = str(root / f"run-{flag[2:]}")
                with self.subTest(flag=flag), patch.object(sys, "argv", invocation), patch.object(
                    match, "run_games_in_workers", side_effect=AssertionError("match must not start"),
                ), self.assertRaisesRegex(SystemExit, "2"):
                    match.main()
                self.assertFalse((root / f"run-{flag[2:]}").exists())

    def test_cli_with_valid_provenance_stays_provisional_without_audit_receipt(self):
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        core = subprocess.check_output(["git", "show", f"{head}:crates/xq-engine/src/lib.rs"], cwd=ROOT)
        core_sha = hashlib.sha256(core).hexdigest()
        openings = (ROOT / "docs/research/m4-openings/selected-50.tsv").read_text().splitlines()[1:]
        with tempfile.TemporaryDirectory(dir=ROOT / ".scratch") as temp:
            root = Path(temp)
            engine_a, engine_b, proof = root / "a", root / "b", root / "proof"
            engine_a.write_bytes(b"synthetic engine A")
            engine_b.write_bytes(b"synthetic engine B")
            proof.write_bytes(b"synthetic frozen build proof")
            for executable in (engine_a, engine_b):
                executable.chmod(0o755)
            totals = {"win": 90, "draw": 0, "loss": 110, "unfinished": 0}
            pairs = {}
            for round_number in (1, 2):
                for index, row in enumerate(openings):
                    opening_id = row.split("\t", 1)[0]
                    result = "win" if (round_number - 1) * 50 + index < 45 else "loss"
                    pairs[(round_number, opening_id)] = {"red": result, "black": result}
            args = [
                "match.py", "--engine-a", str(engine_a), "--engine-b", str(engine_b),
                "--openings", str(ROOT / "docs/research/m4-openings/selected-50.tsv"),
                "--selection-protocol", str(ROOT / "docs/research/m4-openings/opening-selection-protocol.json"),
                "--nodes", "10000", "--games", "200", "--global-round-start", "1",
                "--global-round-count", "2", "--max-ply", "4096", "--engine-timeout", "30",
                "--workers", "4", "--strategy-a", "search", "--strategy-b", "search",
                "--engine-a-options", '{"CheckExtensions":"true","KillerHistoryOrdering":"true","RootAlpha":"true"}',
                "--engine-b-options", '{"CheckExtensions":"true","RootAlpha":"true"}',
                "--experiment", "integration-nonregression", "--seed", "1", "--look", "1",
                "--expected-engine-a-sha256", hashlib.sha256(engine_a.read_bytes()).hexdigest(),
                "--expected-engine-b-sha256", hashlib.sha256(engine_b.read_bytes()).hexdigest(),
                "--product-source-head", head, "--product-core-sha256", core_sha,
                "--product-build-proof", str(proof), "--expected-product-build-proof-sha256",
                hashlib.sha256(proof.read_bytes()).hexdigest(), "--output", str(root / "run"),
            ]
            with patch.object(sys, "argv", args), patch.object(
                match, "run_games_in_workers", return_value=(200, totals, pairs),
            ), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(match.main(), 0)
            summary = json.loads((root / "run/summary.json").read_text())
            self.assertTrue(summary["integration_nonregression_gate"]["provisional_pass"])
            self.assertFalse(summary["integration_nonregression_gate"]["formal_decision_ready"])
            self.assertEqual(summary["decision_status"], "await_raw_game_audit")
            manifest = json.loads((root / "run/run-manifest.json").read_text())
            self.assertEqual(manifest["product_provenance"]["validation_status"], "external_preflight_required")
            self.assertEqual(manifest["product_provenance"]["build_proof_sha256"],
                             hashlib.sha256(proof.read_bytes()).hexdigest())

    def test_integration_profile_rejects_wrong_options_and_identical_or_unpinned_binaries(self):
        selection = {"full_selected_sample": True, "frozen_protocol_verified": True}
        valid = dict(
            strategy_a="search", strategy_b="search", games=200, nodes=10000,
            global_round_start=1, global_round_count=2, seed=1, max_ply=4096,
            workers=4, engine_timeout=30.0,
            options_a={"CheckExtensions": "true", "KillerHistoryOrdering": "true", "RootAlpha": "true"},
            options_b={"CheckExtensions": "true", "RootAlpha": "true"},
            actual_a="a" * 64, actual_b="b" * 64, expected_a="a" * 64, expected_b="b" * 64,
            selection=selection,
        )
        match.validate_integration_nonregression_profile(**valid)
        for changed, message in (
            ({"expected_a": "b" * 64}, "pin"),
            ({"actual_a": "b" * 64, "actual_b": "a" * 64}, "pin"),
            ({"actual_b": "a" * 64, "expected_b": "a" * 64}, "distinct"),
            ({"options_a": {"CheckExtensions": "true", "RootAlpha": "true"}}, "options"),
            ({"options_b": {"CheckExtensions": "true", "KillerHistoryOrdering": "true", "RootAlpha": "true"}}, "options"),
            ({"strategy_b": "greedy"}, "search-v-search"),
            ({"global_round_start": 3}, "rounds"),
            ({"games": 198}, "games=200"),
            ({"selection": {"full_selected_sample": False, "frozen_protocol_verified": True}}, "frozen"),
        ):
            candidate = {**valid, **changed}
            with self.subTest(changed=changed), self.assertRaisesRegex(ValueError, message):
                match.validate_integration_nonregression_profile(**candidate)

    def test_final_kh_baseline_has_separate_explicit_profile(self):
        self.assertEqual(match.baseline_profile_options("final-ra-ce"),
                         {"CheckExtensions": "true", "RootAlpha": "true"})
        self.assertEqual(match.baseline_profile_options("final-ra-ce-kh"),
                         {"CheckExtensions": "true", "KillerHistoryOrdering": "true", "RootAlpha": "true"})


if __name__ == "__main__":
    unittest.main()
