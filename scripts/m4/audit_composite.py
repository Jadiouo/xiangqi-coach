#!/usr/bin/env python3
"""Audit RootAlpha + CheckExtensions runs with the shared M4 raw/Game helpers."""

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import audit_q_capture as shared_audit
import match as shared_runner
from composite_statistics import (
    calculate_combined_statistics,
    calculate_look_statistics,
    should_run_second_look,
)
from future_opening_adapter import (
    EXPECTED_CANDIDATE_BINARY_SHA256,
    EXPECTED_CANDIDATE_HEAD,
    verify_future_opening_look,
)


EXPERIMENT = "composite-root-alpha-check-extensions"
OPTIONS_A = {"RootAlpha": "true", "CheckExtensions": "true"}
OPTIONS_B = {"RootAlpha": "false", "CheckExtensions": "false"}


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _close(actual, expected):
    return isinstance(actual, (int, float)) and abs(actual - expected) <= 1e-12


def _interval_matches(actual, expected):
    return (isinstance(actual, list) and len(actual) == 2
            and all(_close(a, e) for a, e in zip(actual, expected)))


def _raw_paths(run_dir):
    return {
        f"workers/worker-{worker:02d}/engine-{side}.log": str(
            run_dir / f"workers/worker-{worker:02d}/engine-{side}.log"
        )
        for worker in range(1, 5) for side in ("a", "b")
    }


def _make_look1_audit_receipt(first, *, selection_manifest, replay, runner_checkout, runner_source):
    """Serialize the evidence already checked by this audit, without rerunning Game."""
    run_dir = Path(first["run_directory"]).resolve()
    manifest_path = run_dir / "run-manifest.json"
    games_path = run_dir / "games.jsonl"
    summary_path = run_dir / "summary.json"
    run_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    sample = json.loads(Path(selection_manifest).read_text(encoding="utf-8"))
    look1_tsv = (Path(selection_manifest).resolve().parent / sample["output_paths"]["look1"]).resolve()
    raw_files = []
    for item in first["raw_files"]:
        label = item["path"]
        path = (run_dir / label).resolve()
        raw_files.append({"label": label, "path": str(path), "sha256": sha256(path)})
    candidate = sample["candidate"]
    receipt = {
        "schema": "m4-composite-look1-audit-receipt-v1",
        "status": "independently-audited-complete",
        "look": 1,
        "candidate": {
            "git_head": candidate["git_head"],
            "binary_sha256": candidate["binary_sha256"],
            "config_path": candidate["config_path"],
            "config_sha256": candidate["config_sha256"],
            "engine_a_options": run_manifest["engine_a_options"],
            "engine_b_options": run_manifest["engine_b_options"],
        },
        "selection": {
            "manifest_path": str(Path(selection_manifest).resolve()),
            "manifest_sha256": sha256(selection_manifest),
            "selection_manifest_sha256": first["selection"]["selection_manifest_sha256"],
            "look_tsv_path": str(look1_tsv),
            "look_tsv_sha256": sha256(look1_tsv),
            "opening_ids": first["selection"]["opening_ids"],
        },
        "profile": {
            field: run_manifest[field]
            for field in (
                "experiment", "look", "global_rounds", "requested_games", "nodes_per_move",
                "master_seed", "max_ply", "workers", "engine_timeout_seconds", "strategy_a",
                "strategy_b", "candidate_side", "baseline_side", "engine_a_options",
                "engine_b_options", "runner_git_head", "runner_source_sha256", "config_sha256",
            )
        },
        "profile_extra": {
            "binary_sha256": run_manifest["engine_a_executable"]["sha256"],
            "sample_manifest_sha256": sha256(selection_manifest),
            "replay_sha256": sha256(replay),
            "runner_checkout": str(Path(runner_checkout).resolve()),
        },
        "verification": {
            "game_count": len(first["bykey"]),
            "replayed_games": len(first["bykey"]),
            "error_count": 0,
            "raw_decisions": first["raw_decisions"],
        },
        "raw_decisions": first["raw_decisions"],
        "artifacts": {
            "summary": {"path": str(summary_path), "sha256": sha256(summary_path)},
            "run_manifest": {"path": str(manifest_path), "sha256": sha256(manifest_path)},
            "games": {"path": str(games_path), "sha256": sha256(games_path)},
            "raw_files": raw_files,
        },
        "replay_executable": {"path": str(Path(replay).resolve()), "sha256": sha256(replay)},
        "audit_source": {"path": str(Path(__file__).resolve()), "sha256": sha256(__file__)},
        "note": "Machine provenance receipt for already completed raw/Game audit; not a signature or substitute for independent review.",
    }
    receipt["profile"].update(receipt.pop("profile_extra"))
    return receipt


