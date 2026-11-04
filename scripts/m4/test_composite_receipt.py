import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import match


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _make_receipt_fixture(root):
    root = Path(root)
    sample_dir = root / "sample"
    run_dir = root / "look1"
    sample_dir.mkdir()
    run_dir.mkdir()
    binary = root / "engine"
    binary.write_bytes(b"synthetic immutable engine")
    replay = root / "replay"
    replay.write_bytes(b"synthetic independent replay")
    look1_ids = [f"opening-{index:02}" for index in range(50)]
    look2_ids = [f"opening-{index + 50:02}" for index in range(50)]
    header = "opening_id\tsource_ref\ticcs_prefix\n"
    prefix = "h2e2 h9g7 h0g2 h9g7"
    (sample_dir / "look1.tsv").write_text(
        header + "".join(f"{oid}\tsource-{oid}\t{prefix}\n" for oid in look1_ids), encoding="utf-8"
    )
    (sample_dir / "look2.tsv").write_text(
        header + "".join(f"{oid}\tsource-{oid}\t{prefix}\n" for oid in look2_ids), encoding="utf-8"
    )
    sample_manifest = sample_dir / "selection-manifest.json"
    sample_manifest.write_text(json.dumps({
        "output_paths": {"look1": "look1.tsv", "look2": "look2.tsv"},
        "candidate": {
            "git_head": "candidate-head", "binary_sha256": _sha(binary),
            "config_path": "crates/xq-engine/src/lib.rs", "config_sha256": "a" * 64,
        },
    }), encoding="utf-8")
    sample_sha = _sha(sample_manifest)
    lock_sha = "b" * 64
    current = {
        "manifest_path": str(sample_manifest.resolve()),
        "manifest_sha256": sample_sha,
        "selection_manifest_sha256": lock_sha,
        "opening_ids": look2_ids,
    }

    raw_files = []
    for worker in range(1, 5):
        worker_dir = run_dir / "workers" / f"worker-{worker:02d}"
        worker_dir.mkdir(parents=True)
        for side in ("a", "b"):
            label = f"workers/worker-{worker:02d}/engine-{side}.log"
            raw = run_dir / label
            raw.write_text(f"raw-{worker}-{side}\n", encoding="utf-8")
            raw_files.append({"label": label, "path": str(raw.resolve()), "sha256": _sha(raw)})

    current_head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=Path(__file__).resolve().parents[2], text=True).strip()
    runner_source = Path(match.__file__).resolve()
    runner_sha = _sha(runner_source)
    engine_a_options = {"RootAlpha": "true", "CheckExtensions": "true"}
    engine_b_options = {"RootAlpha": "false", "CheckExtensions": "false"}
    run_manifest = {
        "experiment": "composite-root-alpha-check-extensions", "look": 1,
        "global_rounds": [1, 2], "requested_games": 200,
        "nodes_per_move": 10000, "master_seed": 1, "max_ply": 4096,
        "workers": 4, "engine_timeout_seconds": 30.0,
        "strategy_a": "search", "strategy_b": "search",
        "candidate_side": "A", "baseline_side": "B",
        "engine_a_options": engine_a_options, "engine_b_options": engine_b_options,
        "engine_a_executable": {"sha256": _sha(binary)},
        "engine_b_executable": {"sha256": _sha(binary)},
        "engine_a_command": str(binary), "engine_b_command": str(binary),
        "future_selection_manifest_sha256": sample_sha,
        "runner_git_head": current_head, "runner_source_sha256": runner_sha,
    }
    config_payload = json.dumps(run_manifest, sort_keys=True, separators=(",", ":")).encode()
    run_manifest["config_sha256"] = hashlib.sha256(config_payload).hexdigest()
    manifest_path = run_dir / "run-manifest.json"
    manifest_path.write_text(json.dumps(run_manifest), encoding="utf-8")

    games = []
    wdl = {"win": 0, "draw": 0, "loss": 0, "unfinished": 0}
    for round_number in (1, 2):
        for opening_id in look1_ids:
            for a_is_red in (True, False):
                game_id = match.stable_game_id(round_number, opening_id, a_is_red)
                games.append({
                    "game_id": game_id, "global_round": round_number,
                    "opening_id": opening_id, "a_is_red": a_is_red,
                    "source": f"source-{opening_id}", "prefix": prefix.split(),
                    "nodes": 10000, "max_ply": 4096, "master_seed": 1,
                    "seed": match.stable_seed(1, game_id),
                    "decision_seeds": [match.stable_seed(1, game_id)],
                    "moves": prefix.split(), "result_for_a": "draw", "winner": None,
                    "terminal_outcome": "draw",
                    "terminal_raw": ["info string outcome draw", "bestmove 0000"],
                    "unfinished_reason": None, "protocol_error": None,
                })
                wdl["draw"] += 1
    games_path = run_dir / "games.jsonl"
    games_path.write_text("".join(json.dumps(game) + "\n" for game in games), encoding="utf-8")
    selection_protocol = {
        "future_openings_verified": True, "population_size": 153,
        "selected_count": 50, "ordered_sample_count": 100, "look": 1,
        "opening_ids": look1_ids, "selection_manifest_sha256": lock_sha,
        "manifest_sha256": sample_sha,
    }
    summary = {
        "experiment": run_manifest["experiment"], "look": 1,
        "global_rounds": [1, 2], "requested_games": 200,
        "games_written": 200, "finished_games": 200, "unfinished_games": 0,
        "complete": True, "formal_decision_ready": True, "wdl_for_a": wdl,
        "decision_97_5_score_interval": [0.4, 0.6],
        "selection_protocol": selection_protocol,
        "run_manifest_path": str(manifest_path.resolve()),
        "run_manifest_sha256": _sha(manifest_path),
    }
    summary_path = run_dir / "summary.json"
    summary_path.write_text(json.dumps(summary), encoding="utf-8")
    receipt = {
        "schema": "m4-composite-look1-audit-receipt-v1",
        "status": "independently-audited-complete", "look": 1,
        "candidate": {
            "git_head": "candidate-head", "binary_sha256": _sha(binary),
            "config_path": "crates/xq-engine/src/lib.rs", "config_sha256": "a" * 64,
            "engine_a_options": engine_a_options, "engine_b_options": engine_b_options,
        },
        "selection": {
            "manifest_path": str(sample_manifest.resolve()), "manifest_sha256": sample_sha,
            "selection_manifest_sha256": lock_sha,
            "look_tsv_path": str((sample_dir / "look1.tsv").resolve()),
            "look_tsv_sha256": _sha(sample_dir / "look1.tsv"), "opening_ids": look1_ids,
        },
        "profile": {
            **run_manifest,
            "binary_sha256": _sha(binary), "sample_manifest_sha256": sample_sha,
            "replay_sha256": _sha(replay),
        },
        "verification": {"game_count": 200, "replayed_games": 200, "error_count": 0,
                          "raw_decisions": {"A": 100, "B": 100}},
        "raw_decisions": {"A": 100, "B": 100},
        "artifacts": {
            "summary": {"path": str(summary_path.resolve()), "sha256": _sha(summary_path)},
            "run_manifest": {"path": str(manifest_path.resolve()), "sha256": _sha(manifest_path)},
            "games": {"path": str(games_path.resolve()), "sha256": _sha(games_path)},
            "raw_files": raw_files,
        },
        "replay_executable": {"path": str(replay.resolve()), "sha256": _sha(replay)},
        "audit_source": {
            "path": str((Path(__file__).resolve().parent / "audit_composite.py").resolve()),
            "sha256": _sha(Path(__file__).resolve().parent / "audit_composite.py"),
        },
    }
    receipt_path = run_dir / "audit-receipt.json"
    receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
    return {
        "summary": summary_path, "receipt": receipt_path, "current_selection": current,
        "binary": binary, "replay": replay, "games": games_path,
    }


