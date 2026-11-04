"""Independent M5 match auditor built on the shared M4 raw/game helpers."""
from __future__ import annotations
import argparse
import collections
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import tarfile
from contextlib import contextmanager
from pathlib import Path

M5_DIR = Path(__file__).resolve().parent
M4_DIR = M5_DIR.parent / "m4"
sys.path.insert(0, str(M4_DIR))
sys.path.insert(0, str(M5_DIR))
import match
import audit_q_capture
import composite_statistics
import protocol

REPLAY_BASE_REVISION = "324373fdf5645db622fd258b12a3fcb0af3cb4ff"
REPLAY_SOURCE_SHA256 = "cbdda9ee2b675717a35a9da8e104de9b46b61d088b1580b564fe78678a2dfcbf"
REPO_ROOT = M5_DIR.parents[1]
REPLAY_SOURCE = REPO_ROOT / "crates/xq-uci/src/bin/match-replay.rs"


@contextmanager
def trusted_replay():
    """Build the pinned replayer inside a clean archive of fixed main."""
    if _sha(REPLAY_SOURCE) != REPLAY_SOURCE_SHA256:
        raise protocol.ProtocolError("trusted xq-core replay source differs from its pinned digest")
    with tempfile.TemporaryDirectory(prefix="m5-trusted-replay-") as target_dir:
        source_root = Path(target_dir) / "source"
        source_root.mkdir()
        archive = subprocess.run(["git", "-C", str(REPO_ROOT), "archive", "--format=tar",
                                  REPLAY_BASE_REVISION], capture_output=True)
        if archive.returncode != 0:
            raise protocol.ProtocolError("cannot read fixed-main source archive")
        with tarfile.open(fileobj=io.BytesIO(archive.stdout), mode="r:") as tar:
            tar.extractall(source_root, filter="data")
        trusted_source = source_root / "crates/xq-uci/src/bin/match-replay.rs"
        trusted_source.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REPLAY_SOURCE, trusted_source)
        env = os.environ.copy()
        env.pop("RUSTFLAGS", None)
        env["CARGO_TARGET_DIR"] = str(Path(target_dir) / "target")
        build = subprocess.run(["cargo", "build", "--locked", "--offline", "-q", "-p", "xq-uci",
                                "--bin", "match-replay"], cwd=source_root, env=env,
                               capture_output=True, text=True)
        binary = Path(env["CARGO_TARGET_DIR"]) / "debug/match-replay"
        if build.returncode != 0 or not binary.is_file():
            raise protocol.ProtocolError(f"cannot build pinned Game replay: {build.stderr[-500:]}")
        yield binary


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def audit_run(run_dir: Path, *, candidate_lock: Path, binding: Path, selection_manifest: Path,
              openings_tsv: Path, look: int, prior_receipt: Path | None = None) -> dict:
    run_dir = Path(run_dir).resolve()
    manifest_path = run_dir / "run-manifest.json"
    games_path = run_dir / "games.jsonl"
    summary_path = run_dir / "summary.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    candidate = protocol.verify_lock(candidate_lock)
    profile = manifest.get("m5_profile")
    selection = protocol.verify_runner_selection(candidate_lock, binding, selection_manifest, openings_tsv, look, profile)
    if profile not in protocol.M5_PROFILE_TARGETS or summary.get("m5_profile") != profile:
        raise protocol.ProtocolError("run manifest is not a named M5 profile")
    expected_options_a = protocol.runner_options({**protocol.BASELINE_FLAGS, protocol.M5_PROFILE_TARGETS[profile]: True})
    expected_options_b = protocol.runner_options(protocol.BASELINE_FLAGS)
    expected = {
        "experiment": f"m5-{profile}", "look": look,
        "global_rounds": [1, 2] if look == 1 else [3, 4],
        "requested_games": 200, "workers": 4, "master_seed": 1,
        "nodes_per_move": 10000, "max_ply": 4096, "engine_timeout_seconds": 30.0,
        "strategy_a": "search", "strategy_b": "search",
        "candidate_side": "A", "baseline_side": "B",
        "engine_a_options": expected_options_a, "engine_b_options": expected_options_b,
        "m5_candidate_id": candidate["candidate_id"],
        "m5_candidate_lock_sha256": candidate["lock_sha256"],
        "m5_sample_sha256": selection["sample_sha256"],
        "future_selection_manifest_sha256": _sha(selection_manifest),
    }
    for key, value in expected.items():
        if manifest.get(key) != value:
            raise protocol.ProtocolError(f"run manifest M5 mismatch: {key}")
    config_payload = {key: value for key, value in manifest.items() if key != "config_sha256"}
    config_digest = hashlib.sha256(json.dumps(config_payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if manifest.get("config_sha256") != config_digest:
        raise protocol.ProtocolError("run manifest config digest mismatch")
    if (Path(summary.get("run_manifest_path", "")).resolve() != manifest_path
            or summary.get("run_manifest_sha256") != _sha(manifest_path)
            or summary.get("complete") is not True
            or summary.get("formal_decision_ready") is not False
            or summary.get("decision_status") != "await_m5_raw_game_audit"):
        raise protocol.ProtocolError("run summary is not bound to this complete pending M5 audit")
    if (summary.get("m5_profile") != manifest.get("m5_profile")
            or summary.get("m5_candidate_id") != candidate["candidate_id"]
            or summary.get("m5_candidate_lock_sha256") != candidate["lock_sha256"]
            or summary.get("m5_sample_sha256") != selection["sample_sha256"]):
        raise protocol.ProtocolError("run summary candidate/sample identity mismatch")
    if _sha(openings_tsv) != manifest.get("openings_sha256"):
        raise protocol.ProtocolError("run manifest openings TSV hash mismatch")
    runner_path = Path(match.__file__).resolve()
    if manifest.get("runner_source_sha256") != _sha(runner_path):
        raise protocol.ProtocolError("M4 shared runner source SHA-256 mismatch")
    if look == 1:
        if prior_receipt is not None or manifest.get("m5_prior_receipt_sha256") is not None:
            raise protocol.ProtocolError("look 1 cannot reference a prior receipt")
    else:
        if prior_receipt is None:
            raise protocol.ProtocolError("M5 look 2 audit requires the look 1 receipt")
        if _sha(prior_receipt) != manifest.get("m5_prior_receipt_sha256"):
            raise protocol.ProtocolError("M5 look 2 prior receipt hash differs from runner manifest")
        protocol.validate_prior_receipt(prior_receipt, candidate, selection["sample_sha256"])
    for side in ("a", "b"):
        engine = manifest.get(f"engine_{side}_executable", {})
        if engine.get("sha256") != candidate["binary_sha256"] or Path(engine.get("path", "")).resolve() != Path(candidate["binary_path"]).resolve():
            raise protocol.ProtocolError(f"engine {side.upper()} does not match the locked binary")
    games = [json.loads(line) for line in games_path.read_text(encoding="utf-8").splitlines() if line]
    rows = [line.split("\t") for line in Path(openings_tsv).read_text(encoding="utf-8").splitlines()[1:]]
    opening_data = {r[0]: {"source": r[1], "prefix": r[2].split()} for r in rows}
    checked = match.verify_batch_games(games, selection["opening_ids"], manifest["global_rounds"],
                                       10000, 1, opening_data, 4096)
    if not checked["complete"] or len(games) != 200:
        raise protocol.ProtocolError(f"Game row audit failed: {checked['errors'][:8]}")
    replay_lines = "".join(g["game_id"] + "\t" + " ".join(g["moves"]) + "\n" for g in games)
    with trusted_replay() as replay_executable:
        replay = subprocess.run([str(replay_executable)], input=replay_lines, text=True, capture_output=True)
        if replay.returncode != 0:
            raise protocol.ProtocolError(f"independent xq-core Game replay failed: {replay.stderr[-500:]}")
        replayed = {}
        try:
            for line in replay.stdout.splitlines():
                gid, outcome, plies = line.split("\t")
                if gid in replayed:
                    raise ValueError(f"duplicate replay game: {gid}")
                replayed[gid] = (outcome, int(plies))
        except ValueError as error:
            raise protocol.ProtocolError(f"invalid trusted replay output: {error}") from error
        if len(replayed) != 200:
            raise protocol.ProtocolError("independent Game replay did not return 200 games")
        for game in games:
            if replayed.get(game["game_id"]) != (game["terminal_outcome"], len(game["moves"])):
                raise protocol.ProtocolError(f"independent Game replay differs: {game['game_id']}")
    raw_paths = {f"workers/worker-{worker:02d}/engine-{side}.log": str(run_dir / "workers" / f"worker-{worker:02d}" / f"engine-{side}.log") for worker in range(1, 5) for side in ("a", "b")}
    raw_audit = audit_q_capture.audit_raw_traces(run_dir, games, selection["opening_ids"], manifest_path, raw_paths)
    wdl = collections.Counter(game["result_for_a"] for game in games)
    bykey = {}
    for game in games:
        bykey[(game["opening_id"], game["a_is_red"], game["global_round"])] = (tuple(game["moves"]), game["terminal_outcome"], game["result_for_a"])
    stats = composite_statistics.calculate_look_statistics(bykey, rounds=(1, 2) if look == 1 else (3, 4))
    if summary.get("finished_games") != 200 or summary.get("unfinished_games") != 0:
        raise protocol.ProtocolError("run summary does not report 200 completed games")
    summary_wdl = summary.get("wdl_for_a", {})
    if any(summary_wdl.get(key, 0) != wdl.get(key, 0) for key in ("win", "draw", "loss", "unfinished")):
        raise protocol.ProtocolError("run summary W/D/L differs from audited games")
    if abs(summary.get("score_mean", -1) - stats["score_mean"]) > 1e-12:
        raise protocol.ProtocolError("run summary score does not match audited opening clusters")
    if summary.get("decision_97_5_score_interval") != stats["decision_97_5_score_interval"]:
        raise protocol.ProtocolError("run summary finite-population decision interval differs from M5 auditor")
    if summary.get("report_95_hoeffding_score_interval") != stats["report_95_ordinary_hoeffding_score_interval"]:
        raise protocol.ProtocolError("run summary ordinary 95% interval differs from M5 auditor")
    artifacts = {name: {"path": str(Path(path).resolve()), "sha256": _sha(path)} for name, path in {
        "run_manifest": manifest_path, "games": games_path, "summary": summary_path,
        "openings": openings_tsv, "selection_manifest": selection_manifest, "binding": binding,
        "candidate_lock": candidate_lock,
        "trusted_replay_source": REPLAY_SOURCE,
        "m4_runner_source": match.__file__, "m5_auditor_source": __file__,
        "m5_protocol_source": protocol.__file__,
    }.items()}
    artifacts.update({f"raw:{row['path']}": {"path": str(run_dir / row["path"]), "sha256": row["sha256"]} for row in raw_audit["raw_files"]})
    return {
        "schema": protocol.RECEIPT_SCHEMA, "status": "complete", "look": look,
        "candidate_id": candidate["candidate_id"], "candidate_lock_sha256": candidate["lock_sha256"],
        "sample_sha256": selection["sample_sha256"], "error_count": 0, "unfinished_games": 0,
        "game_count": 200, "raw_replay_valid": True, "decision_interval": stats["decision_97_5_score_interval"],
        "cluster_scores": stats["cluster_scores"], "score_mean": stats["score_mean"],
        "report_95_ordinary_hoeffding_score_interval": stats["report_95_ordinary_hoeffding_score_interval"],
        "look1_decision": ("keep" if stats["decision_97_5_score_interval"][0] > .5 else
                           "discard" if stats["decision_97_5_score_interval"][1] < .5 else
                           "look2_allowed" if look == 1 else "discard_inconclusive"),
        "replayed_games": 200, "raw_decisions": raw_audit["decisions_by_actor"], "artifacts": artifacts,
        "audit_inputs": {"run_dir": str(run_dir), "candidate_lock": str(Path(candidate_lock).resolve()),
                         "binding": str(Path(binding).resolve()), "selection_manifest": str(Path(selection_manifest).resolve()),
                         "openings_tsv": str(Path(openings_tsv).resolve()),
                         "replay_base_revision": REPLAY_BASE_REVISION,
                         "replay_source_sha256": REPLAY_SOURCE_SHA256,
                         "look": look, "prior_receipt": str(Path(prior_receipt).resolve()) if prior_receipt else None},
    }


def verify_receipt(path: Path) -> dict:
    receipt = json.loads(Path(path).read_text(encoding="utf-8"))
    inputs = receipt.get("audit_inputs")
    if not isinstance(inputs, dict):
        raise protocol.ProtocolError("receipt lacks reproducible audit inputs")
    expected_input_keys = {"run_dir", "candidate_lock", "binding", "selection_manifest", "openings_tsv",
                           "replay_base_revision", "replay_source_sha256", "look", "prior_receipt"}
    if set(inputs) != expected_input_keys:
        raise protocol.ProtocolError("receipt contains unknown or missing audit inputs")
    if (inputs.get("replay_base_revision") != REPLAY_BASE_REVISION
            or inputs.get("replay_source_sha256") != REPLAY_SOURCE_SHA256
            or _sha(REPLAY_SOURCE) != REPLAY_SOURCE_SHA256):
        raise protocol.ProtocolError("receipt replay verifier trust anchor differs")
    audit_inputs = {key: value for key, value in inputs.items()
                    if key not in ("replay_base_revision", "replay_source_sha256")}
    rebuilt = audit_run(**{key: Path(value) if value is not None and key != "look" else value
                           for key, value in audit_inputs.items()})
    for key in ("candidate_id", "candidate_lock_sha256", "sample_sha256", "decision_interval", "cluster_scores", "artifacts"):
        if receipt.get(key) != rebuilt.get(key):
            raise protocol.ProtocolError(f"receipt does not reproduce: {key}")
    return receipt


def combine_receipts(look1_path: Path, look2_path: Path) -> dict:
    first, second = verify_receipt(look1_path), verify_receipt(look2_path)
    for key in ("candidate_id", "candidate_lock_sha256", "sample_sha256"):
        if first.get(key) != second.get(key):
            raise protocol.ProtocolError(f"two-look receipts differ: {key}")
    if first.get("look") != 1 or second.get("look") != 2:
        raise protocol.ProtocolError("combined M5 audit requires look 1 then look 2")
    stats = protocol.combine_cluster_scores(first["cluster_scores"], second["cluster_scores"])
    interval = stats["decision_97_5_hoeffding_serfling_score_interval"]
    verdict = "keep" if interval[0] > .5 else "discard" if interval[1] < .5 else "discard_inconclusive"
    return {"candidate_id": first["candidate_id"], "sample_sha256": first["sample_sha256"],
            **stats, "verdict": verdict, "effective_cluster_count": 100}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--candidate-lock", type=Path, required=True)
    parser.add_argument("--binding", type=Path, required=True)
    parser.add_argument("--selection-manifest", type=Path, required=True)
    parser.add_argument("--openings", type=Path, required=True)
    parser.add_argument("--look", type=int, choices=(1, 2), required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--prior-look-receipt", type=Path)
    args = parser.parse_args()
    result = audit_run(args.run, candidate_lock=args.candidate_lock, binding=args.binding,
                       selection_manifest=args.selection_manifest, openings_tsv=args.openings,
                       look=args.look, prior_receipt=args.prior_look_receipt)
    args.receipt.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "games": result["game_count"], "replayed": result["replayed_games"], "receipt": str(args.receipt)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