def _audit_look(run_dir, *, look, selection_manifest, replay, runner_checkout, runner_source):
    run_dir = Path(run_dir).resolve()
    selection_manifest = Path(selection_manifest).resolve()
    runner_source = Path(runner_source).resolve()
    runner_checkout = Path(runner_checkout).resolve()
    tsv = selection_manifest.parent / f"look{look}.tsv"
    selection = verify_future_opening_look(selection_manifest, tsv, look)
    source_result = subprocess.run(
        ["git", "-C", str(runner_checkout), "rev-parse", "HEAD"],
        capture_output=True, text=True,
    )
    if source_result.returncode:
        raise ValueError("cannot read current runner checkout HEAD")
    runner_head = source_result.stdout.strip()
    runner_sha = sha256(runner_source)
    manifest_path = run_dir / "run-manifest.json"
    games_path = run_dir / "games.jsonl"
    summary_path = run_dir / "summary.json"
    if not all(path.is_file() for path in (manifest_path, games_path, summary_path)):
        raise ValueError(f"look {look} run output is incomplete")
    run_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if run_manifest.get("runner_git_head") != runner_head:
        raise ValueError(f"look {look} runner checkout HEAD differs from the run manifest")
    if run_manifest.get("runner_source_sha256") != runner_sha:
        raise ValueError(f"look {look} runner source SHA differs from the run manifest")
    if run_manifest.get("future_selection_manifest_sha256") != sha256(selection_manifest):
        raise ValueError(f"look {look} selection manifest SHA differs from the run manifest")

    candidate = json.loads(selection_manifest.read_text(encoding="utf-8"))["candidate"]
    if candidate.get("git_head") != EXPECTED_CANDIDATE_HEAD:
        raise ValueError("candidate source HEAD differs from the reviewed composite candidate")
    binary_path = Path(candidate["binary_path"]).resolve()
    if sha256(binary_path) != EXPECTED_CANDIDATE_BINARY_SHA256:
        raise ValueError("candidate binary SHA differs from the reviewed composite candidate")
    if not Path(replay).is_file():
        raise ValueError("independent Game replay executable is missing")

    profile = {
        "binary": EXPECTED_CANDIDATE_BINARY_SHA256,
        "binary_path": str(binary_path),
        "experiment": EXPERIMENT,
        "options": (OPTIONS_A, OPTIONS_B),
        "workers": 4,
        "runner_source_sha256": runner_sha,
        "future_selection_manifest_sha256": sha256(selection_manifest),
        "population_size": 153,
        "selected_count": 50,
        "inputs": {"openings_tsv": {"sha256": selection["look_tsv_sha256"]}},
    }
    shared_audit.TSV = tsv
    shared_audit.REPLAY = Path(replay).resolve()
    shared_audit.errors = []
    result = shared_audit.audit_batch(
        run_dir,
        profile,
        (1, 2) if look == 1 else (3, 4),
        configured_run={
            "manifest_path": str(manifest_path),
            "games_path": str(games_path),
            "summary_path": str(summary_path),
            "raw_log_paths": _raw_paths(run_dir),
        },
    )
    if shared_audit.errors:
        raise ValueError("; ".join(shared_audit.errors))
    if result["manifest"].get("engine_timeout_seconds") != 30.0:
        raise ValueError(f"look {look} timeout is not 30 seconds")
    if result["manifest"].get("selection") != selection:
        raise ValueError(f"look {look} manifest selection differs from verified sampler evidence")
    stats = calculate_look_statistics(result["bykey"], (1, 2) if look == 1 else (3, 4))
    summary = result["summary"]
    if not _close(summary.get("score_mean"), stats["score_mean"]):
        raise ValueError(f"look {look} score differs from independently recomputed clusters")
    if not _interval_matches(summary.get("report_95_hoeffding_score_interval"),
                             stats["report_95_ordinary_hoeffding_score_interval"]):
        raise ValueError(f"look {look} ordinary 95% interval mismatch")
    if not _interval_matches(summary.get("decision_97_5_score_interval"),
                             stats["decision_97_5_score_interval"]):
        raise ValueError(f"look {look} finite-population interval mismatch")
    return {
        "look": look,
        "selection": selection,
        "run_directory": str(run_dir),
        "manifest_sha256": sha256(manifest_path),
        "games_sha256": sha256(games_path),
        "summary_sha256": sha256(summary_path),
        "raw_files": result["artifacts"]["raw_files"],
        "raw_decisions": result["raw_decisions"],
        "wdl_for_a": result["wdl"],
        "stats": stats,
        "bykey": result["bykey"],
    }