class CompositeLook1ReceiptTests(unittest.TestCase):
    def test_verified_receipt_accepts_complete_bound_look_and_checks_raw_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = _make_receipt_fixture(Path(directory))
            with patch.object(match, "COMPOSITE_CANDIDATE_HEAD", "candidate-head"), \
                    patch.object(match, "COMPOSITE_BINARY_SHA256", _sha(fixture["binary"])):
                result = match.validate_composite_prior_look(
                    fixture["summary"], fixture["current_selection"], fixture["receipt"]
                )
                self.assertEqual(result["look1_opening_count"], 50)
                receipt = json.loads(fixture["receipt"].read_text(encoding="utf-8"))
                raw_path = Path(receipt["artifacts"]["raw_files"][0]["path"])
                raw_path.write_text("changed after audit", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "raw file mismatch"):
                    match.validate_composite_prior_look(
                        fixture["summary"], fixture["current_selection"], fixture["receipt"]
                    )

    def test_receipt_rejects_incomplete_game_ids_even_when_artifact_hash_is_updated(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = _make_receipt_fixture(Path(directory))
            games = [json.loads(line) for line in fixture["games"].read_text().splitlines()]
            games[-1]["game_id"] = games[0]["game_id"]
            fixture["games"].write_text("".join(json.dumps(game) + "\n" for game in games), encoding="utf-8")
            receipt = json.loads(fixture["receipt"].read_text(encoding="utf-8"))
            receipt["artifacts"]["games"]["sha256"] = _sha(fixture["games"])
            fixture["receipt"].write_text(json.dumps(receipt), encoding="utf-8")
            with patch.object(match, "COMPOSITE_CANDIDATE_HEAD", "candidate-head"), \
                    patch.object(match, "COMPOSITE_BINARY_SHA256", _sha(fixture["binary"])):
                with self.assertRaisesRegex(ValueError, "complete 50 x 2-color x 2-round ID set"):
                    match.validate_composite_prior_look(
                        fixture["summary"], fixture["current_selection"], fixture["receipt"]
                    )

    def test_receipt_rejects_empty_raw_decision_counts_even_if_self_consistent(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = _make_receipt_fixture(Path(directory))
            receipt = json.loads(fixture["receipt"].read_text(encoding="utf-8"))
            receipt["raw_decisions"] = {"A": 0, "B": 0}
            receipt["verification"]["raw_decisions"] = {"A": 0, "B": 0}
            fixture["receipt"].write_text(json.dumps(receipt), encoding="utf-8")
            with patch.object(match, "COMPOSITE_CANDIDATE_HEAD", "candidate-head"), \
                    patch.object(match, "COMPOSITE_BINARY_SHA256", _sha(fixture["binary"])):
                with self.assertRaisesRegex(ValueError, "complete raw decision counts"):
                    match.validate_composite_prior_look(
                        fixture["summary"], fixture["current_selection"], fixture["receipt"]
                    )


if __name__ == "__main__":
    unittest.main()
