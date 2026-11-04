import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import shutil

sys.path.insert(0, str(Path(__file__).parent))
import future_openings as openings

PINNED_SOURCE_FIXTURE = Path(__file__).parent / "fixtures" / "future-opening-source"


class FutureOpeningToolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "project"
        self.root.mkdir()
        self._write_synthetic_population(self.root)
        self.fixture_pins = self._pin_fixture_sources(self.root)
        self.candidate = self._make_candidate(self.root.parent / "candidate")
        self.lock_path = self.root.parent / "candidate-lock.json"
        self._write_candidate_lock()

    def _write_synthetic_population(self, root, duplicate=False):
        source = root / "docs/research/m4-openings"
        future = root / "docs/research/m4-validation/future-opening-protocol"
        source.mkdir(parents=True, exist_ok=True)
        future.mkdir(parents=True, exist_ok=True)
        rows = [
            {
                "opening_id": f"synthetic-{index:03d}",
                "position_key": f"synthetic-position-{index:03d}",
                "fen": f"synthetic-fen-{index:03d}",
                "source_url": f"https://example.invalid/{index}",
                "iccs_prefix": "a0a1",
            }
            for index in range(203)
        ]
        if duplicate:
            rows[-1] = dict(rows[0])
        old = rows[:50]
        remaining = rows[50:]
        (source / "eligible-population.jsonl").write_text(self._jsonl(rows), encoding="utf-8")
        (source / "selected-50.jsonl").write_text(self._jsonl(old), encoding="utf-8")
        (source / "selected-50.tsv").write_text(
            "opening_id\tsource_ref\ticcs_prefix\n" + "".join(
                f"{row['opening_id']}\t{row['source_url']}\t{row['iccs_prefix']}\n" for row in old
            ), encoding="utf-8"
        )
        (future / "remaining-153.jsonl").write_text(self._jsonl(remaining), encoding="utf-8")
        original_hashes = {
            "eligible-population.jsonl": self._sha(source / "eligible-population.jsonl"),
            "selected-50.jsonl": self._sha(source / "selected-50.jsonl"),
            "selected-50.tsv": self._sha(source / "selected-50.tsv"),
        }
        (source / "opening-selection-protocol.json").write_text(json.dumps({
            "eligible_population_sha256": original_hashes["eligible-population.jsonl"],
            "selected_population_sha256": original_hashes["selected-50.jsonl"],
            "runner_tsv_sha256": original_hashes["selected-50.tsv"],
            "eligible_population_count": 203,
            "selected_count": 50,
        }), encoding="utf-8")
        original_hashes = {
            "eligible-population.jsonl": self._sha(source / "eligible-population.jsonl"),
            "selected-50.jsonl": self._sha(source / "selected-50.jsonl"),
            "selected-50.tsv": self._sha(source / "selected-50.tsv"),
            "opening-selection-protocol.json": self._sha(source / "opening-selection-protocol.json"),
        }
        (future / "protocol-proposal.md").write_text("Synthetic accepted protocol fixture.\n", encoding="utf-8")
        manifest = {
            "schema": "future-opening-remaining-v1",
            "status": "accepted future M5 protocol; review evidence only",
            "population_size": 153,
            "selection_executed": False,
            "source_files_sha256": original_hashes,
            "excluded_old_selected_count": 50,
            "entries_file": "remaining-153.jsonl",
            "entries_sha256": self._sha(future / "remaining-153.jsonl"),
            "current_protocol_sha256": self._sha(future / "protocol-proposal.md"),
        }
        (future / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        if not (root / ".git").exists():
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.name", "Test"], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.email", "test@example.invalid"], check=True)
            subprocess.run(["git", "-C", str(root), "add", "docs"], check=True)
            subprocess.run(["git", "-C", str(root), "commit", "-qm", "freeze synthetic source"], check=True)

    @staticmethod
    def _jsonl(rows):
        return "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows)

    @staticmethod
    def _sha(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def _pin_fixture_sources(self, root):
        self.fixture_pins = {
            "docs/research/m4-openings/eligible-population.jsonl": self._sha(root / "docs/research/m4-openings/eligible-population.jsonl"),
            "docs/research/m4-openings/selected-50.jsonl": self._sha(root / "docs/research/m4-openings/selected-50.jsonl"),
            "docs/research/m4-openings/selected-50.tsv": self._sha(root / "docs/research/m4-openings/selected-50.tsv"),
            "docs/research/m4-openings/opening-selection-protocol.json": self._sha(root / "docs/research/m4-openings/opening-selection-protocol.json"),
            "docs/research/m4-validation/future-opening-protocol/remaining-153.jsonl": self._sha(root / "docs/research/m4-validation/future-opening-protocol/remaining-153.jsonl"),
            "docs/research/m4-validation/future-opening-protocol/manifest.json": self._sha(root / "docs/research/m4-validation/future-opening-protocol/manifest.json"),
            "docs/research/m4-validation/future-opening-protocol/protocol-proposal.md": self._sha(root / "docs/research/m4-validation/future-opening-protocol/protocol-proposal.md"),
        }
        return dict(self.fixture_pins)

    def _new_synthetic_project(self, name):
        root = self.root.parent / name
        root.mkdir()
        self._write_synthetic_population(root)
        return root, self._pin_fixture_sources(root)

    def _generate_with_os_seed(self, root, lock_path, output_dir, seed, **kwargs):
        with patch.object(openings.secrets, "token_bytes", return_value=seed.to_bytes(8, "big")):
            return openings.generate(root, lock_path, output_dir, **kwargs)

    def _make_candidate(self, repo):
        repo.mkdir()
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.name", "Test"], check=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@example.invalid"], check=True)
        (repo / "config.json").write_text('{"nodes":10000}\n', encoding="utf-8")
        subprocess.run(["git", "-C", str(repo), "add", "config.json"], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-qm", "freeze candidate fixture"], check=True)
        binary = repo.parent / "fake-engine.bin"
        binary.write_bytes(b"synthetic binary bytes; never executed")
        return {
            "repo": repo,
            "head": subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip(),
            "binary": binary,
            "config": repo / "config.json",
        }

    def _write_candidate_lock(self, status="locked"):
        candidate = self.candidate
        lock = {
            "status": status,
            "git_repo_path": str(candidate["repo"]),
            "git_head": candidate["head"],
            "binary_path": str(candidate["binary"]),
            "binary_sha256": self._sha(candidate["binary"]),
            "config_path": "config.json",
            "config_sha256": self._sha(candidate["config"]),
        }
        self.lock_path.write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")

    def test_real_153_population_is_read_only_and_matches_pinned_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            source_root = Path(directory) / "source-repo"
            shutil.copytree(PINNED_SOURCE_FIXTURE / "docs", source_root / "docs")
            population = openings.verify_population(source_root)
        self.assertEqual(len(population), 153)
        self.assertEqual(len({row["opening_id"] for row in population}), 153)
        self.assertEqual(len({row["position_key"] for row in population}), 153)
        row = population[0]
        self.assertIn("iccs_prefix", row)
        self.assertTrue(row.get("source_pgn_url") or row.get("source_url"))
        self.assertTrue(openings._runner_tsv([row]).startswith(b"opening_id\tsource_ref\ticcs_prefix\n"))

    def test_same_seed_produces_ordered_100_and_two_disjoint_50s(self):
        with patch.dict(openings.SOURCE_SHA256S, self.fixture_pins, clear=True):
            first = self._generate_with_os_seed(self.root, self.lock_path, self.root.parent / "out-a", 987654321)
            second_root, second_pins = self._new_synthetic_project("second-project")
            with patch.dict(openings.SOURCE_SHA256S, second_pins, clear=True):
                second = self._generate_with_os_seed(second_root, self.lock_path, self.root.parent / "out-b", 987654321)
            verified = openings.verify(self.root, self.lock_path, self.root.parent / "out-a/selection-manifest.json")
        first_ids = [row["opening_id"] for row in first["ordered_openings"]]
        second_ids = [row["opening_id"] for row in second["ordered_openings"]]
        look1 = set(first_ids[:50])
        look2 = set(first_ids[50:])
        self.assertEqual(first_ids, second_ids)
        self.assertEqual(len(first_ids), 100)
        self.assertEqual(len(look1), 50)
        self.assertEqual(len(look2), 50)
        self.assertFalse(look1 & look2)
        self.assertEqual(look1 | look2, set(first_ids))
        self.assertEqual(verified["status"], "locked-before-games")

    def test_reproduction_uses_seed_from_a_verified_manifest(self):
        with patch.dict(openings.SOURCE_SHA256S, self.fixture_pins, clear=True):
            first = self._generate_with_os_seed(self.root, self.lock_path, self.root.parent / "original", 123456)
            second_root, second_pins = self._new_synthetic_project("reproduction-project")
            with patch.dict(openings.SOURCE_SHA256S, second_pins, clear=True):
                reproduced = openings.generate(
                    second_root,
                    self.lock_path,
                    self.root.parent / "reproduced",
                    reproduce_manifest=self.root.parent / "original/selection-manifest.json",
                )
        self.assertEqual(
            [row["opening_id"] for row in first["ordered_openings"]],
            [row["opening_id"] for row in reproduced["ordered_openings"]],
        )
        self.assertEqual(reproduced["manifest"]["seed_u64"], 123456)
        self.assertEqual(reproduced["manifest"]["seed_source"], "reproduced-manifest")

    def test_source_hash_mismatch_blocks_generation_before_output_exists(self):
        broken = self.root / "docs/research/m4-openings/selected-50.tsv"
        broken.write_text("wrong source\n", encoding="utf-8")
        target = self.root.parent / "must-not-exist"
        with patch.dict(openings.SOURCE_SHA256S, self.fixture_pins, clear=True):
            with patch.object(openings.secrets, "token_bytes", side_effect=AssertionError("seed read before provenance")):
                with self.assertRaises(openings.ProtocolError):
                    openings.generate(self.root, self.lock_path, target)
        self.assertFalse(target.exists())

    def test_duplicate_population_entries_are_rejected_even_with_matching_source_hashes(self):
        self._write_synthetic_population(self.root, duplicate=True)
        self.fixture_pins = self._pin_fixture_sources(self.root)
        with patch.dict(openings.SOURCE_SHA256S, self.fixture_pins, clear=True):
            with self.assertRaises(openings.ProtocolError):
                openings.verify_population(self.root)

    def test_unlocked_or_dirty_candidate_is_rejected(self):
        with patch.dict(openings.SOURCE_SHA256S, self.fixture_pins, clear=True):
            self._write_candidate_lock(status="draft")
            with self.assertRaises(openings.ProtocolError):
                self._generate_with_os_seed(self.root, self.lock_path, self.root.parent / "draft-out", 8)
            self._write_candidate_lock()
            (self.candidate["repo"] / "uncommitted.txt").write_text("dirty\n", encoding="utf-8")
            with self.assertRaises(openings.ProtocolError):
                self._generate_with_os_seed(self.root, self.lock_path, self.root.parent / "dirty-out", 8)

    def test_candidate_binary_and_head_must_match_the_locked_refs(self):
        with patch.dict(openings.SOURCE_SHA256S, self.fixture_pins, clear=True):
            self.candidate["binary"].write_bytes(b"replaced bytes")
            with self.assertRaises(openings.ProtocolError):
                self._generate_with_os_seed(self.root, self.lock_path, self.root.parent / "wrong-binary", 9)

            self.candidate["binary"].write_bytes(b"synthetic binary bytes; never executed")
            self._write_candidate_lock()
            lock = json.loads(self.lock_path.read_text(encoding="utf-8"))
            lock["git_head"] = "0" * 40
            self.lock_path.write_text(json.dumps(lock), encoding="utf-8")
            with self.assertRaises(openings.ProtocolError):
                self._generate_with_os_seed(self.root, self.lock_path, self.root.parent / "wrong-head", 9)

    def test_existing_output_path_is_never_overwritten(self):
        target = self.root.parent / "already-there"
        target.mkdir()
        marker = target / "keep.txt"
        marker.write_text("preserve\n", encoding="utf-8")
        with patch.dict(openings.SOURCE_SHA256S, self.fixture_pins, clear=True):
            with self.assertRaises(openings.ProtocolError):
                self._generate_with_os_seed(self.root, self.lock_path, target, 10)
        self.assertEqual(marker.read_text(encoding="utf-8"), "preserve\n")

    def test_verifier_rejects_tampered_or_missing_sampling_outputs(self):
        with patch.dict(openings.SOURCE_SHA256S, self.fixture_pins, clear=True):
            result = self._generate_with_os_seed(self.root, self.lock_path, self.root.parent / "valid-out", 11)
            manifest = self.root.parent / "valid-out/selection-manifest.json"
            missing = self.root.parent / "valid-out/look2.tsv"
            missing.unlink()
            with self.assertRaises(openings.ProtocolError):
                openings.verify(self.root, self.lock_path, manifest)

    def test_verifier_recomputes_seed_and_rejects_self_consistent_look_swap(self):
        with patch.dict(openings.SOURCE_SHA256S, self.fixture_pins, clear=True):
            self._generate_with_os_seed(self.root, self.lock_path, self.root.parent / "seed-swap", 2345)
            output = self.root.parent / "seed-swap"
            manifest_path = output / "selection-manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            rows = openings._read_jsonl(output / openings.OUTPUT_NAMES["ordered_openings"])
            rows[0], rows[50] = rows[50], rows[0]
            outputs = {
                openings.OUTPUT_NAMES["ordered_openings"]: openings._serialize_jsonl(rows),
                openings.OUTPUT_NAMES["look1"]: openings._runner_tsv(rows[:50]),
                openings.OUTPUT_NAMES["look2"]: openings._runner_tsv(rows[50:]),
            }
            for name, data in outputs.items():
                (output / name).write_bytes(data)
                manifest["output_sha256"][name] = hashlib.sha256(data).hexdigest()
            manifest.pop("preregistration_sha256")
            manifest["preregistration_sha256"] = openings._manifest_lock_hash(manifest)
            manifest_path.write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8")
            with self.assertRaises(openings.ProtocolError):
                openings.verify(self.root, self.lock_path, manifest_path)

    def test_verifier_rejects_out_of_range_seed_and_unsupported_algorithm(self):
        with patch.dict(openings.SOURCE_SHA256S, self.fixture_pins, clear=True):
            self._generate_with_os_seed(self.root, self.lock_path, self.root.parent / "invalid-meta", 6789)
            manifest_path = self.root.parent / "invalid-meta/selection-manifest.json"
            original = json.loads(manifest_path.read_text(encoding="utf-8"))
            for field, value in (("seed_u64", 2**64), ("algorithm", "random.choice(population)")):
                manifest = dict(original)
                manifest[field] = value
                manifest.pop("preregistration_sha256")
                manifest["preregistration_sha256"] = openings._manifest_lock_hash(manifest)
                manifest_path.write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8")
                with self.subTest(field=field), self.assertRaises(openings.ProtocolError):
                    openings.verify(self.root, self.lock_path, manifest_path)
            manifest_path.write_text(json.dumps(original, sort_keys=True, indent=2) + "\n", encoding="utf-8")

    def test_test_only_seed_source_is_not_accepted_as_a_formal_manifest(self):
        with patch.dict(openings.SOURCE_SHA256S, self.fixture_pins, clear=True):
            self._generate_with_os_seed(self.root, self.lock_path, self.root.parent / "test-seed", 3456)
            manifest_path = self.root.parent / "test-seed/selection-manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["seed_source"] = "test-only-injected-seed"
            manifest.pop("preregistration_sha256")
            manifest["preregistration_sha256"] = openings._manifest_lock_hash(manifest)
            manifest_path.write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8")
            with self.assertRaises(openings.ProtocolError):
                openings.verify(self.root, self.lock_path, manifest_path)

    def test_candidate_registration_blocks_second_output_directory(self):
        with patch.dict(openings.SOURCE_SHA256S, self.fixture_pins, clear=True):
            self._generate_with_os_seed(self.root, self.lock_path, self.root.parent / "first-registration", 4567)
            with self.assertRaises(openings.ProtocolError):
                openings.generate(self.root, self.lock_path, self.root.parent / "second-registration")

    def test_interrupted_generation_can_resume_only_same_seed_and_output_path(self):
        target = self.root.parent / "interrupted-output"
        with patch.dict(openings.SOURCE_SHA256S, self.fixture_pins, clear=True):
            with patch.object(openings.random.Random, "sample", side_effect=RuntimeError("injected interruption")):
                with self.assertRaisesRegex(openings.ProtocolError, "retry only with --resume-lock"):
                    self._generate_with_os_seed(self.root, self.lock_path, target, 5678)
            lock_dir = self.root / ".git/future-opening-selection-locks"
            registration_path = next(lock_dir.glob("*.json"))
            registration = json.loads(registration_path.read_text(encoding="utf-8"))
            self.assertEqual(registration["seed_u64"], 5678)
            self.assertEqual(Path(registration["output_dir"]), target.resolve())
            with self.assertRaises(openings.ProtocolError):
                openings.generate(
                    self.root, self.lock_path, self.root.parent / "wrong-retry-path",
                    resume_lock=registration_path,
                )
            with patch.object(openings.secrets, "token_bytes", side_effect=AssertionError("retry read new entropy")):
                resumed = openings.generate(self.root, self.lock_path, target, resume_lock=registration_path)
            self.assertEqual(resumed["manifest"]["seed_u64"], 5678)

    def test_verifier_rejects_overlapping_look_files_even_if_their_hashes_are_recomputed(self):
        with patch.dict(openings.SOURCE_SHA256S, self.fixture_pins, clear=True):
            self._generate_with_os_seed(self.root, self.lock_path, self.root.parent / "overlap-out", 12)
            output = self.root.parent / "overlap-out"
            manifest_path = output / "selection-manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            look1_lines = (output / "look1.tsv").read_text(encoding="utf-8").splitlines()
            look2_lines = (output / "look2.tsv").read_text(encoding="utf-8").splitlines()
            look2_lines[1] = look1_lines[1]
            bad_look2 = "\n".join(look2_lines) + "\n"
            (output / "look2.tsv").write_text(bad_look2, encoding="utf-8")
            manifest["output_sha256"]["look2.tsv"] = hashlib.sha256(bad_look2.encode()).hexdigest()
            manifest.pop("preregistration_sha256")
            manifest["preregistration_sha256"] = openings._manifest_lock_hash(manifest)
            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
            with self.assertRaises(openings.ProtocolError):
                openings.verify(self.root, self.lock_path, manifest_path)


if __name__ == "__main__":
    unittest.main()
