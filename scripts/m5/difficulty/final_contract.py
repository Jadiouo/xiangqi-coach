"""Frozen source/profile/holdout contract for the eight formal M5 difficulty pairs."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
from typing import Mapping, Sequence

from calibration.calibration import _components
from scripts.m4.future_openings import SOURCE_SHA256S as OPENING_SOURCE_SHA256S
from difficulty_match import (
    BASELINE_OPTIONS, CALLER_NODES, MAX_PLY, WORKERS,
    _opening_set_digest, audit_run_directory, verify_source_group_disjoint,
)


class FinalContractError(ValueError):
    """Raised when a final difficulty freeze, selection, or series is inconsistent."""


PROFILE_RE = re.compile(
    r"Profile\s*\{\s*node_limit:\s*([0-9_]+|u64::MAX)\s*,\s*"
    r"noise_cp:\s*([0-9][0-9_]*)\s*,\s*rank_weights:\s*\[\s*([0-9][0-9_]*)\s*,\s*([0-9][0-9_]*)\s*,\s*"
    r"([0-9][0-9_]*)\s*,\s*([0-9][0-9_]*)\s*,\s*([0-9][0-9_]*)\s*\]\s*,?\s*\}"
)

CANONICAL_ELIGIBLE = "docs/research/m4-openings/eligible-population.jsonl"
CANONICAL_PILOT = "docs/research/m4-openings/selected-50.jsonl"
SELECTION_REGISTRATION_DIR = "m5-difficulty-final-selection-locks"
PIPELINE_SOURCE_FILES = (
    "scripts/m5/difficulty/cli.py",
    "scripts/m5/difficulty/difficulty_match.py",
    "scripts/m5/difficulty/final_contract.py",
    "scripts/m4/match.py",
    "scripts/m4/future_openings.py",
    "scripts/m4/audit_q_capture.py",
    "scripts/m4/composite_statistics.py",
    "scripts/m5/audit.py",
    "scripts/m5/protocol.py",
    "scripts/m5/calibration/calibration.py",
)


def _canonical_sha(value: object) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def _file_sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _jsonl(path: Path) -> list[dict]:
    try:
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
    except (OSError, json.JSONDecodeError) as error:
        raise FinalContractError(f"invalid JSONL input {path}: {error}") from error


def _verify_canonical_population(repo: Path, eligible_file: Path, pilot_file: Path) -> None:
    expected_eligible = (repo / CANONICAL_ELIGIBLE).resolve()
    expected_pilot = (repo / CANONICAL_PILOT).resolve()
    if eligible_file != expected_eligible or pilot_file != expected_pilot:
        raise FinalContractError("production freeze accepts only the pinned canonical 203/50 input paths")
    if (_file_sha(eligible_file) != OPENING_SOURCE_SHA256S[CANONICAL_ELIGIBLE]
            or _file_sha(pilot_file) != OPENING_SOURCE_SHA256S[CANONICAL_PILOT]):
        raise FinalContractError("production population/pilot bytes differ from the reviewed canonical source pins")


def parse_profile_table(path: Path) -> list[dict]:
    """Extract the ten concrete profiles from the source file which is also pinned."""
    source = Path(path).read_text(encoding="utf-8")
    parsed = []
    for node, noise, *weights in PROFILE_RE.findall(source):
        parsed.append({
            "level": len(parsed) + 1,
            "node_limit": 2**64 - 1 if node == "u64::MAX" else int(node.replace("_", "")),
            "noise_cp": int(noise.replace("_", "")),
            "rank_weights": [int(value.replace("_", "")) for value in weights],
        })
    if len(parsed) != 10:
        raise FinalContractError(f"profile source must contain exactly ten parseable profiles; got {len(parsed)}")
    return parsed


def _git_value(repo: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(repo), *args], check=False,
                            capture_output=True, text=True)
    if result.returncode:
        raise FinalContractError(f"git {' '.join(args)} failed for {repo}: {result.stderr.strip()}")
    return result.stdout.strip()


def _source_tree_sha(repo: Path, head: str) -> str:
    archive = subprocess.run(["git", "-C", str(repo), "archive", "--format=tar", head],
                             check=False, capture_output=True)
    if archive.returncode:
        raise FinalContractError(f"cannot archive frozen source: {archive.stderr.decode(errors='replace')}")
    return hashlib.sha256(archive.stdout).hexdigest()


def _pipeline_source_identity() -> dict:
    """Pin the actual tool checkout and direct source files used by this caller."""
    entrypoint = Path(__file__).resolve()
    repo = Path(_git_value(entrypoint.parent, "rev-parse", "--show-toplevel")).resolve()
    try:
        entrypoint_relative = entrypoint.relative_to(repo).as_posix()
    except ValueError as error:
        raise FinalContractError("actual difficulty pipeline entrypoint is outside its Git checkout") from error
    head = _git_value(repo, "rev-parse", "HEAD")
    status = _git_value(repo, "status", "--porcelain=v1", "--untracked-files=all")
    untracked_output = _git_value(repo, "ls-files", "--others", "--exclude-standard")
    untracked_files = {}
    for relative in filter(None, untracked_output.splitlines()):
        path = repo / relative
        if path.is_symlink() or not path.is_file():
            raise FinalContractError(f"untracked pipeline input is not a regular file: {relative}")
        untracked_files[relative] = _file_sha(path)
    diff = subprocess.run(["git", "-C", str(repo), "diff", "HEAD", "--binary"],
                          check=False, capture_output=True)
    if diff.returncode:
        raise FinalContractError("cannot fingerprint actual difficulty pipeline working tree")
    files = {}
    for relative in PIPELINE_SOURCE_FILES:
        path = repo / relative
        if not path.is_file() or path.is_symlink():
            raise FinalContractError(f"actual difficulty pipeline source is missing or not regular: {relative}")
        files[relative] = _file_sha(path)
    return {
        "repo_path": str(repo),
        "entrypoint_path": entrypoint_relative,
        "git_head": head,
        "git_tree_sha256": _source_tree_sha(repo, head),
        "working_tree_status_sha256": hashlib.sha256(status.encode()).hexdigest(),
        "tracked_diff_sha256": hashlib.sha256(diff.stdout).hexdigest(),
        "untracked_files_sha256": untracked_files,
        "files_sha256": files,
    }


def _verify_pipeline_source(freeze: Mapping[str, object]) -> None:
    pinned = freeze.get("pipeline")
    if not isinstance(pinned, Mapping):
        raise FinalContractError("freeze lacks the actual difficulty pipeline source pin")
    if dict(pinned) != _pipeline_source_identity():
        raise FinalContractError("actual difficulty pipeline checkout or source files differ from freeze")


def verify_uci_product_interface(binary: Path) -> str:
    """Run the candidate's real UCI handshake and verify the frozen difficulty interface."""
    try:
        result = subprocess.run([str(Path(binary).resolve())], input="uci\nquit\n",
                                capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise FinalContractError(f"candidate UCI handshake failed: {error}") from error
    transcript = result.stdout
    if result.returncode != 0 or "uciok" not in transcript.splitlines():
        raise FinalContractError("candidate UCI handshake did not complete successfully")
    advertised: dict[str, tuple[str, str, set[str]]] = {}
    for line in transcript.splitlines():
        if not line.startswith("option name "):
            continue
        match = re.match(r"option name (.+?) type (check|spin|combo) default (\S+)(.*)$", line)
        if not match:
            continue
        name, kind, default, tail = match.groups()
        advertised[name] = (kind, default, set(re.findall(r"\bvar (\S+)", tail)))
    required = {
        "UCI_Variant": ("combo", "xiangqi"), "MultiPV": ("spin", "1"),
        "Strategy": ("combo", "difficulty"), "DifficultyLevel": ("spin", "10"),
        "RandomSeed": ("spin", "1"), "RootAlpha": ("check", "true"),
        "CheckExtensions": ("check", "true"),
        "KillerHistoryOrdering": ("check", "true"),
    }
    for name, (kind, value) in required.items():
        actual = advertised.get(name)
        if actual is None or actual[0] != kind:
            raise FinalContractError(f"candidate UCI does not advertise required {kind} option {name}")
        if name in {"UCI_Variant", "Strategy"} and value not in actual[2]:
            raise FinalContractError(f"candidate UCI option {name} does not support {value}")
        if name not in {"UCI_Variant", "Strategy"} and actual[1] != value:
            raise FinalContractError(f"candidate UCI option {name} default differs from frozen product interface")
    withdrawn = {"NullMove", "LateMoveReductions"}.intersection(advertised)
    if withdrawn:
        raise FinalContractError(f"candidate UCI still advertises withdrawn options: {sorted(withdrawn)}")
    return hashlib.sha256(transcript.encode()).hexdigest()


def verify_uci_product_interface(binary: Path) -> str:
    """Run the actual executable's UCI handshake and verify current supported options."""
    try:
        result = subprocess.run([str(Path(binary).resolve())], input="uci\nquit\n",
                                capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise FinalContractError(f"candidate UCI handshake failed: {error}") from error
    transcript = result.stdout
    if result.returncode != 0 or "uciok" not in transcript.splitlines():
        raise FinalContractError("candidate UCI handshake did not complete successfully")
    advertised: dict[str, tuple[str, str, set[str]]] = {}
    for line in transcript.splitlines():
        if not line.startswith("option name "):
            continue
        match = re.match(r"option name (.+?) type (check|spin|combo) default (\S+)(.*)$", line)
        if match is None:
            continue
        name, kind, default, tail = match.groups()
        advertised[name] = (kind, default, set(re.findall(r"\bvar (\S+)", tail)))
    required = {
        "UCI_Variant": ("combo", "xiangqi"), "MultiPV": ("spin", "1"),
        "Strategy": ("combo", "difficulty"), "DifficultyLevel": ("spin", "10"),
        "RandomSeed": ("spin", "1"), "RootAlpha": ("check", "true"),
        "CheckExtensions": ("check", "true"),
        "KillerHistoryOrdering": ("check", "true"),
    }
    for name, (kind, expected) in required.items():
        actual = advertised.get(name)
        if actual is None or actual[0] != kind:
            raise FinalContractError(f"candidate UCI does not advertise required {kind} option {name}")
        if name in {"UCI_Variant", "Strategy"} and expected not in actual[2]:
            raise FinalContractError(f"candidate UCI option {name} does not support {expected}")
        if name not in {"UCI_Variant", "Strategy"} and actual[1] != expected:
            raise FinalContractError(f"candidate UCI option {name} default differs from current product interface")
    withdrawn = {"NullMove", "LateMoveReductions"}.intersection(advertised)
    if withdrawn:
        raise FinalContractError(f"candidate UCI still advertises withdrawn options: {sorted(withdrawn)}")
    return hashlib.sha256(transcript.encode()).hexdigest()


def _timestamp(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError) as error:
        raise FinalContractError("timestamps must be ISO-8601 with timezone") from error
    if parsed.tzinfo is None:
        raise FinalContractError("timestamps must include a timezone")
    return parsed.astimezone(timezone.utc)


def create_final_freeze(*, source_repo: Path, binary_path: Path, profile_path: Path,
                        eligible_path: Path, pilot_path: Path,
                        engine_options: Mapping[str, str], master_seed: int,
                        freeze_time: str, binary_build_source_head: str) -> dict:
    """Freeze code, one executable, all ten profiles, flags and pre-sampling inputs."""
    repo = Path(source_repo).resolve()
    binary = Path(binary_path).resolve()
    profile_file = Path(profile_path).resolve()
    eligible_file = Path(eligible_path).resolve()
    pilot_file = Path(pilot_path).resolve()
    if not repo.is_dir() or not binary.is_file() or not os.access(binary, os.X_OK):
        raise FinalContractError("source checkout and executable binary must exist")
    if subprocess.run(["git", "-C", str(repo), "diff", "--quiet", "HEAD", "--"]).returncode:
        raise FinalContractError("source checkout has tracked modifications")
    head = _git_value(repo, "rev-parse", "HEAD")
    if binary_build_source_head != head:
        raise FinalContractError("binary build source HEAD must equal the frozen candidate source HEAD")
    try:
        profile_relative = profile_file.relative_to(repo).as_posix()
    except ValueError as error:
        raise FinalContractError("profile source must be inside the frozen source checkout") from error
    if not profile_file.is_file():
        raise FinalContractError("profile source file is missing")
    _verify_canonical_population(repo, eligible_file, pilot_file)
    profiles = parse_profile_table(profile_file)
    if dict(engine_options) != BASELINE_OPTIONS:
        raise FinalContractError("accepted UCI flags must exactly match this runner's supported baseline options")
    handshake_sha256 = verify_uci_product_interface(binary)
    handshake_sha256 = verify_uci_product_interface(binary)
    if isinstance(master_seed, bool) or not isinstance(master_seed, int) or not 0 <= master_seed <= 0xFFFFFFFFFFFFFFFF:
        raise FinalContractError("master seed must be an unsigned 64-bit integer")
    eligible_rows = _jsonl(eligible_file)
    pilot_rows = _jsonl(pilot_file)
    if len(eligible_rows) != 203 or len(pilot_rows) != 50:
        raise FinalContractError("freeze requires the canonical 203-row population and original 50-opening pilot")
    try:
        component_map = _components(eligible_rows)
    except Exception as error:
        raise FinalContractError(f"invalid canonical population component keys: {error}") from error
    if len(component_map) != 128 or len({row.get("position_key") for row in eligible_rows}) != 203:
        raise FinalContractError("canonical population must contain 128 source components and 203 unique positions")
    for name, rows in (("eligible", eligible_rows), ("pilot", pilot_rows)):
        ids = [row.get("opening_id") for row in rows]
        if any(not isinstance(item, str) or not item for item in ids) or len(set(ids)) != len(rows):
            raise FinalContractError(f"{name} opening IDs must be unique non-empty strings")
    population_by_id = {row["opening_id"]: row for row in eligible_rows}
    for row in pilot_rows:
        source_row = population_by_id.get(row.get("opening_id"))
        if source_row is None or source_row.get("source_pgn_sha256") != row.get("source_pgn_sha256") or source_row.get("position_key") != row.get("position_key"):
            raise FinalContractError("pilot openings must be byte-identifiable members of the canonical population")
    _timestamp(freeze_time)
    body = {
        "schema": "m5-difficulty-final-freeze-v2",
        "frozen_at": freeze_time,
        "pipeline": _pipeline_source_identity(),
        "source": {"repo_path": str(repo), "git_head": head,
                   "tree_sha256": _source_tree_sha(repo, head),
                   "profile_path": profile_relative, "profile_sha256": _file_sha(profile_file)},
        "engine": {"path": str(binary), "sha256": _file_sha(binary),
                   "binary_build_source_head": binary_build_source_head,
                   "uci_handshake_sha256": handshake_sha256},
        "profiles": profiles,
        "accepted_engine_options": dict(engine_options),
        "runtime": {"run_kind": "final", "caller_nodes": CALLER_NODES,
                    "max_ply": MAX_PLY, "workers": WORKERS,
                    "engine_timeout_seconds": 30.0, "master_seed": master_seed,
                    "lower_levels": list(range(1, 9)), "openings_per_pair": 50,
                    "games_per_pair": 100, "required_win_fraction": 0.65},
        "population": {"path": str(eligible_file), "sha256": _file_sha(eligible_file),
                       "row_count": len(eligible_rows)},
        "pilot_selection": {"path": str(pilot_file), "sha256": _file_sha(pilot_file),
                            "row_count": len(pilot_rows)},
    }
    body["freeze_sha256"] = _canonical_sha(body)
    return body


def _verify_freeze(freeze: Mapping[str, object]) -> None:
    body = dict(freeze)
    digest = body.pop("freeze_sha256", None)
    if not isinstance(digest, str) or _canonical_sha(body) != digest:
        raise FinalContractError("freeze content or identity hash mismatch")
    if freeze.get("schema") != "m5-difficulty-final-freeze-v2":
        raise FinalContractError("unsupported final freeze schema; an actual pipeline source pin is required")
    _verify_pipeline_source(freeze)
    source = freeze["source"]
    repo = Path(source["repo_path"])
    if (_git_value(repo, "rev-parse", "HEAD") != source["git_head"]
            or _source_tree_sha(repo, source["git_head"]) != source["tree_sha256"]
            or subprocess.run(["git", "-C", str(repo), "diff", "--quiet", "HEAD", "--"],
                              check=False).returncode != 0):
        raise FinalContractError("frozen source checkout identity changed")
    profile = repo / source["profile_path"]
    if _file_sha(profile) != source["profile_sha256"] or parse_profile_table(profile) != freeze["profiles"]:
        raise FinalContractError("frozen ten-level profile table changed")
    engine = freeze["engine"]
    binary = Path(engine["path"])
    if not binary.is_file() or not os.access(binary, os.X_OK) or _file_sha(binary) != engine["sha256"]:
        raise FinalContractError("frozen engine binary changed")
    if freeze["accepted_engine_options"] != BASELINE_OPTIONS:
        raise FinalContractError("frozen options are not supported by this runner")
    _verify_canonical_population(repo, Path(freeze["population"]["path"]).resolve(),
                                 Path(freeze["pilot_selection"]["path"]).resolve())
    for field in ("population", "pilot_selection"):
        pin = freeze[field]
        path = Path(pin["path"])
        if not path.is_file() or _file_sha(path) != pin["sha256"]:
            raise FinalContractError(f"frozen {field} input changed")


def _remaining_population(freeze: Mapping[str, object]) -> tuple[list[dict], set[str], int]:
    eligible = _jsonl(Path(freeze["population"]["path"]))
    pilot = _jsonl(Path(freeze["pilot_selection"]["path"]))
    if len(eligible) != 203 or len(pilot) != 50:
        raise FinalContractError("frozen population/pilot row count changed")
    try:
        component_map = _components(eligible)
    except Exception as error:
        raise FinalContractError(f"cannot derive shared source/position components: {error}") from error
    pilot_sources = {str(row["source_pgn_sha256"]) for row in pilot}
    removed = set()
    for source in pilot_sources:
        removed.update(component_map.get(source, ()))
    remaining = [row for row in eligible if row["source_pgn_sha256"] not in removed]
    components = {tuple(group) for source, group in component_map.items() if source not in removed}
    if len(removed) != 45 or len(remaining) != 124 or len(components) != 83:
        raise FinalContractError("excluding pilot-connected components must leave exactly 124 rows in 83 components")
    return remaining, pilot_sources, len(components)


def _select_from_recorded_event(freeze: Mapping[str, object], entropy_event: Mapping[str, object]) -> dict:
    """Pure deterministic selector; production entropy is supplied only by the caller below."""
    _verify_freeze(freeze)
    if entropy_event.get("observed_at") is None:
        raise FinalContractError("entropy event requires observed_at")
    if _timestamp(entropy_event["observed_at"]) <= _timestamp(freeze["frozen_at"]):
        raise FinalContractError("selection entropy must be recorded after the source/profile freeze")
    entropy_hex = entropy_event.get("entropy_hex")
    if not isinstance(entropy_hex, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", entropy_hex):
        raise FinalContractError("selection requires exactly 256 recorded entropy bits")
    event_id, source = entropy_event.get("event_id"), entropy_event.get("source")
    if not isinstance(event_id, str) or not event_id or not isinstance(source, str) or not source:
        raise FinalContractError("entropy source and unique event ID must be recorded")
    remaining, pilot_sources, component_count = _remaining_population(freeze)
    entropy = bytes.fromhex(entropy_hex)
    freeze_id = freeze["freeze_sha256"]
    ordered = sorted(remaining, key=lambda row: hashlib.sha256(
        entropy + b"\0" + freeze_id.encode() + b"\0" + row["opening_id"].encode()).digest())
    selected_rows = ordered[:50]
    normalized = [{"id": row["opening_id"], "source": row["source_pgn_url"],
                   "moves": row["iccs_prefix"].split(),
                   "source_group_sha256": row["source_pgn_sha256"]} for row in selected_rows]
    body = {
        "schema": "m5-difficulty-final-selection-v1",
        "freeze_sha256": freeze_id,
        "population_sha256": freeze["population"]["sha256"],
        "pilot_sha256": freeze["pilot_selection"]["sha256"],
        "eligible_after_pilot": {"rows": len(remaining), "components": component_count,
                                 "excluded_pilot_source_groups": sorted(pilot_sources)},
        "entropy": {"event_id": event_id, "source": source,
                    "observed_at": entropy_event["observed_at"],
                    "value_hex": entropy_hex.lower(),
                    "sha256": hashlib.sha256(entropy).hexdigest()},
        "ordering": "sha256(entropy_bytes || NUL || freeze_sha256 || NUL || opening_id), ascending bytes",
        "opening_ids": [row["id"] for row in normalized],
        "openings": normalized,
        "selected_position_keys": [row["position_key"] for row in selected_rows],
    }
    body["selection_sha256"] = _canonical_sha(body)
    return body


def _git_common_dir(repo: Path) -> Path:
    value = _git_value(repo, "rev-parse", "--git-common-dir")
    path = Path(value)
    return (path if path.is_absolute() else repo / path).resolve()


def _candidate_identity(freeze: Mapping[str, object]) -> dict:
    """Fields which identify a candidate independently of timestamps/output locations."""
    return {
        "source": {key: freeze["source"][key] for key in
                   ("git_head", "tree_sha256", "profile_path", "profile_sha256")},
        "pipeline": dict(freeze["pipeline"]),
        "engine_binary_sha256": freeze["engine"]["sha256"],
        "accepted_engine_options": freeze["accepted_engine_options"],
        "population_sha256": freeze["population"]["sha256"],
        "pilot_sha256": freeze["pilot_selection"]["sha256"],
    }


def _exclusive_registration(path: Path, record: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    payload = json.dumps(record, ensure_ascii=False, sort_keys=True, indent=2).encode() + b"\n"
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as error:
        raise FinalContractError(f"candidate already has a final selection registration: {path}") from error
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())


def _replace_registration(path: Path, record: Mapping[str, object]) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(json.dumps(record, ensure_ascii=False, sort_keys=True, indent=2).encode() + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except OSError as error:
        temporary.unlink(missing_ok=True)
        raise FinalContractError(f"cannot finalize selection registration: {error}") from error


def _create_registered_selection(freeze: Mapping[str, object], output_dir: Path,
                                 entropy_event: Mapping[str, object] | None = None) -> dict:
    """Internal deterministic seam; callers in production use OS entropy via select_final_openings."""
    _verify_freeze(freeze)
    target = Path(output_dir).resolve()
    if target.exists():
        raise FinalContractError(f"refusing to overwrite selection directory: {target}")
    candidate = _candidate_identity(freeze)
    candidate_key = _canonical_sha(candidate)
    registration_path = _git_common_dir(Path(freeze["source"]["repo_path"])) / SELECTION_REGISTRATION_DIR / f"{candidate_key}.json"
    registration = {
        "schema": "m5-difficulty-final-selection-registration-v1", "status": "reserved",
        "candidate_key": candidate_key, "candidate": candidate,
        "freeze_sha256": freeze["freeze_sha256"], "output_dir": str(target),
    }
    _exclusive_registration(registration_path, registration)
    if entropy_event is None:
        entropy = secrets.token_bytes(32)
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        entropy_event = {"entropy_hex": entropy.hex(), "event_id": hashlib.sha256(entropy).hexdigest(),
                         "source": "Python secrets.token_bytes(32) OS entropy", "observed_at": now}
    selection = _select_from_recorded_event(freeze, entropy_event)
    selection["registration"] = {"candidate_key": candidate_key,
                                 "path": str(registration_path), "output_dir": str(target)}
    selection.pop("selection_sha256", None)
    selection["selection_sha256"] = _canonical_sha(selection)
    artifacts = write_final_selection(selection, target)
    registration.update({"status": "complete", "selection_sha256": selection["selection_sha256"],
                         "selection_file_sha256": artifacts["selection_sha256"],
                         "jsonl_sha256": artifacts["jsonl_sha256"], "tsv_sha256": artifacts["tsv_sha256"]})
    _replace_registration(registration_path, registration)
    return selection


def select_final_openings(freeze: Mapping[str, object], output_dir: Path) -> dict:
    """Draw OS entropy only after freeze, reserve candidate identity, then write one selection."""
    return _create_registered_selection(freeze, output_dir)


def write_final_selection(selection: Mapping[str, object], output_dir: Path) -> dict:
    """Persist the sampled JSON, runner JSONL and TSV once; never overwrite evidence."""
    target = Path(output_dir)
    if target.exists():
        raise FinalContractError(f"refusing to overwrite selection directory: {target}")
    target.mkdir(parents=True)
    json_path = target / "selection.json"
    jsonl_path = target / "selected-openings.jsonl"
    tsv_path = target / "selected-openings.tsv"
    json_path.write_text(json.dumps(selection, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    jsonl_path.write_text("".join(json.dumps({
        "opening_id": row["id"], "source_pgn_url": row["source"],
        "iccs_prefix": " ".join(row["moves"]),
        "source_pgn_sha256": row["source_group_sha256"],
        "position_key": position_key,
    }, ensure_ascii=False, sort_keys=True) + "\n"
        for row, position_key in zip(selection["openings"], selection["selected_position_keys"])), encoding="utf-8")
    tsv_path.write_text("opening_id\tsource_ref\ticcs_prefix\n" + "".join(
        f"{row['id']}\t{row['source']}\t{' '.join(row['moves'])}\n" for row in selection["openings"]),
        encoding="utf-8")
    return {"selection_path": str(json_path), "selection_sha256": _file_sha(json_path),
            "jsonl_path": str(jsonl_path), "jsonl_sha256": _file_sha(jsonl_path),
            "tsv_path": str(tsv_path), "tsv_sha256": _file_sha(tsv_path)}


def verify_final_selection(freeze: Mapping[str, object], selection: Mapping[str, object]) -> bool:
    event = selection.get("entropy", {})
    expected = _select_from_recorded_event(freeze, {
        "entropy_hex": event.get("value_hex"), "event_id": event.get("event_id"),
        "source": event.get("source"), "observed_at": event.get("observed_at"),
    })
    registration_info = selection.get("registration")
    if not isinstance(registration_info, dict):
        raise FinalContractError("final selection lacks its exclusive candidate registration")
    candidate = _candidate_identity(freeze)
    candidate_key = _canonical_sha(candidate)
    registration_path = _git_common_dir(Path(freeze["source"]["repo_path"])) / SELECTION_REGISTRATION_DIR / f"{candidate_key}.json"
    if registration_info != {"candidate_key": candidate_key, "path": str(registration_path),
                             "output_dir": registration_info.get("output_dir")}:
        raise FinalContractError("selection registration reference differs from the frozen candidate")
    try:
        registration = json.loads(registration_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise FinalContractError("candidate selection registration is missing or invalid") from error
    target = Path(str(registration_info.get("output_dir", ""))).resolve()
    if (registration.get("schema") != "m5-difficulty-final-selection-registration-v1"
            or registration.get("status") != "complete"
            or registration.get("candidate_key") != candidate_key
            or registration.get("candidate") != candidate
            or registration.get("freeze_sha256") != freeze["freeze_sha256"]
            or registration.get("output_dir") != str(target)):
        raise FinalContractError("candidate registration does not match the final selection")
    paths = {"selection_file_sha256": target / "selection.json",
             "jsonl_sha256": target / "selected-openings.jsonl",
             "tsv_sha256": target / "selected-openings.tsv"}
    if any(not path.is_file() or _file_sha(path) != registration.get(field)
           for field, path in paths.items()):
        raise FinalContractError("registered final selection artifact is missing or changed")
    try:
        disk_selection = json.loads((target / "selection.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise FinalContractError("registered selection JSON is unreadable") from error
    if disk_selection != dict(selection):
        raise FinalContractError("supplied selection differs from its registered JSON artifact")
    expected["registration"] = dict(registration_info)
    expected.pop("selection_sha256", None)
    expected["selection_sha256"] = _canonical_sha(expected)
    if registration.get("selection_sha256") != expected["selection_sha256"]:
        raise FinalContractError("registered selection identity hash mismatch")
    if dict(selection) != expected:
        raise FinalContractError("final selection does not reproduce from frozen inputs and recorded entropy")
    return True


def validate_final_contract_inputs(freeze: Mapping[str, object], selection: Mapping[str, object],
                                   openings: Sequence[Mapping[str, object]], master_seed: int,
                                   engine_command: str, lower_level: int) -> dict[str, str]:
    _verify_freeze(freeze)
    verify_final_selection(freeze, selection)
    if master_seed != freeze["runtime"]["master_seed"]:
        raise FinalContractError("run seed differs from frozen final configuration")
    if lower_level not in freeze["runtime"]["lower_levels"]:
        raise FinalContractError("level pair is outside the frozen eight pairs")
    if list(openings) != selection["openings"]:
        raise FinalContractError("runner openings differ from the frozen ordered holdout")
    import shlex
    import shutil
    words = shlex.split(engine_command)
    executable = shutil.which(words[0]) if words else None
    if executable is None:
        raise FinalContractError("final engine command is not executable")
    actual_path = str(Path(executable).resolve())
    actual_sha = _file_sha(Path(actual_path))
    if actual_path != freeze["engine"]["path"] or actual_sha != freeze["engine"]["sha256"]:
        raise FinalContractError("run engine differs from the frozen immutable binary")
    return {"freeze_sha256": freeze["freeze_sha256"],
            "selection_sha256": selection["selection_sha256"]}


def write_contract_once(path: Path, record: Mapping[str, object]) -> str:
    """Write a frozen JSON artifact without replacing any prior evidence."""
    target = Path(path)
    if target.exists():
        raise FinalContractError(f"refusing to overwrite contract artifact: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(record, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    target.write_text(payload, encoding="utf-8")
    return _file_sha(target)


def audit_final_series(freeze: Mapping[str, object], selection: Mapping[str, object],
                       batch_dirs: Mapping[int, Path]) -> dict:
    """Run trusted per-batch Game/raw audit, then require all eight frozen pairs."""
    _verify_freeze(freeze)
    verify_final_selection(freeze, selection)
    if set(batch_dirs) != set(range(1, 9)):
        raise FinalContractError("final series must contain exactly one batch for each pair 1v3 through 8v10")
    selected = selection["openings"]
    pilot_rows = _jsonl(Path(freeze["pilot_selection"]["path"]))
    pilot_openings = [{"source_group_sha256": row["source_pgn_sha256"]} for row in pilot_rows]
    pilot_groups = {str(row["source_group_sha256"]) for row in pilot_openings}
    verify_source_group_disjoint(pilot_openings, selected)
    pair_results = []
    for lower in range(1, 9):
        run_dir = Path(batch_dirs[lower])
        try:
            manifest = json.loads((run_dir / "run-manifest.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise FinalContractError(f"missing/malformed level {lower} batch manifest: {error}") from error
        identity = {"freeze_sha256": freeze["freeze_sha256"],
                    "selection_sha256": selection["selection_sha256"]}
        if manifest.get("final_contract_identity") != identity:
            raise FinalContractError(f"level {lower} batch is not bound to this freeze and selection")
        if (manifest.get("run_kind") != "final" or manifest.get("lower_level") != lower
                or manifest.get("higher_level") != lower + 2
                or manifest.get("master_seed") != freeze["runtime"]["master_seed"]
                or manifest.get("caller_nodes") != CALLER_NODES or manifest.get("max_ply") != MAX_PLY
                or manifest.get("workers") != WORKERS or manifest.get("engine_timeout_seconds") != 30.0
                or manifest.get("engine_options") != freeze["accepted_engine_options"]
                or manifest.get("opening_set_sha256") != _opening_set_digest(selected)
                or manifest.get("engine", {}).get("sha256") != freeze["engine"]["sha256"]):
            raise FinalContractError(f"level {lower} batch differs from the frozen final contract")
        audit = audit_run_directory(run_dir, selected, pilot_source_groups=pilot_groups,
                                    final_contract_identity=identity)
        if not audit.get("game_replay_valid") or not audit.get("raw_replay_valid") or not audit.get("complete"):
            raise FinalContractError(f"level {lower} batch lacks complete trusted Game/raw audit")
        pair_results.append({"lower_level": lower, "higher_level": lower + 2,
                             "wins": audit["wins"], "draws": audit["draws"],
                             "losses": audit["losses"], "games": audit["completed_games"],
                             "win_fraction": audit["win_fraction"], "passed": audit["passed"],
                             "audit": audit})
    complete = all(row["games"] == 100 for row in pair_results)
    return {"schema": "m5-difficulty-final-series-audit-v1",
            "freeze_sha256": freeze["freeze_sha256"],
            "selection_sha256": selection["selection_sha256"],
            "complete": complete, "formal_gate_eligible": complete,
            "passed": bool(complete and all(row["passed"] for row in pair_results)),
            "pairs": pair_results}
