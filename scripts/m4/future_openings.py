#!/usr/bin/env python3
"""Prepare and verify the future M5 two-look opening sample."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import random
import re
import secrets
import subprocess
import sys
from pathlib import Path
from typing import Any


SCHEMA = "m4-future-opening-selection-v1"
POPULATION_SIZE = 153
SAMPLE_SIZE = 100
LOOK_SIZE = 50
TSV_HEADER = "opening_id\tsource_ref\ticcs_prefix\n"
OUTPUT_NAMES = {
    "ordered_openings": "ordered-100.jsonl",
    "look1": "look1.tsv",
    "look2": "look2.tsv",
}
MANIFEST_NAME = "selection-manifest.json"
REGISTRATION_DIR = "future-opening-selection-locks"

# These pins make the canonical CLI specific to the reviewed M4 opening source.
# Tests replace this mapping only in-process to use entirely synthetic fixtures.
SOURCE_SHA256S = {
    "docs/research/m4-openings/eligible-population.jsonl": "5e5d3595f9f08ad9fc10fe791de31454e73c726501cdc0c33d2a7c31a777e86e",
    "docs/research/m4-openings/selected-50.jsonl": "09225f85a6b906aa66baa0aa095c4b4b88f7aa420e63cded286ab92988ddbcee",
    "docs/research/m4-openings/selected-50.tsv": "2052a3f47ad38b5b2d7dc72004ea21faccc62df8a3dfccb0ce0f86a2fdf4cf88",
    "docs/research/m4-openings/opening-selection-protocol.json": "15b7eb11d8bab5ed860d9ab93f96c2feee5863f2127e311eacc25db55cab0c64",
    "docs/research/m4-validation/future-opening-protocol/remaining-153.jsonl": "2e429c377eebd47abad175d2ae726130cf2f2060b5fe0ce02bb458d7d46848ce",
    "docs/research/m4-validation/future-opening-protocol/manifest.json": "90197e05de66a4567fb3eff31fed0c09d2911738499b6bc2a620d587d7cf4c7e",
    "docs/research/m4-validation/future-opening-protocol/protocol-proposal.md": "c414ba88240e954b28c9443008613a6f676f5ea8ee65435446e1b477cfaa5f8f",
}

ORIGINAL_MANIFEST_NAMES = {
    "eligible-population.jsonl": "docs/research/m4-openings/eligible-population.jsonl",
    "selected-50.jsonl": "docs/research/m4-openings/selected-50.jsonl",
    "selected-50.tsv": "docs/research/m4-openings/selected-50.tsv",
    "opening-selection-protocol.json": "docs/research/m4-openings/opening-selection-protocol.json",
}


class ProtocolError(Exception):
    """Input or provenance does not satisfy the frozen protocol."""


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    try:
        return _sha256_bytes(path.read_bytes())
    except OSError as exc:
        raise ProtocolError(f"missing or unreadable file: {path}") from exc


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"invalid JSON file: {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ProtocolError(f"expected JSON object: {path}")
    return value


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
        rows = [json.loads(line) for line in lines if line.strip()]
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"invalid JSONL file: {path}: {exc}") from exc
    if any(not isinstance(row, dict) for row in rows):
        raise ProtocolError(f"expected JSON objects in {path}")
    return rows


def _hash_sources(repo_root: Path) -> dict[str, str]:
    actual: dict[str, str] = {}
    for relative, expected in SOURCE_SHA256S.items():
        path = repo_root / relative
        actual[relative] = _sha256_file(path)
        if actual[relative] != expected:
            raise ProtocolError(f"pinned source SHA-256 mismatch: {relative}")
    return actual


def verify_population(repo_root: Path) -> list[dict[str, Any]]:
    """Read and validate the canonical finite population without sampling."""
    repo_root = repo_root.resolve()
    actual_hashes = _hash_sources(repo_root)
    base = repo_root / "docs/research/m4-openings"
    future = repo_root / "docs/research/m4-validation/future-opening-protocol"
    eligible = _read_jsonl(base / "eligible-population.jsonl")
    old = _read_jsonl(base / "selected-50.jsonl")
    remaining = _read_jsonl(future / "remaining-153.jsonl")
    source_protocol = _read_json(base / "opening-selection-protocol.json")
    future_manifest = _read_json(future / "manifest.json")

    if (len(eligible), len(old), len(remaining)) != (203, 50, POPULATION_SIZE):
        raise ProtocolError("pinned population counts are not 203/50/153")

    def identity(rows: list[dict[str, Any]], label: str) -> tuple[set[str], set[str]]:
        ids = [row.get("opening_id") for row in rows]
        keys = [row.get("position_key") for row in rows]
        if any(not isinstance(value, str) or not value for value in ids + keys):
            raise ProtocolError(f"missing opening identity in {label}")
        if len(set(ids)) != len(rows):
            raise ProtocolError(f"duplicate opening_id in {label}")
        if len(set(keys)) != len(rows):
            raise ProtocolError(f"duplicate position_key in {label}")
        return set(ids), set(keys)

    eligible_ids, eligible_keys = identity(eligible, "eligible population")
    old_ids, old_keys = identity(old, "old selected population")
    remaining_ids, remaining_keys = identity(remaining, "remaining population")
    if eligible_ids != old_ids | remaining_ids or old_ids & remaining_ids:
        raise ProtocolError("remaining population is not the exact ID difference")
    if eligible_keys != old_keys | remaining_keys or old_keys & remaining_keys:
        raise ProtocolError("remaining population overlaps the old sample or omits positions")

    eligible_by_key = {row["position_key"]: row for row in eligible}
    eligible_by_id = {row["opening_id"]: row for row in eligible}
    for selected in old + remaining:
        source = eligible_by_key.get(selected["position_key"])
        if source is None or source.get("opening_id") != selected["opening_id"]:
            raise ProtocolError("opening identity/FEN does not match the eligible source")
        if selected.get("fen") is not None and source.get("fen") != selected.get("fen"):
            raise ProtocolError("opening FEN differs from the eligible source")
    if [row["opening_id"] for row in remaining] != sorted(remaining_ids):
        raise ProtocolError("remaining population ordering is not ascending opening_id")

    if source_protocol.get("eligible_population_sha256") != actual_hashes[ORIGINAL_MANIFEST_NAMES["eligible-population.jsonl"]]:
        raise ProtocolError("original protocol does not reference the pinned eligible population")
    if source_protocol.get("selected_population_sha256") != actual_hashes[ORIGINAL_MANIFEST_NAMES["selected-50.jsonl"]]:
        raise ProtocolError("original protocol does not reference the pinned old sample")
    if source_protocol.get("runner_tsv_sha256") != actual_hashes[ORIGINAL_MANIFEST_NAMES["selected-50.tsv"]]:
        raise ProtocolError("original protocol does not reference the pinned runner TSV")
    if source_protocol.get("eligible_population_count") != 203 or source_protocol.get("selected_count") != 50:
        raise ProtocolError("original selection protocol does not attest the 203-to-50 population counts")
    for name, relative in ORIGINAL_MANIFEST_NAMES.items():
        if future_manifest.get("source_files_sha256", {}).get(name) != actual_hashes[relative]:
            raise ProtocolError(f"future population manifest has incorrect source reference: {name}")
    if future_manifest.get("schema") != "future-opening-remaining-v1":
        raise ProtocolError("unrecognized remaining-population manifest schema")
    if future_manifest.get("population_size") != POPULATION_SIZE or future_manifest.get("excluded_old_selected_count") != 50:
        raise ProtocolError("remaining-population manifest count mismatch")
    if future_manifest.get("selection_executed") is not False:
        raise ProtocolError("remaining-population evidence must not claim an executed sample")
    if future_manifest.get("entries_file") != "remaining-153.jsonl" or future_manifest.get("entries_sha256") != actual_hashes["docs/research/m4-validation/future-opening-protocol/remaining-153.jsonl"]:
        raise ProtocolError("remaining-population manifest entry hash mismatch")
    if future_manifest.get("current_protocol_sha256") != actual_hashes["docs/research/m4-validation/future-opening-protocol/protocol-proposal.md"]:
        raise ProtocolError("remaining-population manifest protocol hash mismatch")

    tsv_path = base / "selected-50.tsv"
    try:
        tsv_rows = list(csv.DictReader(io.StringIO(tsv_path.read_text(encoding="utf-8")), delimiter="\t"))
    except (OSError, UnicodeError, csv.Error) as exc:
        raise ProtocolError(f"invalid old runner TSV: {exc}") from exc
    if len(tsv_rows) != 50 or {row.get("opening_id") for row in tsv_rows} != old_ids:
        raise ProtocolError("old runner TSV does not describe the selected 50")
    for row in old:
        tsv_row = next(item for item in tsv_rows if item.get("opening_id") == row["opening_id"])
        source_ref = row.get("source_pgn_url", row.get("source_url"))
        if tsv_row.get("source_ref") != source_ref or tsv_row.get("iccs_prefix") != row.get("iccs_prefix"):
            raise ProtocolError("old runner TSV source fields do not match selected JSONL")
    # The reviewed remaining manifest is intentionally compact. Sampling and
    # runner TSVs use the matching full source rows so IDs inherit their URL
    # and ICCS prefix from the pinned eligible source.
    return [eligible_by_id[row["opening_id"]] for row in remaining]


def _candidate_record(lock_path: Path) -> dict[str, Any]:
    lock_path = lock_path.resolve()
    lock = _read_json(lock_path)
    if lock.get("status") != "locked":
        raise ProtocolError("candidate lock must have status 'locked'")
    repo_value = lock.get("git_repo_path")
    expected_head = lock.get("git_head")
    binary_value = lock.get("binary_path")
    binary_sha = lock.get("binary_sha256")
    config_value = lock.get("config_path")
    config_sha = lock.get("config_sha256")
    if not all(isinstance(v, str) and v for v in (repo_value, expected_head, binary_value, binary_sha, config_value, config_sha)):
        raise ProtocolError("candidate lock is missing a source, binary, or config reference")
    if not re.fullmatch(r"[0-9a-f]{40}", expected_head) or not re.fullmatch(r"[0-9a-f]{64}", binary_sha) or not re.fullmatch(r"[0-9a-f]{64}", config_sha):
        raise ProtocolError("candidate lock contains a malformed Git or SHA-256 reference")
    repo = Path(repo_value).resolve()
    binary = Path(binary_value).resolve()
    config = (repo / config_value).resolve()
    try:
        config.relative_to(repo)
    except ValueError as exc:
        raise ProtocolError("candidate config must be inside the candidate Git repository") from exc
    if not repo.is_dir() or not binary.is_file() or not config.is_file():
        raise ProtocolError("candidate Git repository, binary, or config file is missing")

    try:
        head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "--verify", "HEAD"], text=True, stderr=subprocess.PIPE).strip()
        dirty = subprocess.check_output(["git", "-C", str(repo), "status", "--porcelain", "--untracked-files=all"], text=True, stderr=subprocess.PIPE)
        subprocess.run(["git", "-C", str(repo), "ls-files", "--error-unmatch", str(config.relative_to(repo))], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ProtocolError(f"candidate Git reference is not verifiable: {exc}") from exc
    if head != expected_head:
        raise ProtocolError("candidate Git HEAD differs from its locked reference")
    if dirty.strip():
        raise ProtocolError("candidate Git worktree is dirty")
    actual_binary_sha = _sha256_file(binary)
    actual_config_sha = _sha256_file(config)
    if actual_binary_sha != binary_sha:
        raise ProtocolError("candidate binary SHA-256 differs from its locked reference")
    if actual_config_sha != config_sha:
        raise ProtocolError("candidate config SHA-256 differs from its locked reference")
    return {
        "lock_path": str(lock_path),
        "lock_sha256": _sha256_file(lock_path),
        "git_repo_path": str(repo),
        "git_head": head,
        "binary_path": str(binary),
        "binary_sha256": actual_binary_sha,
        "config_path": str(config.relative_to(repo)),
        "config_sha256": actual_config_sha,
    }


def _git_common_dir(repo_root: Path) -> Path:
    try:
        value = subprocess.check_output(
            ["git", "-C", str(repo_root), "rev-parse", "--git-common-dir"],
            text=True,
            stderr=subprocess.PIPE,
        ).strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ProtocolError(f"source checkout Git metadata is unavailable: {exc}") from exc
    path = Path(value)
    if not path.is_absolute():
        path = repo_root / path
    path = path.resolve()
    if not path.is_dir():
        raise ProtocolError("source checkout Git common directory is missing")
    return path


def _candidate_key(candidate: dict[str, Any]) -> str:
    stable = {key: candidate[key] for key in (
        "git_repo_path", "git_head", "binary_path", "binary_sha256", "config_path", "config_sha256"
    )}
    return _sha256_bytes(_canonical_json(stable))


def _registration_path(repo_root: Path, candidate: dict[str, Any]) -> Path:
    return _git_common_dir(repo_root) / REGISTRATION_DIR / f"{_candidate_key(candidate)}.json"


def _write_exclusive_registration(path: Path, registration: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    encoded = json.dumps(registration, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8") + b"\n"
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise ProtocolError(f"candidate already has a sampling registration: {path}; use its recorded retry lock") from exc
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as exc:
        raise ProtocolError(f"could not persist exclusive sampling registration: {path}") from exc


def _replace_registration(path: Path, registration: dict[str, Any]) -> None:
    encoded = json.dumps(registration, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8") + b"\n"
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except OSError as exc:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise ProtocolError(f"could not finalize sampling registration: {path}") from exc


def _seed_provenance(
    repo_root: Path,
    candidate_lock_path: Path,
    manifest_path: Path,
    manifest: dict[str, Any],
    visited: set[Path],
) -> None:
    source = manifest.get("seed_source")
    provenance = manifest.get("seed_provenance")
    if source == "os-entropy" and provenance == {"method": "secrets.token_bytes(8)"}:
        return
    if source != "reproduced-manifest" or not isinstance(provenance, dict):
        raise ProtocolError("manifest seed source is not production OS entropy or verified-manifest reproduction")
    source_path_value = provenance.get("manifest_path")
    source_file_sha = provenance.get("manifest_sha256")
    source_lock_sha = provenance.get("preregistration_sha256")
    if not isinstance(source_path_value, str) or not re.fullmatch(r"[0-9a-f]{64}", str(source_file_sha)) or not re.fullmatch(r"[0-9a-f]{64}", str(source_lock_sha)):
        raise ProtocolError("reproduced seed provenance is incomplete")
    source_path = Path(source_path_value).resolve()
    if source_path == manifest_path or source_path in visited:
        raise ProtocolError("reproduced seed provenance contains a cycle")
    if _sha256_file(source_path) != source_file_sha:
        raise ProtocolError("reproduced seed source manifest file hash mismatch")
    previous, _ = _verify_manifest(repo_root, candidate_lock_path, source_path, visited | {manifest_path})
    if previous.get("seed_u64") != manifest.get("seed_u64") or previous.get("preregistration_sha256") != source_lock_sha:
        raise ProtocolError("reproduced seed does not match the verified source manifest")


def _serialize_jsonl(rows: list[dict[str, Any]]) -> bytes:
    return b"".join(_canonical_json(row) + b"\n" for row in rows)


def _runner_tsv(rows: list[dict[str, Any]]) -> bytes:
    lines = [TSV_HEADER]
    for row in rows:
        source_ref = row.get("source_pgn_url", row.get("source_url"))
        prefix = row.get("iccs_prefix")
        if not isinstance(source_ref, str) or not isinstance(prefix, str):
            raise ProtocolError("population row lacks runner source URL or ICCS prefix")
        if any("\t" in value or "\n" in value for value in (row["opening_id"], source_ref, prefix)):
            raise ProtocolError("tab/newline in runner TSV field")
        lines.append(f"{row['opening_id']}\t{source_ref}\t{prefix}\n")
    return "".join(lines).encode("utf-8")


def _manifest_lock_hash(manifest: dict[str, Any]) -> str:
    without_hash = {key: value for key, value in manifest.items() if key != "preregistration_sha256"}
    return _sha256_bytes(_canonical_json(without_hash))


def _verify_manifest(
    repo_root: Path,
    candidate_lock_path: Path,
    manifest_path: Path,
    visited: set[Path] | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    population = verify_population(repo_root)
    candidate = _candidate_record(candidate_lock_path)
    manifest_path = manifest_path.resolve()
    visited = visited or set()
    if manifest_path in visited:
        raise ProtocolError("selection manifest provenance cycle")
    manifest = _read_json(manifest_path)
    if manifest.get("schema") != SCHEMA or manifest.get("status") != "locked-before-games":
        raise ProtocolError("unsupported or unlocked selection manifest")
    if manifest.get("candidate") != candidate:
        raise ProtocolError("candidate source, binary, config, or lock differs from manifest")
    if manifest.get("source_sha256") != SOURCE_SHA256S:
        raise ProtocolError("manifest source references differ from pinned canonical sources")
    if manifest.get("population") != {"path": "remaining-153.jsonl", "size": POPULATION_SIZE, "sha256": SOURCE_SHA256S["docs/research/m4-validation/future-opening-protocol/remaining-153.jsonl"]}:
        raise ProtocolError("manifest population reference differs from the approved finite population")
    if manifest.get("population_order") != "ascending opening_id" or manifest.get("algorithm") != "random.Random(seed_u64).sample(ordered_population, 100), without replacement":
        raise ProtocolError("manifest sampling algorithm or population ordering mismatch")
    seed = manifest.get("seed_u64")
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed < 2**64:
        raise ProtocolError("manifest seed is not an unsigned 64-bit integer")
    if manifest.get("python_version") != sys.version.split()[0] or not isinstance(manifest.get("seed_source"), str):
        raise ProtocolError("manifest Python version is unsupported or seed source is missing")
    _seed_provenance(repo_root, candidate_lock_path, manifest_path, manifest, visited | {manifest_path})
    if manifest.get("output_paths") != {
        "ordered_openings": OUTPUT_NAMES["ordered_openings"],
        "look1": OUTPUT_NAMES["look1"],
        "look2": OUTPUT_NAMES["look2"],
    }:
        raise ProtocolError("manifest output paths do not match the fixed layout")
    output_dir = manifest_path.parent
    ordered_path = output_dir / OUTPUT_NAMES["ordered_openings"]
    ordered_rows = _read_jsonl(ordered_path)
    if len(ordered_rows) != SAMPLE_SIZE:
        raise ProtocolError("ordered sample is not exactly 100 openings")
    ids = [row.get("opening_id") for row in ordered_rows]
    keys = [row.get("position_key") for row in ordered_rows]
    if len(set(ids)) != SAMPLE_SIZE or len(set(keys)) != SAMPLE_SIZE:
        raise ProtocolError("ordered sample contains duplicate opening IDs or positions")
    pool_by_id = {row["opening_id"]: row for row in population}
    if any(row not in pool_by_id.values() or pool_by_id.get(row.get("opening_id")) != row for row in ordered_rows):
        raise ProtocolError("ordered sample contains an opening outside the approved population")
    expected_sample = random.Random(seed).sample(
        sorted(population, key=lambda row: row["opening_id"]), SAMPLE_SIZE
    )
    if ordered_rows != expected_sample:
        raise ProtocolError("ordered sample does not reproduce from the locked seed and algorithm")

    expected_data = {
        OUTPUT_NAMES["ordered_openings"]: _serialize_jsonl(ordered_rows),
        OUTPUT_NAMES["look1"]: _runner_tsv(ordered_rows[:LOOK_SIZE]),
        OUTPUT_NAMES["look2"]: _runner_tsv(ordered_rows[LOOK_SIZE:]),
    }
    output_hashes = manifest.get("output_sha256")
    if not isinstance(output_hashes, dict) or set(output_hashes) != set(expected_data):
        raise ProtocolError("manifest output hashes are incomplete")
    for name, expected_bytes in expected_data.items():
        path = output_dir / name
        actual_bytes = path.read_bytes() if path.is_file() else None
        if actual_bytes != expected_bytes or output_hashes.get(name) != _sha256_bytes(expected_bytes):
            raise ProtocolError(f"sampling output is missing or its content/hash differs: {name}")
    if manifest.get("look_counts") != {"look1_openings": 50, "look2_openings": 50, "union_openings": 100, "games_per_look": 200}:
        raise ProtocolError("manifest look counts or non-overlap contract mismatch")
    if ids[:LOOK_SIZE] != [row["opening_id"] for row in ordered_rows[:LOOK_SIZE]] or ids[LOOK_SIZE:] != [row["opening_id"] for row in ordered_rows[LOOK_SIZE:]]:
        raise ProtocolError("look ordering differs from the frozen ordered sample")
    prereg_hash = manifest.get("preregistration_sha256")
    if prereg_hash != _manifest_lock_hash(manifest):
        raise ProtocolError("preregistration lock hash mismatch")
    registration_info = manifest.get("registration")
    if not isinstance(registration_info, dict):
        raise ProtocolError("manifest lacks its exclusive sampling registration reference")
    source_repo_root_value = registration_info.get("source_repo_root")
    if not isinstance(source_repo_root_value, str):
        raise ProtocolError("manifest registration lacks its source checkout reference")
    source_repo_root = Path(source_repo_root_value).resolve()
    registration_path = _registration_path(source_repo_root, candidate)
    if registration_info != {
        "path": str(registration_path),
        "candidate_key": _candidate_key(candidate),
        "source_repo_root": str(source_repo_root),
    }:
        raise ProtocolError("manifest registration path or candidate key mismatch")
    registration = _read_json(registration_path)
    if registration.get("schema") != "m4-future-opening-registration-v1" or registration.get("status") != "complete":
        raise ProtocolError("sampling registration is absent or not complete")
    if registration.get("candidate") != candidate or registration.get("candidate_key") != _candidate_key(candidate):
        raise ProtocolError("registration candidate reference mismatch")
    if registration.get("source_sha256") != SOURCE_SHA256S or registration.get("source_repo_root") != str(source_repo_root) or registration.get("output_dir") != str(output_dir):
        raise ProtocolError("registration source or reserved output path mismatch")
    if registration.get("seed_u64") != seed or registration.get("seed_source") != manifest.get("seed_source") or registration.get("seed_provenance") != manifest.get("seed_provenance"):
        raise ProtocolError("registration seed record differs from manifest")
    if registration.get("preregistration_sha256") != prereg_hash or registration.get("manifest_sha256") != _sha256_file(manifest_path):
        raise ProtocolError("completed registration manifest hashes mismatch")
    return manifest, ordered_rows


def verify(repo_root: Path, candidate_lock_path: Path, manifest_path: Path) -> dict[str, Any]:
    """Read-only validation of sources, candidate lock, manifest, and output files."""
    manifest, rows = _verify_manifest(repo_root, candidate_lock_path, manifest_path)
    return {"status": manifest["status"], "opening_count": len(rows), "seed_u64": manifest["seed_u64"], "preregistration_sha256": manifest["preregistration_sha256"]}


def _read_resume_registration(
    repo_root: Path,
    candidate_lock_path: Path,
    candidate: dict[str, Any],
    registration_path: Path,
    output_dir: Path,
) -> dict[str, Any]:
    expected_path = _registration_path(repo_root, candidate)
    registration_path = registration_path.resolve()
    if registration_path != expected_path:
        raise ProtocolError("retry lock is not the exclusive registration for this candidate")
    registration = _read_json(registration_path)
    if registration.get("schema") != "m4-future-opening-registration-v1" or registration.get("status") != "reserved":
        raise ProtocolError("retry requires an incomplete exclusive registration")
    if registration.get("candidate") != candidate or registration.get("candidate_key") != _candidate_key(candidate):
        raise ProtocolError("retry candidate does not match its original registration")
    if registration.get("source_sha256") != SOURCE_SHA256S:
        raise ProtocolError("retry source hashes differ from the original registration")
    if registration.get("source_repo_root") != str(repo_root) or registration.get("output_dir") != str(output_dir):
        raise ProtocolError("retry must use the originally reserved source and output path")
    if output_dir.exists():
        raise ProtocolError("retry output path already exists; refusing to overwrite it")
    seed = registration.get("seed_u64")
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed < 2**64:
        raise ProtocolError("retry registration has an invalid original seed")
    seed_source = registration.get("seed_source")
    provenance = registration.get("seed_provenance")
    if seed_source == "os-entropy":
        if provenance != {"method": "secrets.token_bytes(8)"}:
            raise ProtocolError("retry registration has invalid OS-entropy seed provenance")
    elif seed_source == "reproduced-manifest" and isinstance(provenance, dict):
        source_manifest_value = provenance.get("manifest_path")
        source_file_sha = provenance.get("manifest_sha256")
        source_lock_sha = provenance.get("preregistration_sha256")
        if not isinstance(source_manifest_value, str) or not re.fullmatch(r"[0-9a-f]{64}", str(source_file_sha)) or not re.fullmatch(r"[0-9a-f]{64}", str(source_lock_sha)):
            raise ProtocolError("retry registration has incomplete reproduced-seed provenance")
        source_manifest = Path(source_manifest_value).resolve()
        if _sha256_file(source_manifest) != source_file_sha:
            raise ProtocolError("retry registration source manifest hash mismatch")
        previous, _ = _verify_manifest(repo_root, candidate_lock_path, source_manifest)
        if previous.get("seed_u64") != seed or previous.get("preregistration_sha256") != source_lock_sha:
            raise ProtocolError("retry registration seed differs from its verified source manifest")
    else:
        raise ProtocolError("retry registration has a non-production seed source")
    return registration


def _finalize_registration(
    registration_path: Path,
    registration: dict[str, Any],
    manifest_path: Path,
    manifest: dict[str, Any],
) -> None:
    completed = dict(registration)
    completed.update({
        "status": "complete",
        "preregistration_sha256": manifest["preregistration_sha256"],
        "manifest_sha256": _sha256_file(manifest_path),
    })
    _replace_registration(registration_path, completed)


def generate(
    repo_root: Path,
    candidate_lock_path: Path,
    output_dir: Path,
    *,
    reproduce_manifest: Path | None = None,
    resume_lock: Path | None = None,
) -> dict[str, Any]:
    """Create one sample per candidate; retries must use its reserved lock."""
    repo_root = repo_root.resolve()
    candidate_lock_path = candidate_lock_path.resolve()
    output_dir = output_dir.resolve()
    if output_dir.exists() and resume_lock is None:
        raise ProtocolError(f"refusing to overwrite existing output path: {output_dir}")

    # All immutable references and candidate state are verified before entropy
    # is read. The exclusive reservation then fixes the candidate, source,
    # seed, and only permitted output path before random.sample is called.
    population = verify_population(repo_root)
    candidate = _candidate_record(candidate_lock_path)
    registration_path = _registration_path(repo_root, candidate)
    if resume_lock is not None and reproduce_manifest is not None:
        raise ProtocolError("retry lock and seed reproduction cannot be combined")

    if resume_lock is not None:
        registration = _read_resume_registration(repo_root, candidate_lock_path, candidate, resume_lock, output_dir)
        seed = registration["seed_u64"]
        seed_source = registration["seed_source"]
        seed_provenance = registration["seed_provenance"]
    else:
        if registration_path.exists():
            raise ProtocolError(f"candidate sampling is already reserved or complete: {registration_path}")
        if output_dir.exists():
            raise ProtocolError(f"refusing to overwrite existing output path: {output_dir}")
        if reproduce_manifest is not None:
            prior, _ = _verify_manifest(repo_root, candidate_lock_path, reproduce_manifest)
            seed = prior["seed_u64"]
            seed_source = "reproduced-manifest"
            seed_provenance = {
                "manifest_path": str(Path(reproduce_manifest).resolve()),
                "manifest_sha256": _sha256_file(Path(reproduce_manifest).resolve()),
                "preregistration_sha256": prior["preregistration_sha256"],
            }
        else:
            seed = int.from_bytes(secrets.token_bytes(8), "big")
            seed_source = "os-entropy"
            seed_provenance = {"method": "secrets.token_bytes(8)"}
        if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed < 2**64:
            raise ProtocolError("seed must be an unsigned 64-bit integer")
        registration = {
            "schema": "m4-future-opening-registration-v1",
            "status": "reserved",
            "candidate_key": _candidate_key(candidate),
            "candidate": candidate,
            "source_sha256": dict(SOURCE_SHA256S),
            "source_repo_root": str(repo_root),
            "output_dir": str(output_dir),
            "output_paths": {
                **OUTPUT_NAMES,
                "manifest": MANIFEST_NAME,
            },
            "seed_u64": seed,
            "seed_source": seed_source,
            "seed_provenance": seed_provenance,
        }
        _write_exclusive_registration(registration_path, registration)

    try:
        ordered_population = sorted(population, key=lambda row: row["opening_id"])
        selected = random.Random(seed).sample(ordered_population, SAMPLE_SIZE)
        outputs = {
            OUTPUT_NAMES["ordered_openings"]: _serialize_jsonl(selected),
            OUTPUT_NAMES["look1"]: _runner_tsv(selected[:LOOK_SIZE]),
            OUTPUT_NAMES["look2"]: _runner_tsv(selected[LOOK_SIZE:]),
        }
    except Exception as exc:
        raise ProtocolError(
            f"sample preparation failed; reservation retained; retry only with --resume-lock {registration_path} "
            f"and the originally reserved output path {output_dir}: {exc}"
        ) from exc
    manifest: dict[str, Any] = {
        "schema": SCHEMA,
        "status": "locked-before-games",
        "algorithm": "random.Random(seed_u64).sample(ordered_population, 100), without replacement",
        "python_version": sys.version.split()[0],
        "seed_u64": seed,
        "seed_source": seed_source,
        "seed_provenance": seed_provenance,
        "population_order": "ascending opening_id",
        "source_sha256": dict(SOURCE_SHA256S),
        "population": {
            "path": "remaining-153.jsonl",
            "size": POPULATION_SIZE,
            "sha256": SOURCE_SHA256S["docs/research/m4-validation/future-opening-protocol/remaining-153.jsonl"],
        },
        "candidate": candidate,
        "registration": {
            "path": str(registration_path),
            "candidate_key": _candidate_key(candidate),
            "source_repo_root": str(repo_root),
        },
        "output_paths": {
            "ordered_openings": OUTPUT_NAMES["ordered_openings"],
            "look1": OUTPUT_NAMES["look1"],
            "look2": OUTPUT_NAMES["look2"],
        },
        "output_sha256": {name: _sha256_bytes(data) for name, data in outputs.items()},
        "look_counts": {"look1_openings": 50, "look2_openings": 50, "union_openings": 100, "games_per_look": 200},
    }
    manifest["preregistration_sha256"] = _manifest_lock_hash(manifest)
    manifest_bytes = json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8") + b"\n"
    created_output_dir = False
    try:
        output_dir.mkdir(parents=True, exist_ok=False)
        created_output_dir = True
        for name, data in outputs.items():
            (output_dir / name).write_bytes(data)
        manifest_path = output_dir / MANIFEST_NAME
        manifest_path.write_bytes(manifest_bytes)
    except OSError as exc:
        if created_output_dir and output_dir.exists():
            for child in output_dir.iterdir():
                if child.is_file() or child.is_symlink():
                    child.unlink()
            output_dir.rmdir()
        raise ProtocolError(
            f"could not create fresh output directory; reservation retained; retry only with --resume-lock "
            f"{registration_path} and the originally reserved output path {output_dir}: {exc}"
        ) from exc
    _finalize_registration(registration_path, registration, manifest_path, manifest)
    _verify_manifest(repo_root, candidate_lock_path, manifest_path)
    return {"manifest": manifest, "ordered_openings": selected}


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    population = sub.add_parser("verify-population", help="verify only the pinned 153-opening source")
    population.add_argument("--repo-root", type=Path, required=True)

    generate_parser = sub.add_parser("generate", help="one-time locked selection after the candidate is frozen")
    generate_parser.add_argument("--repo-root", type=Path, required=True)
    generate_parser.add_argument("--candidate-lock", type=Path, required=True)
    generate_parser.add_argument("--output-dir", type=Path, required=True)
    generate_parser.add_argument("--reproduce-manifest", type=Path)
    generate_parser.add_argument("--resume-lock", type=Path)

    verify_parser = sub.add_parser("verify", help="read-only verification of an existing sample")
    verify_parser.add_argument("--repo-root", type=Path, required=True)
    verify_parser.add_argument("--candidate-lock", type=Path, required=True)
    verify_parser.add_argument("--manifest", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "verify-population":
            rows = verify_population(args.repo_root)
            print(json.dumps({"status": "verified", "population_size": len(rows)}, sort_keys=True))
        elif args.command == "generate":
            result = generate(
                args.repo_root,
                args.candidate_lock,
                args.output_dir,
                reproduce_manifest=args.reproduce_manifest,
                resume_lock=args.resume_lock,
            )
            print(json.dumps({"status": result["manifest"]["status"], "manifest": str(args.output_dir / MANIFEST_NAME), "preregistration_sha256": result["manifest"]["preregistration_sha256"]}, sort_keys=True))
        else:
            print(json.dumps(verify(args.repo_root, args.candidate_lock, args.manifest), sort_keys=True))
        return 0
    except ProtocolError as exc:
        print(f"future_openings: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
