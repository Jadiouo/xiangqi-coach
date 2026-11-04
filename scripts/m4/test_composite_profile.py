"""Behavioral contract for the two-sample RootAlpha + CheckExtensions profile."""

import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
import hashlib
import shutil
import subprocess
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from match import (
    COMPOSITE_BINARY_SHA256,
    validate_composite_profile,
    validate_composite_prior_look,
    search_ab_options,
)

PINNED_SOURCE_FIXTURE = Path(__file__).parent / "fixtures" / "future-opening-source"


class CompositeProfileTests(unittest.TestCase):
    def test_composite_experiment_has_only_the_predeclared_option_pair(self):
        self.assertEqual(
            search_ab_options("composite-root-alpha-check-extensions"),
            (
                {"RootAlpha": "true", "CheckExtensions": "true"},
                {"RootAlpha": "false", "CheckExtensions": "false"},
            ),
        )

    def test_future_look_adapter_uses_sampler_verifier_and_exact_look_tsv(self):
        from future_opening_adapter import verify_future_opening_look
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = root / "selection-manifest.json"
            candidate_lock = root / "candidate-lock.json"
            repo_root = root / "repo"
            repo_root.mkdir()
            candidate_lock.write_text("{}", encoding="utf-8")
            look1 = root / "look1.tsv"
            look2 = root / "look2.tsv"
            header = "opening_id\tsource_ref\ticcs_prefix\n"
            content1 = header + "".join(
                f"first-{i:02}\tsrc-{i:02}\th2e2 h9g7 h0g2 h9g7\n" for i in range(50)
            )
            content2 = header + "".join(
                f"second-{i:02}\tsrc-{i:02}\th2e2 h9g7 h0g2 h9g7\n" for i in range(50)
            )
            look1.write_text(content1, encoding="utf-8")
            look2.write_text(content2, encoding="utf-8")
            manifest_path.write_text(json.dumps({
                "schema": "m4-future-opening-selection-v1",
                "candidate": {
                    "git_repo_path": str(repo_root),
                    "lock_path": str(candidate_lock),
                    "git_head": "4a8a21aa111516124eada56eb37a5224a1e8fe87",
                    "binary_sha256": "2ee963e53eae374c93725021873949f338df6cc2d229325e3846c62ccf08b426",
                },
                "registration": {"source_repo_root": str(repo_root)},
                "output_paths": {"look1": look1.name, "look2": look2.name},
                "output_sha256": {
                    "look1.tsv": hashlib.sha256(content1.encode()).hexdigest(),
                    "look2.tsv": hashlib.sha256(content2.encode()).hexdigest(),
                },
                "look_counts": {
                    "look1_openings": 50,
                    "look2_openings": 50,
                    "union_openings": 100,
                    "games_per_look": 200,
                },
                "preregistration_sha256": "synthetic-lock",
            }), encoding="utf-8")

            calls = []
            fake = types.ModuleType("future_openings")
            def verify(repo, lock, manifest):
                calls.append((Path(repo), Path(lock), Path(manifest)))
                return {
                    "status": "locked-before-games", "opening_count": 100,
                    "preregistration_sha256": "synthetic-lock",
                }
            fake.verify = verify
            old = sys.modules.get("future_openings")
            sys.modules["future_openings"] = fake
            try:
                verified = verify_future_opening_look(manifest_path, look1, 1)
            finally:
                if old is None:
                    del sys.modules["future_openings"]
                else:
                    sys.modules["future_openings"] = old

            self.assertEqual(calls, [(repo_root, candidate_lock, manifest_path)])
            self.assertTrue(verified["full_selected_sample"])
            self.assertEqual(verified["population_size"], 153)
            self.assertEqual(verified["selected_count"], 50)
            self.assertEqual(verified["look"], 1)
            self.assertEqual(verified["ordered_sample_count"], 100)

    def test_future_look_adapter_uses_registration_source_repo_not_candidate_repo(self):
        import future_openings
        import future_opening_adapter
        from future_opening_adapter import verify_future_opening_look

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sampler_repo = root / "sampler-repo"
            shutil.copytree(PINNED_SOURCE_FIXTURE / "docs", sampler_repo / "docs")
            subprocess.run(["git", "init", "-q", str(sampler_repo)], check=True)
            subprocess.run(["git", "-C", str(sampler_repo), "config", "user.name", "Test"], check=True)
            subprocess.run(["git", "-C", str(sampler_repo), "config", "user.email", "test@example.invalid"], check=True)
            subprocess.run(["git", "-C", str(sampler_repo), "add", "docs"], check=True)
            subprocess.run(["git", "-C", str(sampler_repo), "commit", "-qm", "freeze pinned source fixture"], check=True)

            candidate_repo = root / "candidate-repo"
            candidate_repo.mkdir()
            subprocess.run(["git", "init", "-q", str(candidate_repo)], check=True)
            subprocess.run(["git", "-C", str(candidate_repo), "config", "user.name", "Test"], check=True)
            subprocess.run(["git", "-C", str(candidate_repo), "config", "user.email", "test@example.invalid"], check=True)
            config = candidate_repo / "crates/xq-engine/src/lib.rs"
            config.parent.mkdir(parents=True)
            config.write_text("// synthetic test candidate config\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(candidate_repo), "add", "crates"], check=True)
            subprocess.run(["git", "-C", str(candidate_repo), "commit", "-qm", "freeze synthetic candidate"], check=True)
            candidate_head = subprocess.check_output(
                ["git", "-C", str(candidate_repo), "rev-parse", "HEAD"], text=True
            ).strip()
            candidate_binary = root / "test-engine.bin"
            candidate_binary.write_bytes(b"synthetic test-only engine; never executed")
            candidate_binary_sha = hashlib.sha256(candidate_binary.read_bytes()).hexdigest()
            candidate_lock = root / "candidate-lock.json"
            candidate_lock.write_text(json.dumps({
                "schema": "m4-future-opening-candidate-lock-v1", "status": "locked",
                "git_repo_path": str(candidate_repo),
                "git_head": candidate_head,
                "binary_path": str(candidate_binary),
                "binary_sha256": candidate_binary_sha,
                "config_path": "crates/xq-engine/src/lib.rs",
                "config_sha256": hashlib.sha256(config.read_bytes()).hexdigest(),
            }), encoding="utf-8")
            output = root / "sample-output"
            future_openings.generate(sampler_repo, candidate_lock, output)
            manifest = output / "selection-manifest.json"
            look1 = output / "look1.tsv"

            self.assertNotEqual(sampler_repo.resolve(), candidate_repo.resolve())
            # The production adapter remains pinned to the reviewed real candidate;
            # only this isolated end-to-end test substitutes its synthetic lock identity.
            self.assertEqual(
                future_opening_adapter.EXPECTED_CANDIDATE_HEAD,
                "4a8a21aa111516124eada56eb37a5224a1e8fe87",
            )
            self.assertEqual(
                future_opening_adapter.EXPECTED_CANDIDATE_BINARY_SHA256,
                "2ee963e53eae374c93725021873949f338df6cc2d229325e3846c62ccf08b426",
            )
            with patch.object(future_opening_adapter, "EXPECTED_CANDIDATE_HEAD", candidate_head), patch.object(
                future_opening_adapter, "EXPECTED_CANDIDATE_BINARY_SHA256", candidate_binary_sha
            ):
                verified = verify_future_opening_look(manifest, look1, 1)
            self.assertEqual(verified["opening_ids"].__len__(), 50)
            self.assertEqual(verified["manifest_path"], str(manifest.resolve()))

    def test_future_look_adapter_rejects_a_tsv_from_the_other_half(self):
        from future_opening_adapter import verify_future_opening_look
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = root / "selection-manifest.json"
            lock = root / "candidate-lock.json"
            repo = root / "repo"
            repo.mkdir()
            lock.write_text("{}", encoding="utf-8")
            (root / "look1.tsv").write_text("look one\n", encoding="utf-8")
            (root / "look2.tsv").write_text("look two\n", encoding="utf-8")
            manifest_path.write_text(json.dumps({
                "schema": "m4-future-opening-selection-v1",
                "candidate": {
                    "git_repo_path": str(repo), "lock_path": str(lock),
                    "git_head": "4a8a21aa111516124eada56eb37a5224a1e8fe87",
                    "binary_sha256": "2ee963e53eae374c93725021873949f338df6cc2d229325e3846c62ccf08b426",
                },
                "registration": {"source_repo_root": str(repo)},
                "output_paths": {"look1": "look1.tsv", "look2": "look2.tsv"},
                "output_sha256": {"look1.tsv": "unused", "look2.tsv": "unused"},
                "look_counts": {
                    "look1_openings": 50,
                    "look2_openings": 50,
                    "union_openings": 100,
                    "games_per_look": 200,
                },
                "preregistration_sha256": "synthetic-lock",
            }), encoding="utf-8")
            tsv = root / "runner.tsv"
            tsv.write_text("look two\n", encoding="utf-8")

            fake = types.ModuleType("future_openings")
            fake.verify = lambda *_: {
                "status": "locked-before-games", "opening_count": 100,
                "preregistration_sha256": "synthetic-lock",
            }
            old = sys.modules.get("future_openings")
            sys.modules["future_openings"] = fake
            try:
                with self.assertRaisesRegex(ValueError, "does not match look 1"):
                    verify_future_opening_look(manifest_path, tsv, 1)
            finally:
                if old is None:
                    del sys.modules["future_openings"]
                else:
                    sys.modules["future_openings"] = old

    def test_composite_protocol_locks_each_look_and_the_shared_immutable_binary(self):
        selection = {
            "future_openings_verified": True,
            "population_size": 153,
            "selected_count": 50,
            "ordered_sample_count": 100,
            "look": 1,
        }
        base = dict(
            look=1, global_round_start=1, global_round_count=2, games=200,
            nodes=10000, max_ply=4096, seed=1, workers=4, engine_timeout=30.0,
            engine_a_options={"RootAlpha": "true", "CheckExtensions": "true"},
            engine_b_options={"RootAlpha": "false", "CheckExtensions": "false"},
            engine_a_sha256=COMPOSITE_BINARY_SHA256,
            engine_b_sha256=COMPOSITE_BINARY_SHA256, selection=selection,
        )
        validate_composite_profile(**base)
        look2_selection = dict(selection, look=2)
        validate_composite_profile(
            **dict(base, look=2, global_round_start=3, selection=look2_selection)
        )
        rejected = (
            ("look", 3), ("global_round_start", 2), ("nodes", 1),
            ("games", 198), ("workers", 1), ("engine_timeout", 29.0),
            ("engine_a_sha256", "different-binary"),
            ("engine_b_options", {"RootAlpha": "false"}),
            ("selection", dict(selection, population_size=203)),
            ("selection", dict(selection, look=2)),
        )
        for field, value in rejected:
            with self.subTest(field=field, value=value):
                with self.assertRaises(ValueError):
                    validate_composite_profile(**dict(base, **{field: value}))

    def test_second_look_requires_audit_receipt_even_when_summary_claims_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            look1_ids = [f"first-{i:02}" for i in range(50)]
            current = {
                "future_openings_verified": True, "population_size": 153,
                "selected_count": 50, "ordered_sample_count": 100, "look": 2,
                "opening_ids": [f"second-{i:02}" for i in range(50)],
                "selection_manifest_sha256": "same-selection-lock",
                "manifest_sha256": "selection-manifest-file-sha",
            }
            manifest = {
                "experiment": "composite-root-alpha-check-extensions", "look": 1,
                "global_rounds": [1, 2], "requested_games": 200,
                "nodes_per_move": 10000, "max_ply": 4096, "master_seed": 1,
                "workers": 4, "engine_timeout_seconds": 30.0,
                "engine_a_options": {"RootAlpha": "true", "CheckExtensions": "true"},
                "engine_b_options": {"RootAlpha": "false", "CheckExtensions": "false"},
                "strategy_a": "search", "strategy_b": "search",
                "candidate_side": "A", "baseline_side": "B",
                "engine_a_executable": {"sha256": COMPOSITE_BINARY_SHA256},
                "engine_b_executable": {"sha256": COMPOSITE_BINARY_SHA256},
                "future_selection_manifest_sha256": "selection-manifest-file-sha",
            }
            manifest_path = root / "run-manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            summary = {
                "experiment": "composite-root-alpha-check-extensions", "look": 1,
                "global_rounds": [1, 2], "requested_games": 200,
                "finished_games": 200, "unfinished_games": 0, "complete": True,
                "formal_decision_ready": True,
                "decision_97_5_score_interval": [0.4, 0.6],
                "decision_interval_method": "Hoeffding-Serfling Corollary 2.5",
                "selection_protocol": {
                    **current, "look": 1, "opening_ids": look1_ids,
                },
                "run_manifest_path": str(manifest_path),
                "run_manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
            }
            summary_path = root / "summary.json"
            summary_path.write_text(json.dumps(summary), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "audit receipt"):
                validate_composite_prior_look(summary_path, current)

            summary["decision_97_5_score_interval"] = [0.51, 0.8]
            summary_path.write_text(json.dumps(summary), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "audit receipt"):
                validate_composite_prior_look(summary_path, current)


if __name__ == "__main__":
    unittest.main()
