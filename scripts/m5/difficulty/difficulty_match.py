"""Fixed-protocol helpers for paired M5 difficulty validation."""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import os
import queue
import re
import shlex
import shutil
import subprocess
from pathlib import Path
from typing import Mapping, Sequence

from scripts.m4 import match as m4_match
from scripts.m5.audit import trusted_replay


CALLER_NODES = 100_000
MAX_PLY = 4096
WORKERS = 4
BASELINE_OPTIONS = {
    "RootAlpha": "true",
    "CheckExtensions": "true",
    "KillerHistoryOrdering": "true",
    "MultiPV": "1",
    "Strategy": "difficulty",
}
SEED_SCHEME = "sha256(master_seed, game_id, engine_side)->game_seed;sha256(game_seed, absolute_ply)->RandomSeed-v1"


class DifficultyMatchError(ValueError):
    """Raised when a difficulty validation batch violates its fixed protocol."""


def validate_opening_count(opening_count: int, run_kind: str) -> int:
    if isinstance(opening_count, bool) or not isinstance(opening_count, int):
        raise DifficultyMatchError("opening count must be an integer")
    if run_kind == "pilot" and 1 <= opening_count <= 50:
        return opening_count
    if run_kind == "final" and opening_count == 50:
        return opening_count
    if run_kind not in {"pilot", "final"}:
        raise DifficultyMatchError("run_kind must explicitly be pilot or final")
    if run_kind == "final":
        raise DifficultyMatchError("final runs require exactly 50 openings")
    raise DifficultyMatchError("pilot runs require 1 through 50 fixed openings")


def apply_run_kind_gate(summary: Mapping[str, object], run_kind: str) -> dict:
    if run_kind not in {"pilot", "final"}:
        raise DifficultyMatchError("run_kind must explicitly be pilot or final")
    result = dict(summary)
    result["run_kind"] = run_kind
    if run_kind == "pilot":
        result["formal_gate_eligible"] = False
        result["passed"] = False
        result["formal_gate_note"] = "pilot evidence is never eligible for the formal difficulty gate"
    return result


def validate_pair_levels(lower_level: int, higher_level: int) -> None:
    if isinstance(lower_level, bool) or isinstance(higher_level, bool):
        raise DifficultyMatchError("difficulty levels must be integers")
    if not 1 <= lower_level <= 8 or higher_level != lower_level + 2:
        raise DifficultyMatchError("pair must be one of levels 1v3 through 8v10")


