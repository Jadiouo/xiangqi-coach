"""Bind a reviewed future-opening sample to one concrete runner TSV.

Selection, source and seed validation stay in the reviewed ``future_openings``
module. This adapter only binds its already-verified ordered sample to a run.
"""

import json
import hashlib
from pathlib import Path


EXPECTED_SCHEMA = "m4-future-opening-selection-v1"
EXPECTED_CANDIDATE_HEAD = "4a8a21aa111516124eada56eb37a5224a1e8fe87"
EXPECTED_CANDIDATE_BINARY_SHA256 = "2ee963e53eae374c93725021873949f338df6cc2d229325e3846c62ccf08b426"
EXPECTED_LOOK_COUNTS = {
    "look1_openings": 50,
    "look2_openings": 50,
    "union_openings": 100,
    "games_per_look": 200,
}


def verify_future_opening_look(manifest_path: Path, runner_tsv_path: Path, look: int) -> dict:
    """Verify sampler evidence and require the runner input to be exactly one ordered half."""
    manifest_path = Path(manifest_path).resolve()
    runner_tsv_path = Path(runner_tsv_path).resolve()
    if look not in (1, 2):
        raise ValueError("future opening look must be 1 or 2")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid future opening manifest: {error}") from error
    if not isinstance(manifest, dict) or manifest.get("schema") != EXPECTED_SCHEMA:
        raise ValueError("unsupported future opening selection manifest")
    candidate = manifest.get("candidate")
    if not isinstance(candidate, dict):
        raise ValueError("future opening manifest lacks candidate provenance")
    if candidate.get("git_head") != EXPECTED_CANDIDATE_HEAD:
        raise ValueError("future opening manifest candidate source HEAD mismatch")
    if candidate.get("binary_sha256") != EXPECTED_CANDIDATE_BINARY_SHA256:
        raise ValueError("future opening manifest candidate binary SHA-256 mismatch")
    if manifest.get("look_counts") != EXPECTED_LOOK_COUNTS:
        raise ValueError("future opening manifest look counts mismatch")
    lock_path = candidate.get("lock_path")
    candidate_repo_path = candidate.get("git_repo_path")
    if not isinstance(lock_path, str) or not Path(lock_path).is_absolute():
        raise ValueError("future opening manifest candidate lock path is invalid")
    if not isinstance(candidate_repo_path, str) or not Path(candidate_repo_path).is_absolute():
        raise ValueError("future opening manifest candidate repository path is invalid")
    registration = manifest.get("registration")
    source_repo_root = registration.get("source_repo_root") if isinstance(registration, dict) else None
    if not isinstance(source_repo_root, str) or not Path(source_repo_root).is_absolute():
        raise ValueError("future opening manifest registration source repository path is invalid")

    # This reviewed module owns population provenance and deterministic sampling.
    try:
        from future_openings import verify as verify_sample
    except ImportError as error:
        raise ValueError("reviewed future_openings verifier is unavailable") from error
    verified = verify_sample(Path(source_repo_root), Path(lock_path), manifest_path)
    if verified.get("status") != "locked-before-games" or verified.get("opening_count") != 100:
        raise ValueError("future opening verifier did not attest the locked ordered-100 sample")

    output_paths = manifest.get("output_paths")
    selected_name = output_paths.get(f"look{look}") if isinstance(output_paths, dict) else None
    if not isinstance(selected_name, str) or Path(selected_name).name != selected_name:
        raise ValueError("future opening manifest has an invalid look TSV path")
    expected_tsv = (manifest_path.parent / selected_name).resolve()
    if not expected_tsv.is_file() or not runner_tsv_path.is_file():
        raise ValueError("future opening look TSV is missing")
    if expected_tsv.read_bytes() != runner_tsv_path.read_bytes():
        raise ValueError(f"runner openings TSV does not match look {look}")

    output_sha = manifest.get("output_sha256")
    if not isinstance(output_sha, dict) or output_sha.get(selected_name) is None:
        raise ValueError("future opening manifest lacks the selected look TSV hash")
    import hashlib
    actual_tsv_sha = hashlib.sha256(runner_tsv_path.read_bytes()).hexdigest()
    if actual_tsv_sha != output_sha[selected_name]:
        raise ValueError("future opening look TSV hash does not match its manifest")
    if manifest.get("preregistration_sha256") is None:
        raise ValueError("future opening manifest lacks its preregistration digest")
    lines = runner_tsv_path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0] != "opening_id\tsource_ref\ticcs_prefix" or len(lines) != 51:
        raise ValueError("future opening look TSV must contain its header and exactly 50 rows")
    opening_ids = []
    for line in lines[1:]:
        fields = line.split("\t")
        if len(fields) != 3 or any(not field for field in fields):
            raise ValueError("future opening look TSV has an invalid row")
        opening_ids.append(fields[0])
    if len(opening_ids) != len(set(opening_ids)):
        raise ValueError("future opening look TSV contains duplicate opening IDs")
    return {
        "population_size": 153,
        "selected_count": 50,
        "input_count": 50,
        "full_selected_sample": True,
        "frozen_protocol_verified": True,
        "future_openings_verified": True,
        "ordered_sample_count": 100,
        "look": look,
        "manifest_path": str(manifest_path),
        "look_tsv_sha256": actual_tsv_sha,
        "opening_ids": opening_ids,
        "manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        "selection_manifest_sha256": verified["preregistration_sha256"],
    }
