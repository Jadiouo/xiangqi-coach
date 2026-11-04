"""Strict M5 candidate locks and two-look cluster decisions.

This module deliberately does not create a sample or start a match implicitly.
Callers must finish and freeze a candidate before invoking the M4 sampler.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

LOCK_SCHEMA = "xiangqi-m5-candidate-lock-v1"
RECEIPT_SCHEMA = "xiangqi-m5-look-receipt-v1"
POPULATION_SIZE = 153
BASELINE_FLAGS = {
    "RootAlpha": True,
    "CheckExtensions": True,
    "KillerHistoryOrdering": False,
    "NullMove": False,
    "LateMoveReductions": False,
}
M5_COMMON_OPTIONS = {"MultiPV": "1"}
TARGET_FLAGS = ("KillerHistoryOrdering", "NullMove", "LateMoveReductions")


class ProtocolError(ValueError):
    pass


def sha(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def validate_flag_pair(baseline: dict, candidate: dict, target: str) -> bool:
    if target not in TARGET_FLAGS:
        raise ProtocolError("candidate target must be KH, NullMove, or LMR profile flag")
    if (not isinstance(baseline, dict) or set(baseline) != set(BASELINE_FLAGS)
            or not isinstance(candidate, dict) or set(candidate) != set(BASELINE_FLAGS)):
        raise ProtocolError("flag maps must contain the complete M5 baseline option set")
    if any(type(value) is not bool for value in [*baseline.values(), *candidate.values()]):
        raise ProtocolError("all candidate flags must be explicit booleans")
    if baseline != BASELINE_FLAGS:
        raise ProtocolError("baseline flags differ from the accepted M4 RootAlpha+CheckExtensions profile")
    changes = [key for key in baseline if baseline[key] != candidate[key]]
    if changes != [target] or candidate[target] is not True:
        raise ProtocolError("candidate must enable exactly its named flag over the accepted baseline")
    return True


def verify_lock(lock_path: Path) -> dict:
    lock_path = Path(lock_path).resolve()
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"invalid candidate lock: {exc}") from exc
    if not isinstance(lock, dict) or lock.get("schema") != LOCK_SCHEMA or lock.get("status") != "locked":
        raise ProtocolError("unsupported or unlocked M5 candidate lock")
    candidate_id = lock.get("candidate_id")
    if not isinstance(candidate_id, str) or not candidate_id.strip():
        raise ProtocolError("candidate_id is required")
    target = lock.get("target")
    validate_flag_pair(lock.get("baseline_flags"), lock.get("candidate_flags"), target)
    if lock.get("common_options") != M5_COMMON_OPTIONS:
        raise ProtocolError("candidate lock must pin M5 common options to MultiPV=1")
    repo = Path(lock.get("git_repo_path", "")).resolve()
    head = lock.get("git_head")
    config_rel = lock.get("config_path")
    binary = Path(lock.get("binary_path", "")).resolve()
    if not isinstance(head, str) or len(head) != 40 or not isinstance(config_rel, str) or not config_rel:
        raise ProtocolError("lock requires a Git HEAD and tracked config path")
    config = (repo / config_rel).resolve()
    try:
        config.relative_to(repo)
        actual_head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "--verify", "HEAD"], text=True, stderr=subprocess.PIPE).strip()
        dirty = subprocess.check_output(["git", "-C", str(repo), "status", "--porcelain", "--untracked-files=all"], text=True, stderr=subprocess.PIPE)
        subprocess.run(["git", "-C", str(repo), "ls-files", "--error-unmatch", str(config.relative_to(repo))], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        raise ProtocolError(f"candidate source/config cannot be verified: {exc}") from exc
    if actual_head != head or dirty.strip():
        raise ProtocolError("candidate source must match the locked clean Git HEAD")
    if not config.is_file() or sha(config) != lock.get("config_sha256"):
        raise ProtocolError("candidate tracked config is missing or changed")
    try:
        config_data = json.loads(config.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"candidate config is invalid JSON: {exc}") from exc
    for field in ("candidate_id", "target", "baseline_flags", "candidate_flags", "common_options"):
        if config_data.get(field) != lock.get(field):
            raise ProtocolError(f"tracked config does not match lock: {field}")
    if not binary.is_file() or sha(binary) != lock.get("binary_sha256"):
        raise ProtocolError("candidate immutable binary is missing or changed")
    return {
        "candidate_id": candidate_id, "target": target, "flags": lock["candidate_flags"],
        "common_options": lock["common_options"],
        "git_head": actual_head, "config_sha256": sha(config), "binary_sha256": sha(binary),
        "binary_path": str(binary), "config_path": str(config),
        "lock_sha256": sha(lock_path), "lock_path": str(lock_path),
    }


def authorize_look2(receipt: dict, candidate_id: str, sample_sha256: str) -> bool:
    if not isinstance(receipt, dict) or receipt.get("schema") != RECEIPT_SCHEMA or receipt.get("status") != "complete":
        raise ProtocolError("look 2 requires a complete M5 look 1 audit receipt")
    expected = {
        "look": 1, "candidate_id": candidate_id, "sample_sha256": sample_sha256,
        "error_count": 0, "unfinished_games": 0, "game_count": 200, "raw_replay_valid": True,
    }
    for key, value in expected.items():
        if receipt.get(key) != value:
            raise ProtocolError(f"look 1 receipt mismatch: {key}")
    interval = receipt.get("decision_interval")
    if (not isinstance(interval, list) or len(interval) != 2
            or any(type(value) not in (int, float) for value in interval)
            or interval[0] > interval[1] or not 0 <= interval[0] <= interval[1] <= 1):
        raise ProtocolError("look 1 receipt has an invalid decision interval")
    if not interval[0] <= 0.5 <= interval[1]:
        raise ProtocolError("look 2 is allowed only when look 1 decision interval crosses 0.5")
    return True


def _interval(mean: float, n: int, alpha: float, population: int | None = None) -> list[float]:
    # Reuse the reviewed M4 composite formula verbatim for n/N and no-FPC intervals.
    import sys
    m4_dir = str(Path(__file__).resolve().parents[1] / "m4")
    if m4_dir not in sys.path:
        sys.path.insert(0, m4_dir)
    from composite_statistics import _interval as reviewed_interval
    if population is not None and (n > population or n < 1):
        raise ProtocolError("invalid finite-population sample size")
    return reviewed_interval(mean, alpha, population, n)


def combine_cluster_scores(look1: dict[str, float], look2: dict[str, float]) -> dict:
    if not isinstance(look1, dict) or not isinstance(look2, dict) or len(look1) != 50 or len(look2) != 50:
        raise ProtocolError("each look must contain exactly 50 opening-cluster scores")
    if set(look1) & set(look2):
        raise ProtocolError("look samples overlap")
    scores = {**look1, **look2}
    if any(type(value) not in (int, float) or not 0 <= value <= 1 for value in scores.values()):
        raise ProtocolError("opening-cluster scores must be numbers in [0, 1]")
    mean = sum(scores.values()) / 100
    return {
        "cluster_count": 100, "population_size": POPULATION_SIZE, "score_mean": mean,
        "report_95_ordinary_hoeffding_score_interval": _interval(mean, 100, .05),
        "decision_97_5_hoeffding_serfling_score_interval": _interval(mean, 100, .025, POPULATION_SIZE),
    }


def bind_selection(candidate_lock_path: Path, selection_manifest_path: Path, ordered_sample_path: Path) -> dict:
    """Create a deterministic M5 sidecar binding sampler output to this candidate lock."""
    candidate = verify_lock(candidate_lock_path)
    try:
        manifest = json.loads(Path(selection_manifest_path).read_text(encoding="utf-8"))
        rows = [json.loads(line) for line in Path(ordered_sample_path).read_text(encoding="utf-8").splitlines() if line]
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"invalid selection artifacts: {exc}") from exc
    if (manifest.get("schema") != "m4-future-opening-selection-v1"
            or manifest.get("status") != "locked-before-games"
            or manifest.get("candidate", {}).get("lock_sha256") != candidate["lock_sha256"]):
        raise ProtocolError("selection is not locked to this exact M5 candidate lock")
    try:
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "m4"))
        import future_openings
        source_root = Path(manifest["registration"]["source_repo_root"])
        future_openings.verify(source_root, candidate_lock_path, selection_manifest_path)
    except (KeyError, OSError, ValueError) as exc:
        raise ProtocolError(f"M4 frozen population/sample verification failed: {exc}") from exc
    if len(rows) != 100 or len({row.get("opening_id") for row in rows}) != 100:
        raise ProtocolError("selection must be one ordered sample of 100 unique openings")
    if manifest.get("look_counts") != {"look1_openings": 50, "look2_openings": 50, "union_openings": 100, "games_per_look": 200}:
        raise ProtocolError("selection look counts differ from the M5 profile")
    payload = {
        "schema": "xiangqi-m5-selection-binding-v1", "candidate_id": candidate["candidate_id"],
        "candidate_lock_sha256": candidate["lock_sha256"],
        "selection_manifest_sha256": sha(selection_manifest_path),
        "ordered_sample_sha256": sha(ordered_sample_path),
        "opening_ids": [row["opening_id"] for row in rows],
        "look1_ids": [row["opening_id"] for row in rows[:50]],
        "look2_ids": [row["opening_id"] for row in rows[50:]],
    }
    payload["sample_sha256"] = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return payload

M5_PROFILE_TARGETS = {
    "kh": "KillerHistoryOrdering", "nullmove": "NullMove", "lmr": "LateMoveReductions",
}


def option_map(flags: dict[str, bool]) -> dict[str, str]:
    return {key: "true" if value else "false" for key, value in flags.items()}


def runner_options(flags: dict[str, bool]) -> dict[str, str]:
    return {**option_map(flags), **M5_COMMON_OPTIONS}


def validate_runner_profile(profile: str, run: dict, engine_a_options: dict, engine_b_options: dict) -> bool:
    target = M5_PROFILE_TARGETS.get(profile)
    if target is None:
        raise ProtocolError("M5 profile must be kh, nullmove, or lmr")
    candidate_flags = dict(BASELINE_FLAGS)
    candidate_flags[target] = True
    expected_a = runner_options(candidate_flags)
    expected_b = runner_options(BASELINE_FLAGS)
    if engine_a_options != expected_a or engine_b_options != expected_b:
        raise ProtocolError("M5 runner options differ from the one-flag candidate and accepted baseline")
    look = run.get("look")
    expected = {
        "global_round_start": 1 if look == 1 else 3,
        "global_round_count": 2, "games": 200, "nodes": 10000, "seed": 1,
        "max_ply": 4096, "workers": 4, "engine_timeout": 30.0,
    }
    if look not in (1, 2):
        raise ProtocolError("M5 look must be 1 or 2")
    for key, value in expected.items():
        if run.get(key) != value:
            raise ProtocolError(f"M5 {profile} look {look} requires {key}={value}")
    return True


def verify_runner_selection(candidate_lock_path: Path, binding_path: Path, selection_manifest_path: Path,
                            runner_tsv_path: Path, look: int, profile: str) -> dict:
    candidate = verify_lock(candidate_lock_path)
    if M5_PROFILE_TARGETS.get(profile) != candidate["target"]:
        raise ProtocolError("M5 profile target differs from frozen candidate lock")
    binding_path = Path(binding_path).resolve()
    try:
        binding = json.loads(binding_path.read_text(encoding="utf-8"))
        manifest = json.loads(Path(selection_manifest_path).read_text(encoding="utf-8"))
        rows = [json.loads(line) for line in (Path(selection_manifest_path).parent / "ordered-100.jsonl").read_text(encoding="utf-8").splitlines() if line]
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"invalid M5 selection binding: {exc}") from exc
    expected = bind_selection(candidate_lock_path, selection_manifest_path,
                              Path(selection_manifest_path).parent / "ordered-100.jsonl")
    if binding != expected:
        raise ProtocolError("M5 selection binding does not match current candidate/sample hashes")
    source_root = Path(manifest["registration"]["source_repo_root"])
    sys_path = str(Path(__file__).resolve().parents[1] / "m4")
    import sys
    if sys_path not in sys.path:
        sys.path.insert(0, sys_path)
    import future_openings
    verified = future_openings.verify(source_root, candidate_lock_path, selection_manifest_path)
    tsv_name = manifest["output_paths"].get(f"look{look}")
    expected_tsv = Path(selection_manifest_path).parent / tsv_name
    if Path(runner_tsv_path).read_bytes() != expected_tsv.read_bytes():
        raise ProtocolError(f"runner TSV does not equal M5 look {look} ordered half")
    ids = binding["look1_ids"] if look == 1 else binding["look2_ids"]
    tsv_ids = [line.split("\t", 1)[0] for line in Path(runner_tsv_path).read_text(encoding="utf-8").splitlines()[1:]]
    if ids != tsv_ids:
        raise ProtocolError("look binding IDs do not match selected runner half")
    return {
        "population_size": POPULATION_SIZE, "selected_count": 50, "input_count": 50,
        "full_selected_sample": True, "frozen_protocol_verified": True,
        "future_openings_verified": True, "ordered_sample_count": 100, "look": look,
        "manifest_path": str(Path(selection_manifest_path).resolve()),
        "look_tsv_sha256": sha(runner_tsv_path), "opening_ids": ids,
        "manifest_sha256": sha(selection_manifest_path),
        "selection_manifest_sha256": verified["preregistration_sha256"],
        "sample_sha256": binding["sample_sha256"],
        "candidate_id": candidate["candidate_id"],
        "candidate_lock_sha256": candidate["lock_sha256"],
    }


def validate_prior_receipt(receipt_path: Path, candidate: dict, sample_sha256: str) -> dict:
    try:
        receipt = json.loads(Path(receipt_path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"invalid M5 prior-look receipt: {exc}") from exc
    authorize_look2(receipt, candidate["candidate_id"], sample_sha256)
    try:
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import audit
        audited = audit.verify_receipt(receipt_path)
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"look 1 receipt does not reproduce through M5 auditor: {exc}") from exc
    if audited.get("look") != 1:
        raise ProtocolError("prior M5 receipt is not look 1")
    if receipt.get("candidate_lock_sha256") != candidate["lock_sha256"]:
        raise ProtocolError("look 1 receipt candidate lock differs")
    artifacts = receipt.get("artifacts")
    if not isinstance(artifacts, dict) or not artifacts:
        raise ProtocolError("look 1 receipt lacks audited artifact hashes")
    for name, ref in artifacts.items():
        if not isinstance(ref, dict) or not isinstance(ref.get("path"), str) or not isinstance(ref.get("sha256"), str):
            raise ProtocolError(f"look 1 receipt has invalid artifact reference: {name}")
        path = Path(ref["path"])
        if not path.is_file() or sha(path) != ref["sha256"]:
            raise ProtocolError(f"look 1 receipt artifact changed: {name}")
    return receipt