def _opening_set_digest(openings: Sequence[Mapping[str, object]]) -> str:
    payload = json.dumps(list(openings), sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


def derive_game_seed(master_seed: int, game_id: str, engine_side: str) -> int:
    if not 0 <= master_seed <= 0xFFFFFFFFFFFFFFFF or engine_side not in {"A", "B"}:
        raise DifficultyMatchError("invalid master seed or engine side")
    material = f"xiangqi-m5-difficulty-game-v1\0{master_seed}\0{game_id}\0{engine_side}".encode()
    return int.from_bytes(hashlib.sha256(material).digest()[:8], "big")


def derive_move_seed(game_seed: int, absolute_ply: int) -> int:
    if not 0 <= game_seed <= 0xFFFFFFFFFFFFFFFF or absolute_ply < 0:
        raise DifficultyMatchError("invalid game seed or ply")
    material = f"xiangqi-m5-difficulty-ply-v1\0{game_seed}\0{absolute_ply}".encode()
    return int.from_bytes(hashlib.sha256(material).digest()[:8], "big")


def difficulty_game_id(
    lower_level: int, higher_level: int, opening_id: str, high_is_red: bool, *, run_kind: str
) -> str:
    validate_pair_levels(lower_level, higher_level)
    if run_kind not in {"pilot", "final"}:
        raise DifficultyMatchError("run_kind must explicitly be pilot or final")
    color = "red" if high_is_red else "black"
    return f"difficulty-{run_kind}-{lower_level}v{higher_level}/{opening_id}/high-{color}"


def schedule_pair(
    openings: Sequence[Mapping[str, object]], *, lower_level: int, master_seed: int,
    run_kind: str = "pilot",
) -> list[dict]:
    validate_pair_levels(lower_level, lower_level + 2)
    if not openings:
        raise DifficultyMatchError("opening set must not be empty")
    validate_opening_count(len(openings), run_kind)
    opening_set_sha256 = _opening_set_digest(openings)
    rows = []
    seen = set()
    for opening in openings:
        opening_id = opening.get("id")
        source = opening.get("source")
        moves = opening.get("moves")
        if not isinstance(opening_id, str) or not opening_id or opening_id in seen:
            raise DifficultyMatchError("opening IDs must be unique non-empty strings")
        if not isinstance(source, str) or not source:
            raise DifficultyMatchError(f"opening {opening_id} lacks a source reference")
        if not isinstance(moves, (list, tuple)) or any(not isinstance(move, str) for move in moves):
            raise DifficultyMatchError(f"opening {opening_id} has invalid ICCS prefix")
        seen.add(opening_id)
        for high_is_red in (True, False):
            game_id = difficulty_game_id(lower_level, lower_level + 2, opening_id, high_is_red,
                                         run_kind=run_kind)
            rows.append({
                "game_id": game_id,
                "run_kind": run_kind,
                "opening_set_sha256": opening_set_sha256,
                "opening_id": opening_id,
                "source": source,
                "prefix": list(moves),
                "source_group_sha256": opening.get("source_group_sha256"),
                "high_level": lower_level + 2,
                "low_level": lower_level,
                "high_is_red": high_is_red,
                "master_seed": master_seed,
                "game_seed_high": derive_game_seed(master_seed, game_id, "A"),
                "game_seed_low": derive_game_seed(master_seed, game_id, "B"),
                "seed_scheme": SEED_SCHEME,
                "engine_a_options": dict(BASELINE_OPTIONS),
                "engine_b_options": dict(BASELINE_OPTIONS),
            })
    return rows


def verify_source_group_disjoint(
    pilot_openings: Sequence[Mapping[str, object]], final_openings: Sequence[Mapping[str, object]]
) -> None:
    """Require the final holdout to use source PGN groups absent from the pilot."""
    pilot = {row.get("source_group_sha256") for row in pilot_openings}
    final = {row.get("source_group_sha256") for row in final_openings}
    if not pilot_openings or not final_openings or None in pilot or None in final:
        raise DifficultyMatchError("pilot and final openings must include source PGN SHA groups")
    overlap = pilot & final
    if overlap:
        raise DifficultyMatchError(f"pilot/final source PGN groups overlap: {len(overlap)}")


def _expected_ids(
    openings: Sequence[Mapping[str, object]], lower_level: int, run_kind: str
) -> set[str]:
    return {
        difficulty_game_id(lower_level, lower_level + 2, str(opening["id"]), high_is_red,
                           run_kind=run_kind)
        for opening in openings for high_is_red in (True, False)
    }


def aggregate_pair(
    games: Sequence[Mapping[str, object]], openings: Sequence[Mapping[str, object] | str], *, lower_level: int,
    run_kind: str | None = None,
) -> dict:
    """Compute W/N (draws are not wins); only the frozen 50x2 profile is gate-eligible."""
    validate_pair_levels(lower_level, lower_level + 2)
    opening_ids = [str(row["id"] if isinstance(row, Mapping) else row) for row in openings]
    if len(set(opening_ids)) != len(opening_ids):
        raise DifficultyMatchError("opening IDs are duplicated")
    run_kind = run_kind if run_kind is not None else (games[0].get("run_kind") if games else "pilot")
    validate_opening_count(len(opening_ids), run_kind)
    expected = {
        difficulty_game_id(lower_level, lower_level + 2, opening_id, high_is_red, run_kind=run_kind)
        for opening_id in opening_ids for high_is_red in (True, False)
    }
    seen: set[str] = set()
    errors: list[str] = []
    wins = draws = losses = 0
    colors: dict[str, set[bool]] = {opening_id: set() for opening_id in opening_ids}
    for index, game in enumerate(games):
        game_id = game.get("game_id")
        if game.get("run_kind") != run_kind:
            errors.append(f"run_kind_mismatch:{index}")
        if game_id not in expected:
            errors.append(f"unexpected_game:{index}:{game_id}")
            continue
        if game_id in seen:
            errors.append(f"duplicate_game:{game_id}")
            continue
        seen.add(game_id)
        high_is_red = game_id.endswith("high-red")
        low = game.get("low_level")
        high = game.get("high_level")
        if (low, high, game.get("high_is_red")) != (lower_level, lower_level + 2, high_is_red):
            errors.append(f"pair_or_color_mismatch:{game_id}")
        opening_id = str(game.get("opening_id", ""))
        if opening_id not in colors:
            errors.append(f"unknown_opening:{game_id}")
        else:
            colors[opening_id].add(high_is_red)
        if game.get("protocol_error") or game.get("unfinished_reason") not in (None, ""):
            errors.append(f"unfinished_or_error:{game_id}")
        result = game.get("result_for_high")
        if result == "win":
            wins += 1
        elif result == "draw":
            draws += 1
        elif result == "loss":
            losses += 1
        else:
            errors.append(f"invalid_result:{game_id}")
    missing = sorted(expected - seen)
    if missing:
        errors.append(f"missing_games:{len(missing)}")
    if any(colors[opening_id] != {True, False} for opening_id in opening_ids):
        errors.append("opening_color_pair_incomplete")
    complete = not errors and len(games) == len(expected)
    gate_eligible = complete and len(opening_ids) == 50 and len(games) == 100
    win_fraction = wins / len(games) if games else None
    return {
        "lower_level": lower_level,
        "higher_level": lower_level + 2,
        "expected_games": len(expected),
        "completed_games": wins + draws + losses,
        "wins": wins,
        "draws": draws,
        "losses": losses,
        "higher_wins": wins,
        "win_fraction": win_fraction,
        "minimum_win_fraction": 0.65,
        "complete": complete,
        "errors": errors,
        "formal_gate_eligible": gate_eligible,
        "passed": bool(gate_eligible and win_fraction is not None and win_fraction >= 0.65),
    }


def _verify_rows(
    games: Sequence[Mapping[str, object]], openings: Sequence[Mapping[str, object]], *,
    lower_level: int, master_seed: int, caller_nodes: int, expected_run_kind: str | None = None,
) -> None:
    validate_pair_levels(lower_level, lower_level + 2)
    if caller_nodes != CALLER_NODES:
        raise DifficultyMatchError(f"caller go nodes must be fixed at {CALLER_NODES}")
    if not games:
        raise DifficultyMatchError("game list must not be empty")
    run_kind = expected_run_kind if expected_run_kind is not None else games[0].get("run_kind")
    validate_opening_count(len(openings), run_kind)
    expected = schedule_pair(openings, lower_level=lower_level, master_seed=master_seed,
                             run_kind=run_kind)
    by_id = {row["game_id"]: row for row in expected}
    ids = [game.get("game_id") for game in games]
    if len(ids) != len(set(ids)) or set(ids) != set(by_id):
        raise DifficultyMatchError("game IDs do not exactly cover each opening and both colors")
    for game in games:
        game_id = str(game["game_id"])
        base = by_id[game_id]
        for field in ("run_kind", "opening_set_sha256", "opening_id", "source", "prefix", "high_level", "low_level", "high_is_red",
                      "source_group_sha256",
                      "master_seed", "game_seed_high", "game_seed_low", "seed_scheme",
                      "engine_a_options", "engine_b_options"):
            if game.get(field) != base[field]:
                raise DifficultyMatchError(f"{game_id}: {field} mismatch")
        if game.get("nodes") != caller_nodes or game.get("max_ply") != MAX_PLY:
            raise DifficultyMatchError(f"{game_id}: caller node/cap mismatch")
        moves = game.get("moves")
        if not isinstance(moves, list) or moves[:len(base["prefix"])] != base["prefix"]:
            raise DifficultyMatchError(f"{game_id}: move sequence does not start with the frozen prefix")
        if game.get("protocol_error") or game.get("unfinished_reason") not in (None, ""):
            raise DifficultyMatchError(f"{game_id}: protocol error or unfinished result")
        if game.get("terminal_outcome") not in {"red", "black", "draw"}:
            raise DifficultyMatchError(f"{game_id}: missing terminal outcome")
        high_won = game["terminal_outcome"] == ("red" if base["high_is_red"] else "black")
        expected_result = "draw" if game["terminal_outcome"] == "draw" else ("win" if high_won else "loss")
        if game.get("result_for_high") != expected_result:
            raise DifficultyMatchError(f"{game_id}: terminal result disagrees with high-level perspective")
        trace = game.get("decision_trace")
        plies = len(moves) - len(base["prefix"])
        if not isinstance(trace, list) or len(trace) != plies + 1:
            raise DifficultyMatchError(f"{game_id}: expected one decision record per move plus terminal query")
        for index, item in enumerate(trace):
            absolute_ply = len(base["prefix"]) + index
            red_to_move = absolute_ply % 2 == 0
            actor = "A" if red_to_move == base["high_is_red"] else "B"
            game_seed = base["game_seed_high"] if actor == "A" else base["game_seed_low"]
            level = base["high_level"] if actor == "A" else base["low_level"]
            expected_trace = {
                "decision_index": index, "absolute_ply": absolute_ply, "actor": actor,
                "game_seed": game_seed, "random_seed": derive_move_seed(game_seed, absolute_ply),
                "level": level,
            }
            if item != expected_trace:
                raise DifficultyMatchError(f"{game_id}: per-ply seed/level trace mismatch at {index}")


def _raw_paths_by_actor(raw_paths: Mapping[str, Path | Sequence[Path]]) -> dict[str, list[Path]]:
    result = {}
    for actor in ("A", "B"):
        value = raw_paths.get(actor)
        paths = [value] if isinstance(value, (str, Path)) else list(value or ())
        if not paths or any(not Path(path).is_file() for path in paths):
            raise DifficultyMatchError(f"raw logs for engine {actor} are missing")
        result[actor] = [Path(path) for path in paths]
    return result


def _audit_raw_logs(
    games: Sequence[Mapping[str, object]], raw_paths: Mapping[str, Path | Sequence[Path]], *, caller_nodes: int,
    expected_run_kind: str | None = None,
    final_contract_identity: Mapping[str, str] | None = None,
) -> dict:
    paths_by_actor = _raw_paths_by_actor(raw_paths)
    if not games:
        raise DifficultyMatchError("cannot audit raw logs without games")
    first = games[0]
    run_kind = expected_run_kind if expected_run_kind is not None else first["run_kind"]
    if any(game.get("run_kind") != run_kind for game in games):
        raise DifficultyMatchError("game run kind differs from the authoritative run mode")
    expected_batch_context = {
        "schema": "m5-difficulty-raw-v1",
        "run_kind": run_kind,
        "lower_level": first["low_level"],
        "higher_level": first["high_level"],
        "master_seed": first["master_seed"],
        "seed_scheme": first["seed_scheme"],
        "opening_set_sha256": first["opening_set_sha256"],
    }
    if run_kind == "final":
        if not final_contract_identity or set(final_contract_identity) != {"freeze_sha256", "selection_sha256"}:
            raise DifficultyMatchError("final raw audit requires frozen source/profile and holdout identity")
        expected_batch_context["final_contract_identity"] = dict(final_contract_identity)
    elif final_contract_identity is not None:
        raise DifficultyMatchError("pilot raw audit cannot carry a final identity")
    if any(game["run_kind"] != first["run_kind"] or
           game["opening_set_sha256"] != first["opening_set_sha256"] for game in games):
        raise DifficultyMatchError("games contain mixed run or opening-set identities")
    expected = {}
    for game in games:
        prefix = game["prefix"]
        moves = game["moves"]
        for trace in game["decision_trace"]:
            index = trace["decision_index"]
            position = prefix + moves[len(prefix):len(prefix) + index]
            bestmove = moves[len(prefix) + index] if index < len(moves) - len(prefix) else "0000"
            expected[(game["game_id"], trace["actor"], index)] = {
                "position": position,
                "seed": trace["random_seed"],
                "nodes": caller_nodes,
                "bestmove": bestmove,
                "selected": None if bestmove == "0000" else (bestmove, trace["level"]),
                "outcome": game["terminal_outcome"] if bestmove == "0000" else None,
                "level": trace["level"],
            }
    actual = {}
    raw_files = []
    required_options = dict(BASELINE_OPTIONS)
    for actor, actor_paths in paths_by_actor.items():
        for path in actor_paths:
            live_options = {}
            current = None
            batch_context_seen = False
            lines = path.read_text(encoding="utf-8").splitlines()
            raw_files.append({"actor": actor, "path": str(path.resolve()),
                              "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})

            def finish(line_number: int, bestmove: str) -> None:
                nonlocal current
                key = current["key"]
                if key in actual:
                    raise DifficultyMatchError(f"duplicate raw decision {key}")
                wanted = expected.get(key)
                if wanted is None:
                    raise DifficultyMatchError(f"unexpected raw decision {key}")
                if (current["go_options"]["RandomSeed"], current["position"], current["nodes"], bestmove) != (
                    str(wanted["seed"]), wanted["position"], wanted["nodes"], wanted["bestmove"]
                ):
                    raise DifficultyMatchError(f"raw UCI command/result mismatch at {path}:{line_number}")
                expected_options = {
                    **required_options,
                    "DifficultyLevel": str(wanted["level"]),
                    "RandomSeed": str(wanted["seed"]),
                }
                if current.get("go_options") != expected_options:
                    raise DifficultyMatchError(f"raw options at go differ from fixed profile at {path}:{line_number}")
                if current["selected"] != wanted["selected"] or current["outcome"] != wanted["outcome"]:
                    raise DifficultyMatchError(f"difficulty selection/outcome raw mismatch at {path}:{line_number}")
                actual[key] = current
                current = None

            for line_number, line in enumerate(lines, 1):
                option = re.fullmatch(r"stdin: setoption name ([A-Za-z0-9]+) value (.+)", line)
                if option:
                    name, value = option.groups()
                    live_options[name] = value
                    continue
                if line.startswith("context: batch "):
                    if current is not None or batch_context_seen:
                        raise DifficultyMatchError(f"duplicate or misplaced batch context at {path}:{line_number}")
                    try:
                        batch_context = json.loads(line.removeprefix("context: batch "))
                    except json.JSONDecodeError as error:
                        raise DifficultyMatchError(f"malformed batch context at {path}:{line_number}") from error
                    if batch_context != expected_batch_context:
                        raise DifficultyMatchError(f"raw batch identity mismatch at {path}:{line_number}")
                    batch_context_seen = True
                elif line.startswith("context:"):
                    if not batch_context_seen:
                        raise DifficultyMatchError(f"raw batch identity is missing before decisions at {path}:{line_number}")
                    if current is not None:
                        raise DifficultyMatchError(f"unfinished raw context before {path}:{line_number}")
                    match = re.fullmatch(r"context: game_id=(.+) actor=([AB]) decision_index=(\d+)", line)
                    if not match:
                        raise DifficultyMatchError(f"malformed raw context at {path}:{line_number}")
                    game_id, context_actor, index = match.groups()
                    if context_actor != actor:
                        raise DifficultyMatchError(f"actor context mismatch at {path}:{line_number}")
                    current = {"key": (game_id, actor, int(index)), "position": None,
                               "nodes": None, "go_options": None, "selected": None, "outcome": None}
                elif current is not None and line.startswith("stdin: position startpos moves"):
                    current["position"] = line.removeprefix("stdin: position startpos moves").split()
                elif current is not None and line.startswith("stdin: go nodes "):
                    match = re.fullmatch(r"stdin: go nodes (\d+)", line)
                    if not match:
                        raise DifficultyMatchError(f"malformed go nodes at {path}:{line_number}")
                    current["nodes"] = int(match.group(1))
                    wanted = expected.get(current["key"])
                    if wanted is None:
                        raise DifficultyMatchError(f"unexpected raw decision {current['key']}")
                    expected_options = {
                        **required_options,
                        "DifficultyLevel": str(wanted["level"]),
                        "RandomSeed": str(wanted["seed"]),
                    }
                    observed_options = {name: live_options.get(name) for name in expected_options}
                    if observed_options != expected_options:
                        raise DifficultyMatchError(
                            f"raw options at go differ from fixed profile at {path}:{line_number}"
                        )
                    current["go_options"] = observed_options
                elif current is not None and line.startswith("stdout: info string difficulty-selected "):
                    match = re.fullmatch(r"stdout: info string difficulty-selected (\S+) level (\d+)", line)
                    if not match or current["selected"] is not None:
                        raise DifficultyMatchError(f"malformed or duplicate difficulty selection at {path}:{line_number}")
                    move, level = match.groups()
                    current["selected"] = (move, int(level))
                elif current is not None and line.startswith("stdout: info string outcome "):
                    if current["outcome"] is not None:
                        raise DifficultyMatchError(f"duplicate terminal outcome at {path}:{line_number}")
                    current["outcome"] = line.removeprefix("stdout: info string outcome ")
                elif current is not None and line.startswith("stdout: bestmove "):
                    fields = line.split()
                    if len(fields) != 3:
                        raise DifficultyMatchError(f"malformed bestmove at {path}:{line_number}")
                    finish(line_number, fields[2])
            if current is not None:
                raise DifficultyMatchError(f"unfinished raw decision in {path}")
            if not batch_context_seen:
                raise DifficultyMatchError(f"raw batch identity is missing in {path}")
        actor_expected = {key for key in expected if key[1] == actor}
        actor_actual = {key for key in actual if key[1] == actor}
        if actor_actual != actor_expected:
            raise DifficultyMatchError(f"raw decision coverage mismatch for engine {actor}")
    return {"decision_count": len(actual), "raw_files": raw_files}


def _replay_with_trusted_game(games: Sequence[Mapping[str, object]]) -> dict[str, tuple[str, int]]:
    replay_input = "".join(
        str(game["game_id"]) + "\t" + " ".join(game["moves"]) + "\n" for game in games
    )
    try:
        with trusted_replay() as replay_executable:
            result = subprocess.run([str(replay_executable)], input=replay_input, text=True,
                                    capture_output=True, check=False)
    except Exception as error:
        raise DifficultyMatchError(f"trusted xq-core Game replay unavailable: {error}") from error
    if result.returncode != 0:
        raise DifficultyMatchError(f"trusted xq-core Game rejected batch: {result.stderr[-500:]}")
    replayed = {}
    try:
        for line in result.stdout.splitlines():
            game_id, outcome, plies = line.split("\t")
            if game_id in replayed:
                raise ValueError(f"duplicate replay id {game_id}")
            replayed[game_id] = (outcome, int(plies))
    except ValueError as error:
        raise DifficultyMatchError(f"invalid trusted replay output: {error}") from error
    if len(replayed) != len(games):
        raise DifficultyMatchError("trusted replay did not return every game")
    return replayed


def audit_batch(
    games: Sequence[Mapping[str, object]], openings: Sequence[Mapping[str, object]], *,
    lower_level: int, master_seed: int, caller_nodes: int,
    raw_paths: Mapping[str, Path | Sequence[Path]], expected_run_kind: str | None = None,
    final_contract_identity: Mapping[str, str] | None = None,
) -> dict:
    """Validate rows, actual UCI logs, and terminal results with pinned xq-core Game."""
    run_kind = expected_run_kind if expected_run_kind is not None else (
        games[0].get("run_kind") if games else None
    )
    if run_kind not in {"pilot", "final"}:
        raise DifficultyMatchError("expected run kind must explicitly be pilot or final")
    if any(game.get("run_kind") != run_kind for game in games):
        raise DifficultyMatchError("game run kind differs from the authoritative run mode")
    _verify_rows(games, openings, lower_level=lower_level, master_seed=master_seed,
                 caller_nodes=caller_nodes, expected_run_kind=run_kind)
    replayed = _replay_with_trusted_game(games)
    for game in games:
        if replayed.get(game["game_id"]) != (game["terminal_outcome"], len(game["moves"])):
            raise DifficultyMatchError(f"trusted Game outcome/history differs: {game['game_id']}")
    raw_audit = _audit_raw_logs(games, raw_paths, caller_nodes=caller_nodes,
                                expected_run_kind=run_kind,
                                final_contract_identity=final_contract_identity)
    summary = aggregate_pair(games, openings, lower_level=lower_level, run_kind=run_kind)
    if not summary["complete"]:
        raise DifficultyMatchError(f"aggregated pair is incomplete: {summary['errors']}")
    summary.update({
        "game_replay_valid": True,
        "replayed_games": len(replayed),
        "raw_replay_valid": True,
        "raw_decisions": raw_audit["decision_count"],
        "raw_files": raw_audit["raw_files"],
        "audit_status": "complete",
    })
    return summary


def _decision_trace_entry(game: Mapping[str, object], absolute_ply: int, decision_index: int) -> dict:
    red_to_move = absolute_ply % 2 == 0
    actor = "A" if red_to_move == game["high_is_red"] else "B"
    game_seed = game["game_seed_high"] if actor == "A" else game["game_seed_low"]
    level = game["high_level"] if actor == "A" else game["low_level"]
    return {
        "decision_index": decision_index,
        "absolute_ply": absolute_ply,
        "actor": actor,
        "game_seed": game_seed,
        "random_seed": derive_move_seed(game_seed, absolute_ply),
        "level": level,
    }


def play_difficulty_game(
    game: Mapping[str, object], *, engine_a, engine_b, caller_nodes: int = CALLER_NODES,
    max_ply: int = MAX_PLY, master_seed: int,
) -> dict:
    sequence = list(game["prefix"])
    trace = []
    result = "unfinished"
    terminal_outcome = None
    terminal_raw = []
    protocol_error = None
    while len(sequence) - len(game["prefix"]) < max_ply:
        absolute_ply = len(sequence)
        entry = _decision_trace_entry(game, absolute_ply, len(trace))
        trace.append(entry)
        engine = engine_a if entry["actor"] == "A" else engine_b
        engine.log_context(game["game_id"], entry["actor"], entry["decision_index"])
        try:
            movement, outcome = engine.bestmove(sequence, caller_nodes, "difficulty", entry["random_seed"])
        except (m4_match.MatchProtocolError, TimeoutError, RuntimeError) as error:
            protocol_error = str(error)
            break
        if movement == "0000":
            terminal_outcome = outcome
            terminal_raw = list(engine.last_response_lines)
            result = "draw" if outcome == "draw" else (
                "win" if (outcome == "red") == game["high_is_red"] else "loss"
            )
            break
        sequence.append(movement)
    row = dict(game)
    row.update({
        "moves": sequence,
        "nodes": caller_nodes,
        "max_ply": max_ply,
        "master_seed": master_seed,
        "decision_trace": trace,
        "terminal_outcome": terminal_outcome,
        "terminal_raw": terminal_raw,
        "result_for_high": result,
        "unfinished_reason": protocol_error or ("max_ply" if result == "unfinished" else None),
        "protocol_error": protocol_error,
    })
    return row


def _engine_binary_metadata(command: str) -> dict:
    parts = shlex.split(command)
    if not parts:
        raise DifficultyMatchError("engine command must not be empty")
    executable = shutil.which(parts[0])
    if executable is None:
        raise DifficultyMatchError(f"engine executable not found: {parts[0]}")
    path = Path(executable).resolve()
    return {"command": command, "path": str(path),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def _write_batch_context(engine, context: Mapping[str, object]) -> None:
    if engine.log_handle is None:
        raise DifficultyMatchError("difficulty runs require persistent per-engine raw logs")
    line = "context: batch " + json.dumps(context, sort_keys=True, separators=(",", ":")) + "\n"
    with engine.log_lock:
        engine.log_handle.write(line)
        engine.log_handle.flush()


def run_pair(
    *, engine_command: str, openings: Sequence[Mapping[str, object]], lower_level: int,
    output: Path, master_seed: int = 1, caller_nodes: int = CALLER_NODES,
    max_ply: int = MAX_PLY, workers: int = WORKERS, engine_timeout: float = 30.0,
    run_kind: str, pilot_source_groups: set[str] | None = None,
    final_contract_identity: Mapping[str, str] | None = None,
) -> dict:
    """Run one level pair. Formal gate use requires exactly 50 preselected openings."""
    validate_pair_levels(lower_level, lower_level + 2)
    if run_kind not in {"pilot", "final"}:
        raise DifficultyMatchError("run_kind must explicitly be pilot or final")
    validate_opening_count(len(openings), run_kind)
    if any(not isinstance(opening.get("source_group_sha256"), str) for opening in openings):
        raise DifficultyMatchError("each opening must be linked to a source PGN group SHA-256")
    if run_kind == "final":
        if not pilot_source_groups:
            raise DifficultyMatchError("final run requires the frozen pilot source-group set")
        verify_source_group_disjoint(
            [{"source_group_sha256": group} for group in pilot_source_groups], openings
        )
        if not final_contract_identity or set(final_contract_identity) != {"freeze_sha256", "selection_sha256"}:
            raise DifficultyMatchError("final run requires a frozen source/profile and holdout identity")
    elif final_contract_identity is not None:
        raise DifficultyMatchError("pilot runs cannot carry a final contract identity")
    if caller_nodes != CALLER_NODES or max_ply != MAX_PLY or workers != WORKERS or engine_timeout != 30.0:
        raise DifficultyMatchError("official pair settings must use 100000 nodes, cap 4096, four workers, timeout 30")
    if not 0 <= master_seed <= 0xFFFFFFFFFFFFFFFF:
        raise DifficultyMatchError("master seed must fit in u64")
    output = Path(output)
    if output.exists() and any(output.iterdir()):
        raise DifficultyMatchError("output directory is not empty")
    output.mkdir(parents=True, exist_ok=True)
    metadata = _engine_binary_metadata(engine_command)
    schedule = schedule_pair(openings, lower_level=lower_level, master_seed=master_seed,
                             run_kind=run_kind)
    opening_set_sha256 = _opening_set_digest(openings)
    manifest = {
        "schema": "m5-difficulty-pair-v1", "status": "running",
        "run_kind": run_kind,
        "lower_level": lower_level, "higher_level": lower_level + 2,
        "opening_count": len(openings), "requested_games": len(openings) * 2,
        "caller_nodes": caller_nodes, "max_ply": max_ply, "workers": workers,
        "engine_timeout_seconds": engine_timeout, "master_seed": master_seed,
        "seed_scheme": SEED_SCHEME, "engine_options": BASELINE_OPTIONS,
        "opening_source_groups": sorted({str(row["source_group_sha256"]) for row in openings}),
        "pilot_source_groups": sorted(pilot_source_groups or set()),
        "opening_set_sha256": opening_set_sha256,
        "pilot_source_groups_sha256": hashlib.sha256(
            "\n".join(sorted(pilot_source_groups or set())).encode()
        ).hexdigest(),
        "engine": metadata,
        "final_contract_identity": dict(final_contract_identity) if final_contract_identity else None,
    }
    manifest_path = output / "run-manifest.json"
    games_path = output / "games.jsonl"
    if manifest_path.exists() or games_path.exists():
        raise DifficultyMatchError("refusing to overwrite prior run files")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    games_path.write_text("", encoding="utf-8")
    jobs = [schedule[index::workers] for index in range(workers)]
    events: queue.Queue = queue.Queue()

    def worker(worker_id: int, worker_jobs: list[dict]) -> None:
        worker_dir = output / "workers" / f"worker-{worker_id:02d}"
        engine_a = engine_b = None
        try:
            engine_a = m4_match.UciEngine.start(engine_command, timeout_seconds=engine_timeout,
                                                log_path=worker_dir / "engine-a.log")
            engine_b = m4_match.UciEngine.start(engine_command, timeout_seconds=engine_timeout,
                                                log_path=worker_dir / "engine-b.log")
            raw_context = {
                "schema": "m5-difficulty-raw-v1", "run_kind": run_kind,
                "lower_level": lower_level, "higher_level": lower_level + 2,
                "master_seed": master_seed, "seed_scheme": SEED_SCHEME,
                "opening_set_sha256": opening_set_sha256,
            }
            if final_contract_identity:
                raw_context["final_contract_identity"] = dict(final_contract_identity)
            _write_batch_context(engine_a, raw_context)
            _write_batch_context(engine_b, raw_context)
            for game in worker_jobs:
                engine_a.configure({**BASELINE_OPTIONS, "DifficultyLevel": str(game["high_level"])})
                engine_b.configure({**BASELINE_OPTIONS, "DifficultyLevel": str(game["low_level"])})
                events.put(play_difficulty_game(
                    game, engine_a=engine_a, engine_b=engine_b, caller_nodes=caller_nodes,
                    max_ply=max_ply, master_seed=master_seed,
                ))
        except Exception as error:
            events.put({"worker_error": f"worker {worker_id}: {type(error).__name__}: {error}"})
        finally:
            for engine in (engine_b, engine_a):
                if engine is not None:
                    engine.close()

    with games_path.open("a", encoding="utf-8") as games_file:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(worker, index, jobs[index - 1]) for index in range(1, workers + 1)]
            remaining = len(futures)
            while remaining:
                done = [future for future in futures if future.done()]
                remaining = len(futures) - len(done)
                while not events.empty():
                    game = events.get()
                    games_file.write(json.dumps(game, ensure_ascii=False) + "\n")
                    games_file.flush()
                    os.fsync(games_file.fileno())
                if remaining:
                    # Queue.get keeps the writer responsive while worker processes run.
                    try:
                        game = events.get(timeout=0.25)
                    except queue.Empty:
                        continue
                    games_file.write(json.dumps(game, ensure_ascii=False) + "\n")
                    games_file.flush()
                    os.fsync(games_file.fileno())
            for future in futures:
                future.result()
            while not events.empty():
                game = events.get()
                games_file.write(json.dumps(game, ensure_ascii=False) + "\n")
                games_file.flush()
                os.fsync(games_file.fileno())
    games = [json.loads(line) for line in games_path.read_text(encoding="utf-8").splitlines() if line]
    summary = apply_run_kind_gate(aggregate_pair(games, openings, lower_level=lower_level), run_kind)
    manifest["status"] = "awaiting_independent_game_and_raw_audit"
    manifest["observed_games"] = len(games)
    manifest["protocol_errors"] = [game["worker_error"] for game in games if "worker_error" in game]
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    summary_path = output / "summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    return summary


def read_openings_tsv(path: Path, *, expected_count: int = 50) -> list[dict]:
    validate_opening_count(expected_count, "pilot")
    rows = Path(path).read_text(encoding="utf-8").splitlines()
    if not rows or rows[0].split("\t") != ["opening_id", "source_ref", "iccs_prefix"]:
        raise DifficultyMatchError("opening TSV header mismatch")
    openings = []
    for line in rows[1:]:
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) != 3:
            raise DifficultyMatchError("opening TSV rows must have three columns")
        opening_id, source, prefix = parts
        openings.append({"id": opening_id, "source": source, "moves": prefix.split()})
    if len(openings) != expected_count or len({row["id"] for row in openings}) != expected_count:
        raise DifficultyMatchError(f"opening TSV must contain exactly {expected_count} unique rows")
    return openings


def read_openings_with_source_groups(
    tsv_path: Path, jsonl_path: Path, *, expected_count: int = 50
) -> list[dict]:
    """Join the TSV runner view to its selected-JSONL source PGN identity."""
    openings = read_openings_tsv(tsv_path, expected_count=expected_count)
    metadata = {}
    for line_number, line in enumerate(Path(jsonl_path).read_text(encoding="utf-8").splitlines(), 1):
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as error:
            raise DifficultyMatchError(f"invalid selected JSONL row {line_number}") from error
        opening_id = row.get("opening_id")
        if not isinstance(opening_id, str) or opening_id in metadata:
            raise DifficultyMatchError("selected JSONL has missing or duplicate opening IDs")
        metadata[opening_id] = row
    if set(metadata) != {opening["id"] for opening in openings}:
        raise DifficultyMatchError("selected JSONL and TSV opening IDs differ")
    for opening in openings:
        row = metadata[opening["id"]]
        moves = row.get("iccs_prefix", "").split()
        if row.get("source_pgn_url") != opening["source"] or moves != opening["moves"]:
            raise DifficultyMatchError(f"selected JSONL/TSV source or prefix mismatch: {opening['id']}")
        group = row.get("source_pgn_sha256")
        if not isinstance(group, str) or not re.fullmatch(r"[0-9a-f]{64}", group):
            raise DifficultyMatchError(f"invalid source PGN SHA-256: {opening['id']}")
        opening["source_group_sha256"] = group
    return openings


def audit_run_directory(
    run_dir: Path, openings: Sequence[Mapping[str, object]], *,
    pilot_source_groups: set[str] | None = None,
    final_contract_identity: Mapping[str, str] | None = None,
) -> dict:
    run_dir = Path(run_dir).resolve()
    try:
        manifest = json.loads((run_dir / "run-manifest.json").read_text(encoding="utf-8"))
        games = [json.loads(line) for line in (run_dir / "games.jsonl").read_text(encoding="utf-8").splitlines() if line]
    except (OSError, json.JSONDecodeError) as error:
        raise DifficultyMatchError(f"run evidence is missing or malformed: {error}") from error
    if (manifest.get("schema") != "m5-difficulty-pair-v1"
            or manifest.get("status") != "awaiting_independent_game_and_raw_audit"):
        raise DifficultyMatchError("run manifest is not a completed difficulty batch")
    if manifest.get("caller_nodes") != CALLER_NODES or manifest.get("max_ply") != MAX_PLY:
        raise DifficultyMatchError("run config differs from fixed caller node/cap limits")
    if manifest.get("workers") != WORKERS or manifest.get("engine_timeout_seconds") != 30.0:
        raise DifficultyMatchError("run config differs from fixed worker/timeout limits")
    if manifest.get("engine_options") != BASELINE_OPTIONS:
        raise DifficultyMatchError("run config baseline option set differs")
    run_kind = manifest.get("run_kind")
    validate_opening_count(len(openings), run_kind)
    if manifest.get("opening_count") != len(openings):
        raise DifficultyMatchError("audited opening count differs from run manifest")
    if (manifest.get("requested_games") != len(openings) * 2
            or manifest.get("observed_games") != len(games)):
        raise DifficultyMatchError("manifest game counts differ from the opening set/results")
    if _opening_set_digest(openings) != manifest.get("opening_set_sha256"):
        raise DifficultyMatchError("audited opening set differs from run manifest")
    if manifest.get("run_kind") == "final":
        if not final_contract_identity or manifest.get("final_contract_identity") != dict(final_contract_identity):
            raise DifficultyMatchError("final batch is not bound to the supplied source/profile and holdout freeze")
        if not pilot_source_groups:
            raise DifficultyMatchError("final audit requires the frozen pilot source groups")
        verify_source_group_disjoint(
            [{"source_group_sha256": group} for group in pilot_source_groups], openings
        )
        if sorted(pilot_source_groups) != manifest.get("pilot_source_groups"):
            raise DifficultyMatchError("audited pilot source-group set differs from manifest")
    elif manifest.get("run_kind") != "pilot":
        raise DifficultyMatchError("unknown run kind")
    engine = manifest.get("engine", {})
    executable = Path(engine.get("path", ""))
    if not executable.is_file() or hashlib.sha256(executable.read_bytes()).hexdigest() != engine.get("sha256"):
        raise DifficultyMatchError("run engine executable is missing or changed")
    if _engine_binary_metadata(engine.get("command", "")) != engine:
        raise DifficultyMatchError("actual engine command/binary metadata mismatch")
    raw_paths = {
        actor: [run_dir / "workers" / f"worker-{worker:02d}" / f"engine-{actor.lower()}.log"
                for worker in range(1, WORKERS + 1)]
        for actor in ("A", "B")
    }
    audited = audit_batch(
        games, openings, lower_level=manifest.get("lower_level"),
        master_seed=manifest.get("master_seed"), caller_nodes=manifest.get("caller_nodes"),
        raw_paths=raw_paths, expected_run_kind=run_kind,
        final_contract_identity=final_contract_identity,
    )
    if audited["completed_games"] != len(openings) * 2:
        raise DifficultyMatchError("audited batch does not contain both colors for each opening")
    audited = apply_run_kind_gate(audited, run_kind)
    try:
        summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise DifficultyMatchError(f"run summary is missing or malformed: {error}") from error
    expected_summary = apply_run_kind_gate(
        aggregate_pair(games, openings, lower_level=manifest["lower_level"], run_kind=run_kind), run_kind
    )
    for field in ("run_kind", "lower_level", "higher_level", "expected_games", "completed_games",
                  "wins", "draws", "losses", "win_fraction", "complete",
                  "formal_gate_eligible", "passed"):
        if summary.get(field) != expected_summary[field]:
            raise DifficultyMatchError(f"run summary differs from audited games: {field}")
    return audited


def read_source_group_set(jsonl_path: Path) -> set[str]:
    groups = set()
    for line_number, line in enumerate(Path(jsonl_path).read_text(encoding="utf-8").splitlines(), 1):
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as error:
            raise DifficultyMatchError(f"invalid source JSONL row {line_number}") from error
        source_group = row.get("source_pgn_sha256")
        if not isinstance(source_group, str) or not re.fullmatch(r"[0-9a-f]{64}", source_group):
            raise DifficultyMatchError(f"invalid source PGN SHA-256 at row {line_number}")
        groups.add(source_group)
    if not groups:
        raise DifficultyMatchError("source JSONL has no source PGN groups")
    return groups
