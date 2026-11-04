import hashlib
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import sys

import audit_composite
import match
from test_composite_receipt import _make_receipt_fixture, _sha


def _batch(look, score, run_directory):
    rounds = (1, 2) if look == 1 else (3, 4)
    bykey = {}
    ids = [f"look{look}-{index:02}" for index in range(50)]
    for opening_id in ids:
        for red in (True, False):
            for round_number in rounds:
                bykey[(opening_id, red, round_number)] = ("a", "b", "win")
    return {
        "look": look,
        "run_directory": str(run_directory),
        "bykey": bykey,
        "wdl_for_a": {"win": 200, "draw": 0, "loss": 0},
        "stats": {
            "score_mean": score,
            "decision_97_5_score_interval": [0.4, 0.6],
        },
    }


class CompositeAuditTests(unittest.TestCase):
    def test_first_look_crossing_requires_second_look(self):
        with tempfile.TemporaryDirectory() as directory:
            replay = Path(directory) / "replay"
            replay.write_bytes(b"synthetic replay binary")
            with patch.object(audit_composite, "_audit_look", return_value=_batch(1, 0.5, "/tmp/look1")), \
                    patch.object(audit_composite, "_make_look1_audit_receipt", return_value={"schema": "test"}):
                result = audit_composite.audit_composite(
                    "selection.json", "/tmp/look1", None, replay, hashlib.sha256(replay.read_bytes()).hexdigest(), "/tmp/runner", "/tmp/source"
                )
            self.assertFalse(result["formal_ready"])
            self.assertEqual(result["status"], "look2_required")
            self.assertEqual(result["opening_cluster_count"], 50)

    def test_auditor_cli_writes_machine_readable_look1_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = _make_receipt_fixture(root)
            summary = json.loads(fixture["summary"].read_text(encoding="utf-8"))
            games = [json.loads(line) for line in fixture["games"].read_text(encoding="utf-8").splitlines()]
            receipt_before = json.loads(fixture["receipt"].read_text(encoding="utf-8"))
            fixture["receipt"].unlink()
            first = {
                "run_directory": str(fixture["summary"].parent),
                "selection": {
                    "selection_manifest_sha256": fixture["current_selection"]["selection_manifest_sha256"],
                    "opening_ids": receipt_before["selection"]["opening_ids"],
                },
                "raw_files": [
                    {"path": item["label"]} for item in receipt_before["artifacts"]["raw_files"]
                ],
                "raw_decisions": {"A": 100, "B": 100},
                "bykey": {
                    (row["opening_id"], row["a_is_red"], row["global_round"]): None for row in games
                },
                "wdl_for_a": summary["wdl_for_a"],
                "stats": {"score_mean": 0.5, "decision_97_5_score_interval": [0.4, 0.6]},
            }
            selection = Path(fixture["current_selection"]["manifest_path"])
            output = root / "audit-result.json"
            receipt_path = fixture["summary"].parent / "audit-receipt.json"
            argv = [
                "audit_composite.py", "--selection-manifest", str(selection),
                "--look1-run", str(fixture["summary"].parent), "--replay-executable", str(fixture["replay"]),
                "--replay-sha256", _sha(fixture["replay"]),
                "--runner-checkout", str(Path(match.__file__).resolve().parents[2]),
                "--runner-source", str(Path(match.__file__).resolve()),
                "--output", str(output),
            ]
            with patch.object(sys, "argv", argv), patch.object(audit_composite, "_audit_look", return_value=first), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(audit_composite.main(), 0)
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            self.assertEqual(receipt["status"], "independently-audited-complete")
            self.assertEqual(receipt["verification"]["replayed_games"], 200)
            self.assertEqual(len(receipt["artifacts"]["raw_files"]), 8)
            result = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(result["look1_audit_receipt_path"], str(receipt_path))
            self.assertEqual(result["look1_audit_receipt_sha256"], hashlib.sha256(receipt_path.read_bytes()).hexdigest())
            with patch.object(match, "COMPOSITE_CANDIDATE_HEAD", "candidate-head"), \
                    patch.object(match, "COMPOSITE_BINARY_SHA256", _sha(fixture["binary"])):
                validated = match.validate_composite_look1_audit_receipt(
                    fixture["summary"], fixture["current_selection"], receipt_path,
                )
            self.assertEqual(validated["look1_opening_count"], 50)

    def test_combined_look_requires_disjoint_samples_and_uses_n100(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            replay = root / "replay"
            replay.write_bytes(b"synthetic replay binary")
            replay_sha = hashlib.sha256(replay.read_bytes()).hexdigest()
            look1_dir = root / "look1"
            look2_dir = root / "look2"
            look1_dir.mkdir()
            look2_dir.mkdir()
            summary = look1_dir / "summary.json"
            summary.write_text("look 1 summary", encoding="utf-8")
            receipt_path = root / "receipt.json"
            receipt_path.write_bytes(b"receipt")
            selection = root / "selection.json"
            selection.write_text(json.dumps({"output_paths": {"look2": "look2.tsv"}}), encoding="utf-8")
            (root / "look2.tsv").write_text("synthetic look 2 selection\n", encoding="utf-8")
            look2_manifest = look2_dir / "run-manifest.json"
            look2_manifest.write_text(
                json.dumps({"prior_look": {
                    "path": str(summary.resolve()),
                    "summary_sha256": hashlib.sha256(summary.read_bytes()).hexdigest(),
                    "audit_receipt_path": str(receipt_path.resolve()),
                    "audit_receipt_sha256": hashlib.sha256(receipt_path.read_bytes()).hexdigest(),
                }}),
                encoding="utf-8",
            )
            first = _batch(1, 0.5, look1_dir)
            second = _batch(2, 0.5, look2_dir)
            current_selection = {
                "manifest_path": str(selection),
                "manifest_sha256": "sample-sha",
                "selection_manifest_sha256": "sample-lock",
                "opening_ids": [f"look2-{index:02}" for index in range(50)],
            }
            with patch.object(audit_composite, "_audit_look", side_effect=(first, second)), \
                    patch.object(audit_composite, "verify_future_opening_look", return_value=current_selection), \
                    patch.object(audit_composite.shared_runner, "validate_composite_prior_look", return_value={
                    "audit_receipt_sha256": hashlib.sha256(receipt_path.read_bytes()).hexdigest(),
                    }):
                result = audit_composite.audit_composite(
                    selection, look1_dir, look2_dir, replay, replay_sha, "/tmp/runner", "/tmp/source",
                    prior_look_audit_receipt=receipt_path,
                )
            self.assertTrue(result["formal_ready"])
            self.assertEqual(result["opening_cluster_count"], 100)
            self.assertEqual(result["finite_population_size"], 153)

            overlapping = _batch(2, 0.5, look2_dir)
            overlapping["bykey"] = {
                (f"look1-{index:02}", red, round_number): value
                for (opening_id, red, round_number), value in overlapping["bykey"].items()
                for index in [int(opening_id.split("-")[1])]
            }
            with patch.object(audit_composite, "_audit_look", side_effect=(first, overlapping)), \
                    patch.object(audit_composite, "verify_future_opening_look", return_value=current_selection), \
                    patch.object(audit_composite.shared_runner, "validate_composite_prior_look", return_value={
                        "audit_receipt_sha256": hashlib.sha256(receipt_path.read_bytes()).hexdigest(),
                    }):
                with self.assertRaisesRegex(ValueError, "overlap"):
                    audit_composite.audit_composite(
                        selection, look1_dir, look2_dir, replay, replay_sha, "/tmp/runner", "/tmp/source",
                        prior_look_audit_receipt=receipt_path,
                    )


if __name__ == "__main__":
    unittest.main()
