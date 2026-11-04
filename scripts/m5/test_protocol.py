import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sys
sys.path.insert(0, str(Path(__file__).parent))
import protocol


class M5ProtocolTests(unittest.TestCase):
    def test_profiles_map_to_real_uci_names_and_lock_multipv_one(self):
        self.assertEqual(protocol.M5_PROFILE_TARGETS, {
            "kh": "KillerHistoryOrdering", "nullmove": "NullMove", "lmr": "LateMoveReductions",
        })
        self.assertEqual(protocol.M5_COMMON_OPTIONS, {"MultiPV": "1"})
        baseline = protocol.option_map(protocol.BASELINE_FLAGS)
        candidate = dict(baseline, KillerHistoryOrdering="true")
        expected_baseline = dict(baseline, MultiPV="1")
        expected_candidate = dict(candidate, MultiPV="1")
        run = {"look": 1, "global_round_start": 1, "global_round_count": 2,
               "games": 200, "nodes": 10000, "seed": 1, "max_ply": 4096,
               "workers": 4, "engine_timeout": 30.0}
        self.assertTrue(protocol.validate_runner_profile("kh", run, expected_candidate, expected_baseline))
        with self.assertRaises(protocol.ProtocolError):
            protocol.validate_runner_profile("kh", run, candidate, baseline)

    def test_profile_baseline_and_each_candidate_changes_exactly_one_flag(self):
        self.assertEqual(protocol.BASELINE_FLAGS["RootAlpha"], True)
        self.assertEqual(protocol.BASELINE_FLAGS["CheckExtensions"], True)
        self.assertEqual(protocol.BASELINE_FLAGS["NullMove"], False)
        for target in protocol.TARGET_FLAGS:
            candidate = dict(protocol.BASELINE_FLAGS)
            candidate[target] = True
            self.assertTrue(protocol.validate_flag_pair(protocol.BASELINE_FLAGS, candidate, target))

    def test_rejects_multiple_differences_unknown_target_and_non_bool_values(self):
        candidate = dict(protocol.BASELINE_FLAGS)
        candidate["NullMove"] = True
        candidate["LateMoveReductions"] = True
        with self.assertRaises(protocol.ProtocolError):
            protocol.validate_flag_pair(protocol.BASELINE_FLAGS, candidate, "NullMove")
        with self.assertRaises(protocol.ProtocolError):
            protocol.validate_flag_pair(protocol.BASELINE_FLAGS, candidate, "RootAlpha")
        candidate["NullMove"] = "true"
        with self.assertRaises(protocol.ProtocolError):
            protocol.validate_flag_pair(protocol.BASELINE_FLAGS, candidate, "NullMove")
        ra_only = dict(protocol.BASELINE_FLAGS, RootAlpha=False)
        with self.assertRaises(protocol.ProtocolError):
            protocol.validate_flag_pair(protocol.BASELINE_FLAGS, ra_only, "RootAlpha")

    def test_lock_binds_candidate_identity_and_rejects_modified_config_binary_or_source(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            repo = base / "candidate"
            repo.mkdir()
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.name", "Fixture"], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.email", "fixture@example.invalid"], check=True)
            config = repo / "engine.json"
            config_data = {"candidate_id": "nullmove-a", "target": "NullMove",
                           "baseline_flags": protocol.BASELINE_FLAGS,
                           "candidate_flags": {**protocol.BASELINE_FLAGS, "NullMove": True},
                           "common_options": {"MultiPV": "2"}}
            config.write_text(json.dumps(config_data) + "\n")
            subprocess.run(["git", "-C", str(repo), "add", "engine.json"], check=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-qm", "freeze"], check=True)
            binary = base / "engine"
            binary.write_bytes(b"mock immutable binary")
            lock = {
                "schema": protocol.LOCK_SCHEMA, "status": "locked", "candidate_id": "nullmove-a",
                "target": "NullMove", "baseline_flags": protocol.BASELINE_FLAGS,
                "candidate_flags": {**protocol.BASELINE_FLAGS, "NullMove": True},
                "common_options": {"MultiPV": "2"},
                "git_repo_path": str(repo), "git_head": subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip(),
                "config_path": "engine.json", "config_sha256": protocol.sha(config),
                "binary_path": str(binary), "binary_sha256": protocol.sha(binary),
            }
            path = base / "lock.json"
            path.write_text(json.dumps(lock))
            with self.assertRaises(protocol.ProtocolError):
                protocol.verify_lock(path)
            config_data["common_options"] = {"MultiPV": "1"}
            config.write_text(json.dumps(config_data) + "\n")
            subprocess.run(["git", "-C", str(repo), "add", "engine.json"], check=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-qm", "pin common options"], check=True)
            lock["common_options"] = {"MultiPV": "1"}
            lock["git_head"] = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
            lock["config_sha256"] = protocol.sha(config)
            path.write_text(json.dumps(lock))
            verified = protocol.verify_lock(path)
            self.assertEqual(verified["candidate_id"], "nullmove-a")
            self.assertEqual(verified["binary_sha256"], hashlib.sha256(binary.read_bytes()).hexdigest())
            config.write_text(json.dumps({**config_data, "candidate_flags": protocol.BASELINE_FLAGS}) + "\n")
            with self.assertRaises(protocol.ProtocolError):
                protocol.verify_lock(path)
            config.write_text(json.dumps(config_data) + "\n")
            lock["config_sha256"] = protocol.sha(config)
            path.write_text(json.dumps(lock))
            binary.write_bytes(b"tampered binary")
            with self.assertRaises(protocol.ProtocolError):
                protocol.verify_lock(path)
            binary.write_bytes(b"synthetic binary bytes; never executed")
            (repo / "untracked.py").write_text("dirty\n")
            with self.assertRaises(protocol.ProtocolError):
                protocol.verify_lock(path)

    def test_look2_requires_a_valid_first_look_receipt_for_same_candidate_and_sample(self):
        first = {"schema": protocol.RECEIPT_SCHEMA, "status": "complete", "look": 1,
                 "candidate_id": "kh-a", "sample_sha256": "a" * 64,
                 "error_count": 0, "unfinished_games": 0, "game_count": 200,
                 "raw_replay_valid": True, "decision_interval": [0.49, 0.61]}
        self.assertTrue(protocol.authorize_look2(first, "kh-a", "a" * 64))
        for mutate in (
            {"candidate_id": "kh-b"}, {"sample_sha256": "b" * 64}, {"error_count": 1},
            {"unfinished_games": 1}, {"game_count": 199}, {"raw_replay_valid": False},
            {"decision_interval": [0.51, 0.7]}, {"look": 2},
        ):
            receipt = dict(first, **mutate)
            with self.subTest(mutate=mutate), self.assertRaises(protocol.ProtocolError):
                protocol.authorize_look2(receipt, "kh-a", "a" * 64)


    def test_m5_runner_profile_derives_exact_a_b_options_and_fixed_look_settings(self):
        baseline = protocol.runner_options(protocol.BASELINE_FLAGS)
        candidate = protocol.runner_options({**protocol.BASELINE_FLAGS, "NullMove": True})
        run = {"look": 1, "global_round_start": 1, "global_round_count": 2,
               "games": 200, "nodes": 10000, "seed": 1, "max_ply": 4096,
               "workers": 4, "engine_timeout": 30.0}
        self.assertTrue(protocol.validate_runner_profile("nullmove", run, candidate, baseline))
        with self.assertRaises(protocol.ProtocolError):
            protocol.validate_runner_profile("nullmove", run, candidate, dict(baseline, CheckExtensions="false"))
        with self.assertRaises(protocol.ProtocolError):
            protocol.validate_runner_profile("composite-root-alpha-check-extensions", run, candidate, baseline)
        with self.assertRaises(protocol.ProtocolError):
            protocol.validate_runner_profile("nullmove", dict(run, global_round_start=3), candidate, baseline)


    def test_candidate_specific_sample_sidecar_reuses_and_checks_sampler_verifier(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "m4"))
        from test_future_openings import FutureOpeningToolTests
        import future_openings
        fixture = FutureOpeningToolTests()
        fixture.setUp()
        try:
            candidate = fixture.candidate
            flags = {**protocol.BASELINE_FLAGS, "NullMove": True}
            config = {"candidate_id": "nullmove-a", "target": "NullMove",
                      "baseline_flags": protocol.BASELINE_FLAGS, "candidate_flags": flags,
                      "common_options": protocol.M5_COMMON_OPTIONS}
            candidate["config"].write_text(json.dumps(config) + "\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(candidate["repo"]), "add", "config.json"], check=True)
            subprocess.run(["git", "-C", str(candidate["repo"]), "commit", "-qm", "freeze M5 profile"], check=True)
            lock = {"schema": protocol.LOCK_SCHEMA, "status": "locked", "candidate_id": "nullmove-a",
                    "target": "NullMove", "baseline_flags": protocol.BASELINE_FLAGS, "candidate_flags": flags,
                    "common_options": protocol.M5_COMMON_OPTIONS,
                    "git_repo_path": str(candidate["repo"]),
                    "git_head": subprocess.check_output(["git", "-C", str(candidate["repo"]), "rev-parse", "HEAD"], text=True).strip(),
                    "config_path": "config.json", "config_sha256": protocol.sha(candidate["config"]),
                    "binary_path": str(candidate["binary"]), "binary_sha256": protocol.sha(candidate["binary"])}
            fixture.lock_path.write_text(json.dumps(lock), encoding="utf-8")
            output = fixture.root.parent / "m5-synthetic-sample"
            with patch.dict(future_openings.SOURCE_SHA256S, fixture.fixture_pins, clear=True):
                with patch.object(future_openings.secrets, "token_bytes", return_value=(1234).to_bytes(8, "big")):
                    future_openings.generate(fixture.root, fixture.lock_path, output)
                manifest = output / "selection-manifest.json"
                ordered = output / "ordered-100.jsonl"
                binding = protocol.bind_selection(fixture.lock_path, manifest, ordered)
                bound_path = fixture.root.parent / "m5-binding.json"
                bound_path.write_text(json.dumps(binding), encoding="utf-8")
                result = protocol.verify_runner_selection(fixture.lock_path, bound_path, manifest, output / "look1.tsv", 1, "nullmove")
                self.assertEqual(len(result["opening_ids"]), 50)
                self.assertEqual(result["candidate_id"], "nullmove-a")
                with self.assertRaises(protocol.ProtocolError):
                    protocol.verify_runner_selection(fixture.lock_path, bound_path, manifest, output / "look2.tsv", 1, "nullmove")
        finally:
            fixture.doCleanups()

    def test_two_look_auditor_uses_m5_combined_n100_and_rejects_sample_overlap(self):
        look1 = {f"o{i}": 1.0 for i in range(50)}
        look2 = {f"o{i}": 0.0 for i in range(50, 100)}
        result = protocol.combine_cluster_scores(look1, look2)
        self.assertEqual(result["cluster_count"], 100)
        self.assertEqual(result["population_size"], 153)
        self.assertEqual(result["score_mean"], 0.5)
        import math
        expected_radius = math.sqrt((1 - 99 / 153) * math.log(2 / .025) / 200)
        self.assertAlmostEqual(result["decision_97_5_hoeffding_serfling_score_interval"][0], 0.5 - expected_radius)
        with self.assertRaises(protocol.ProtocolError):
            protocol.combine_cluster_scores(look1, {**look2, "o0": 0.0})


if __name__ == "__main__":
    unittest.main()