def audit_composite(selection_manifest, look1_run, look2_run, replay, replay_sha256, runner_checkout, runner_source,
                    prior_look_audit_receipt=None):
    if sha256(replay) != replay_sha256:
        raise ValueError("independent Game replay executable SHA-256 mismatch")
    first = _audit_look(
        look1_run, look=1, selection_manifest=selection_manifest, replay=replay,
        runner_checkout=runner_checkout, runner_source=runner_source,
    )
    needs_look2 = should_run_second_look(first["stats"]["decision_97_5_score_interval"])
    if look2_run is None:
        result = {
            "formal_ready": not needs_look2,
            "status": "look2_required" if needs_look2 else (
                "keep" if first["stats"]["decision_97_5_score_interval"][0] > 0.5 else "revert_negative"
            ),
            "look1": {key: value for key, value in first.items() if key != "bykey"},
            "look1_decision_interval": first["stats"]["decision_97_5_score_interval"],
            "opening_cluster_count": 50,
            "finite_population_size": 153,
        }
        result["look1_audit_receipt"] = _make_look1_audit_receipt(
            first, selection_manifest=selection_manifest, replay=replay,
            runner_checkout=runner_checkout, runner_source=runner_source,
        )
        return result
    if not needs_look2:
        raise ValueError("look 1 interval did not cross 0.5; look 2 must not be run")
    if prior_look_audit_receipt is None:
        raise ValueError("look 2 audit requires the look 1 audit receipt")
    selection_data = json.loads(Path(selection_manifest).read_text(encoding="utf-8"))
    look2_tsv = Path(selection_manifest).resolve().parent / selection_data["output_paths"]["look2"]
    current_selection = verify_future_opening_look(selection_manifest, look2_tsv, 2)
    first_summary = Path(first["run_directory"]) / "summary.json"
    audited_prior = shared_runner.validate_composite_prior_look(
        first_summary, current_selection, prior_look_audit_receipt,
    )
    second = _audit_look(
        look2_run, look=2, selection_manifest=selection_manifest, replay=replay,
        runner_checkout=runner_checkout, runner_source=runner_source,
    )
    stats = calculate_combined_statistics(first["bykey"], second["bykey"])
    second_manifest = json.loads((Path(second["run_directory"]) / "run-manifest.json").read_text())
    prior = second_manifest.get("prior_look") or {}
    if prior.get("path") != str(first_summary.resolve()):
        raise ValueError("look 2 does not reference the exact look 1 summary")
    if prior.get("summary_sha256") != sha256(first_summary):
        raise ValueError("look 2 prior summary SHA-256 mismatch")
    prior_receipt_path = Path(prior_look_audit_receipt).resolve()
    if (prior.get("audit_receipt_path") != str(prior_receipt_path)
            or prior.get("audit_receipt_sha256") != sha256(prior_receipt_path)
            or audited_prior.get("audit_receipt_sha256") != sha256(prior_receipt_path)):
        raise ValueError("look 2 run manifest does not reference the supplied look 1 audit receipt")
    interval = stats["decision_97_5_score_interval"]
    verdict = "keep" if interval[0] > 0.5 else "revert_negative" if interval[1] < 0.5 else "revert_after_look2"
    return {
        "formal_ready": True,
        "status": verdict,
        "look1": {key: value for key, value in first.items() if key != "bykey"},
        "look2": {key: value for key, value in second.items() if key != "bykey"},
        "wdl_for_a": {
            key: first["wdl_for_a"].get(key, 0) + second["wdl_for_a"].get(key, 0)
            for key in ("win", "draw", "loss")
        },
        "opening_cluster_count": stats["opening_cluster_count"],
        "finite_population_size": stats["finite_population_size"],
        "score_mean": stats["score_mean"],
        "report_95_ordinary_hoeffding": stats["report_95_ordinary_hoeffding_score_interval"],
        "decision_97_5_finite_serfling": interval,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection-manifest", type=Path, required=True)
    parser.add_argument("--look1-run", type=Path, required=True)
    parser.add_argument("--look2-run", type=Path)
    parser.add_argument("--prior-look-summary", type=Path,
                        help="first look summary required to verify look 2 receipt linkage")
    parser.add_argument("--prior-look-audit-receipt", type=Path)
    parser.add_argument("--replay-executable", type=Path, required=True)
    parser.add_argument("--replay-sha256", required=True)
    parser.add_argument("--runner-checkout", type=Path, required=True)
    parser.add_argument("--runner-source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("refusing to overwrite an existing composite audit result")
    receipt_output = args.look1_run.resolve() / "audit-receipt.json"
    if args.look2_run is None and receipt_output.exists():
        parser.error("refusing to overwrite an existing look 1 audit receipt")
    if args.look2_run is not None and args.prior_look_audit_receipt is None:
        parser.error("look 2 audit requires --prior-look-audit-receipt")
    if args.look2_run is not None and args.prior_look_summary is None:
        parser.error("look 2 audit requires --prior-look-summary")
    if (args.look2_run is not None
            and args.prior_look_summary.resolve() != (args.look1_run.resolve() / "summary.json").resolve()):
        parser.error("look 2 audit prior summary must be the exact look 1 run summary")
    try:
        result = audit_composite(
            args.selection_manifest, args.look1_run, args.look2_run,
            args.replay_executable, args.replay_sha256, args.runner_checkout, args.runner_source,
            args.prior_look_audit_receipt,
        )
        if args.look2_run is None:
            receipt_bytes = (json.dumps(result.pop("look1_audit_receipt"), indent=2, ensure_ascii=False) + "\n").encode()
            receipt_output.write_bytes(receipt_bytes)
            result["look1_audit_receipt_path"] = str(receipt_output)
            result["look1_audit_receipt_sha256"] = hashlib.sha256(receipt_bytes).hexdigest()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0 if result["formal_ready"] or result["status"] == "look2_required" else 1
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"formal_ready": False, "status": "invalid", "errors": [str(error)]}, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
