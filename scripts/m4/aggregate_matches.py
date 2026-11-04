#!/usr/bin/env python3
"""Validate and aggregate the five frozen 200-game M4 match batches."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

from match import summarize_results, verify_batch_games, verify_selection_protocol


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid JSONL at {path}:{line_number}: {error}") from error
    return rows


def _validate_final_baseline_launcher(
    directory: Path, launcher_directory: Path, manifest: dict, games: list[dict],
    openings_tsv: Path, selection_protocol: Path, baseline_profile: str = "final-ra-ce",
) -> dict:
    manifest_path = directory / "run-manifest.json"
    summary_path = directory / "summary.json"
    if not summary_path.is_file():
        raise ValueError(f"{directory}: {baseline_profile} summary is missing")
    if not launcher_directory.is_dir():
        raise ValueError(f"{directory}: final-ra-ce launcher evidence is missing")
    command_path = launcher_directory / "command.json"
    launch_path = launcher_directory / "launch.json"
    exit_path = launcher_directory / "exit-status.json"
    stdout_path = launcher_directory / "stdout.log"
    stderr_path = launcher_directory / "stderr.log"
    for path in (command_path, launch_path, exit_path, stdout_path, stderr_path):
        if not path.is_file():
            raise ValueError(f"{directory}: launcher evidence is missing {path.name}")

    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    manifest_sha = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    game_wdl = {result: sum(game.get("result_for_a") == result for game in games)
                for result in ("win", "draw", "loss")}
    if (summary.get("baseline_profile") != baseline_profile or summary.get("complete") is not True
            or summary.get("requested_games") != 200 or summary.get("games_written") != 200
            or summary.get("finished_games") != 200 or summary.get("unfinished_games") != 0):
        raise ValueError(f"{directory}: summary is not a complete 200-game {baseline_profile} batch")
    if summary.get("run_manifest_sha256") != manifest_sha:
        raise ValueError(f"{directory}: summary does not bind the current run-manifest")
    summary_wdl = summary.get("wdl_for_a") or {}
    if (any(summary_wdl.get(key) != game_wdl[key] for key in game_wdl)
            or summary_wdl.get("unfinished", 0) != 0):
        raise ValueError(f"{directory}: summary WDL does not match games.jsonl")
    if sum(game_wdl.values()) != 200:
        raise ValueError(f"{directory}: games.jsonl WDL is not 200 completed results")

    command = json.loads(command_path.read_text(encoding="utf-8"))
    launch = json.loads(launch_path.read_text(encoding="utf-8"))
    exit_status = json.loads(exit_path.read_text(encoding="utf-8"))
    run_root = Path(__file__).resolve().parents[2]
    runner_path = Path(__file__).with_name("match.py").resolve()
    actual_head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=run_root, check=True, capture_output=True, text=True,
    ).stdout.strip()
    runner_sha = hashlib.sha256(runner_path.read_bytes()).hexdigest()
    engine_sha = (manifest.get("engine_a_executable") or {}).get("sha256")
    expected_options = {"CheckExtensions": "true", "RootAlpha": "true"}
    if baseline_profile == "final-ra-ce-kh":
        expected_options["KillerHistoryOrdering"] = "true"
    if manifest.get("runner_git_head") != actual_head or manifest.get("runner_source_sha256") != runner_sha:
        raise ValueError(f"{directory}: runner_git_head or runner_source_sha256 is not pinned to this checkout")
    if (command.get("schema_version") != "m4-baseline-command-v1"
            or command.get("cwd") != str(run_root)
            or command.get("output") != str(directory.resolve())
            or command.get("runner_git_head") != manifest.get("runner_git_head")
            or command.get("runner_source_sha256") != runner_sha
            or command.get("engine_sha256") != engine_sha
            or command.get("openings_sha256") != hashlib.sha256(openings_tsv.read_bytes()).hexdigest()
            or command.get("selection_protocol_sha256") != hashlib.sha256(selection_protocol.read_bytes()).hexdigest()):
        raise ValueError(f"{directory}: command.json does not match the batch profile/manifest")
    expected_argv = [
        "--engine-a", manifest["engine_a_command"], "--engine-b", manifest["engine_b_command"],
        "--openings", str(openings_tsv.resolve()), "--nodes", "10000", "--games", "200",
        "--global-round-start", str(manifest["global_round_start"]), "--global-round-count", "2",
        "--max-ply", "4096", "--engine-timeout", "30", "--workers", "4",
        "--strategy-a", "search", "--strategy-b", manifest["strategy_b"],
        "--engine-a-options", json.dumps(expected_options, separators=(",", ":")),
        "--engine-b-options", json.dumps(expected_options, separators=(",", ":")),
        "--baseline-profile", baseline_profile, "--seed", "1", "--look", "1",
        "--selection-protocol", str(selection_protocol.resolve()), "--output", str(directory.resolve()),
    ]
    argv = command.get("command")
    if (not isinstance(argv, list) or len(argv) < 2
            or not Path(argv[0]).is_file() or Path(argv[1]).resolve() != runner_path
            or argv[2:] != expected_argv):
        raise ValueError(f"{directory}: command.json argv does not match the exact batch command")
    if (launch.get("schema_version") != "m4-baseline-launch-v1"
            or launch.get("cwd") != str(run_root)
            or launch.get("runner_head") != manifest.get("runner_git_head")
            or launch.get("runner_source_path") != str(runner_path)
            or launch.get("runner_source_sha256") != runner_sha
            or launch.get("command") != str(command_path.resolve())
            or launch.get("exit_status") != str(exit_path.resolve())
            or launch.get("stdout") != str(stdout_path.resolve())
            or launch.get("stderr") != str(stderr_path.resolve())
            or launch.get("output") != str(directory.resolve())
            or launch.get("engine_sha256") != engine_sha):
        raise ValueError(f"{directory}: launch.json does not bind the expected command/output")
    if (not isinstance(exit_status.get("exit_code"), int) or isinstance(exit_status.get("exit_code"), bool)
            or exit_status.get("exit_code") != 0):
        raise ValueError(f"{directory}: runner exit code is not zero")
    return {
        "summary_sha256": hashlib.sha256(summary_path.read_bytes()).hexdigest(),
        "command_sha256": hashlib.sha256(command_path.read_bytes()).hexdigest(),
        "launch_sha256": hashlib.sha256(launch_path.read_bytes()).hexdigest(),
        "exit_status_sha256": hashlib.sha256(exit_path.read_bytes()).hexdigest(),
        "exit_code": 0,
        "runner_git_head": actual_head,
        "runner_source_sha256": runner_sha,
    }


def aggregate_batch_directories(
    batch_directories: list[Path],
    openings_tsv: Path,
    selection_protocol: Path,
    *,
    master_seed: int,
    strategy_a: str,
    strategy_b: str,
    baseline_profile: str | None = None,
    batch_launchers: list[Path] | None = None,
) -> dict:
    if len(batch_directories) != 5:
        raise ValueError("formal aggregation requires exactly five 200-game batches")
    if baseline_profile in ("final-ra-ce", "final-ra-ce-kh") and (batch_launchers is None or len(batch_launchers) != 5):
        raise ValueError(f"{baseline_profile} requires exactly five ordered launcher evidence directories")
    if baseline_profile is None and batch_launchers is not None:
        raise ValueError("batch launcher evidence is only accepted with a named baseline profile")
    selection = verify_selection_protocol(selection_protocol, openings_tsv)
    if not selection["full_selected_sample"] or selection["input_count"] != 50:
        raise ValueError("formal aggregation requires the full frozen 50-opening sample")
    opening_lines = openings_tsv.read_text(encoding="utf-8").splitlines()[1:]
    opening_rows = [line.split("\t") for line in opening_lines]
    opening_ids = [row[0] for row in opening_rows]
    opening_data = {row[0]: {"source": row[1], "prefix": row[2].split()} for row in opening_rows}
    if len(opening_ids) != 50 or len(set(opening_ids)) != 50:
        raise ValueError("frozen opening TSV must have 50 unique rows")

    tsv_hash = hashlib.sha256(openings_tsv.read_bytes()).hexdigest()
    protocol_hash = hashlib.sha256(selection_protocol.read_bytes()).hexdigest()
    expected_starts = [1, 3, 5, 7, 9]
    batch_reports = []
    all_games = []
    identity_fields = (
        "experiment", "master_seed", "nodes_per_move", "max_ply", "strategy_a", "strategy_b",
        "candidate_side", "baseline_side",
        "engine_a_options", "engine_b_options", "openings_sha256",
        "selection_protocol_sha256", "selection", "engine_a_command", "engine_b_command",
        "engine_a_executable", "engine_b_executable",
        "look", "baseline_profile",
    )
    reference_identity = None
    for index, (directory, expected_start) in enumerate(zip(batch_directories, expected_starts), 1):
        manifest_path = directory / "run-manifest.json"
        games_path = directory / "games.jsonl"
        if not manifest_path.is_file() or not games_path.is_file():
            raise ValueError(f"batch {index} is missing run-manifest.json or games.jsonl")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("schema_version") != "m4-match-batch-v1":
            raise ValueError(f"batch {index} has unsupported schema")
        declared_config_hash = manifest.get("config_sha256")
        config_payload = {key: value for key, value in manifest.items() if key != "config_sha256"}
        actual_config_hash = hashlib.sha256(
            json.dumps(config_payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        if declared_config_hash != actual_config_hash:
            raise ValueError(f"batch {index} configuration hash mismatch")
        if manifest.get("global_round_start") != expected_start or manifest.get("global_round_count") != 2:
            raise ValueError(f"batch {index} does not cover global rounds {expected_start}–{expected_start + 1}")
        if manifest.get("global_rounds") != [expected_start, expected_start + 1]:
            raise ValueError(f"batch {index} round list mismatch")
        if manifest.get("requested_games") != 200:
            raise ValueError(f"batch {index} must request exactly 200 games")
        if manifest.get("candidate_side") != "A" or manifest.get("baseline_side") != "B":
            raise ValueError("formal A/B orientation is fixed: candidate A, baseline B")
        for key, expected in (("master_seed", master_seed), ("nodes_per_move", 10000),
                              ("strategy_a", strategy_a), ("strategy_b", strategy_b),
                              ("openings_sha256", tsv_hash),
                              ("selection_protocol_sha256", protocol_hash)):
            if manifest.get(key) != expected:
                raise ValueError(f"batch {index} {key} does not match aggregation protocol")
        protocol_selection = manifest.get("selection", {})
        if not protocol_selection.get("frozen_protocol_verified") or not protocol_selection.get("full_selected_sample"):
            raise ValueError(f"batch {index} selection metadata is not the full verified sample")
        experiment = manifest.get("experiment")
        options_a = manifest.get("engine_a_options", {})
        options_b = manifest.get("engine_b_options", {})
        if manifest.get("baseline_profile") != baseline_profile:
            raise ValueError(f"batch {index} baseline_profile does not match aggregation protocol")
        if baseline_profile in ("final-ra-ce", "final-ra-ce-kh"):
            if strategy_a != "search" or strategy_b not in ("random", "greedy"):
                raise ValueError("final-ra-ce baseline profile requires search vs random or greedy")
            if manifest.get("master_seed") != 1:
                raise ValueError(f"batch {index} final-ra-ce profile requires master_seed=1")
            if manifest.get("max_ply") != 4096:
                raise ValueError(f"batch {index} final-ra-ce profile requires max_ply=4096")
            if manifest.get("workers") != 4:
                raise ValueError(f"batch {index} final-ra-ce profile requires workers=4")
            if manifest.get("engine_timeout_seconds") != 30.0:
                raise ValueError(f"batch {index} final-ra-ce profile requires engine_timeout_seconds=30")
            if manifest.get("requested_games") != 200 or manifest.get("global_round_count") != 2:
                raise ValueError(f"batch {index} final-ra-ce profile requires 200 games over two rounds")
            if manifest.get("global_round_start") not in (1, 3, 5, 7, 9):
                raise ValueError(f"batch {index} final-ra-ce profile has invalid round start")
            if manifest.get("look") != 1 or experiment is not None:
                raise ValueError(f"batch {index} final-ra-ce profile cannot name an A/B experiment/look")
            expected_options = {"CheckExtensions": "true", "RootAlpha": "true"}
            if baseline_profile == "final-ra-ce-kh":
                expected_options["KillerHistoryOrdering"] = "true"
            if options_a != expected_options or options_b != expected_options:
                raise ValueError(f"batch {index} {baseline_profile} profile has invalid explicit options")
            executable_a = manifest.get("engine_a_executable", {}).get("sha256")
            executable_b = manifest.get("engine_b_executable", {}).get("sha256")
            if not executable_a or executable_a != executable_b:
                raise ValueError(f"batch {index} final-ra-ce profile must use the same immutable binary")
            if not manifest.get("runner_git_head") or not manifest.get("runner_source_sha256"):
                raise ValueError(f"batch {index} final-ra-ce profile requires runner HEAD/source SHA")
        elif baseline_profile is not None:
            raise ValueError(f"unsupported baseline profile: {baseline_profile}")
        if strategy_a == "search" and strategy_b == "search":
            if manifest.get("master_seed") != 1:
                raise ValueError(f"batch {index} formal search A/B requires master_seed=1")
            if manifest.get("max_ply") != 4096:
                raise ValueError(f"batch {index} formal search A/B requires max_ply=4096")
            if manifest.get("look") not in (1, 2):
                raise ValueError(f"batch {index} formal search A/B requires look=1 or look=2")
            executable_a = manifest.get("engine_a_executable", {}).get("sha256")
            executable_b = manifest.get("engine_b_executable", {}).get("sha256")
            if not executable_a or executable_a != executable_b:
                raise ValueError(f"batch {index} search A/B must use identical executable SHA-256")
            if experiment is None and options_a == {"CheckExtensions": "true"} and options_b == {"CheckExtensions": "false"}:
                # Read legacy CheckExtensions batches created before manifests named the experiment.
                experiment = "check-extensions"
            if experiment == "check-extensions":
                expected_a = {"CheckExtensions": "true"}
                expected_b = {"CheckExtensions": "false"}
            elif experiment == "move-hints":
                expected_a = {"CheckExtensions": "false", "MoveHints": "true"}
                expected_b = {"CheckExtensions": "false", "MoveHints": "false"}
            elif experiment == "root-alpha":
                expected_a = {"CheckExtensions": "false", "MoveHints": "false", "RootAlpha": "true"}
                expected_b = {"CheckExtensions": "false", "MoveHints": "false", "RootAlpha": "false"}
            elif experiment == "q-capture-order":
                expected_a = {"QCaptureOrder": "true"}
                expected_b = {"QCaptureOrder": "false"}
            else:
                raise ValueError(f"batch {index} has an unknown or missing search A/B experiment")
            if options_a != expected_a or options_b != expected_b:
                raise ValueError(f"batch {index} {experiment} experiment has invalid A/B options")
        elif experiment is not None:
            raise ValueError(f"batch {index} names a search A/B experiment for a non-search match")
        identity = {key: manifest.get(key) for key in identity_fields}
        if baseline_profile in ("final-ra-ce", "final-ra-ce-kh"):
            identity.update({key: manifest.get(key) for key in (
                "runner_git_head", "runner_source_sha256", "workers", "engine_timeout_seconds",
            )})
        identity["experiment"] = experiment
        if reference_identity is None:
            reference_identity = identity
        elif identity["experiment"] != reference_identity["experiment"]:
            raise ValueError(f"batch {index} experiment_mismatch")
        elif identity != reference_identity:
            differing_fields = [key for key in identity if identity.get(key) != reference_identity.get(key)]
            raise ValueError(
                f"batch {index} engine/configuration differs from the other batches: {differing_fields}"
            )

        games = read_jsonl(games_path)
        batch_check = verify_batch_games(
            games, opening_ids, range(expected_start, expected_start + 2), 10000, master_seed,
            opening_data=opening_data, max_ply=manifest.get("max_ply"),
        )
        if not batch_check["complete"] or len(games) != 200:
            raise ValueError(f"batch {index} is incomplete: {batch_check['errors']}")
        completion_report = None
        if baseline_profile in ("final-ra-ce", "final-ra-ce-kh"):
            completion_report = _validate_final_baseline_launcher(
                directory, batch_launchers[index - 1], manifest, games, openings_tsv, selection_protocol,
                baseline_profile,
            )
        batch_reports.append({
            "batch": index,
            "path": str(directory),
            "manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
            "games_sha256": hashlib.sha256(games_path.read_bytes()).hexdigest(),
            "verification": batch_check,
            "completion": completion_report,
        })
        all_games.extend(games)

    final_check = verify_batch_games(
        all_games, opening_ids, range(1, 11), 10000, master_seed,
        opening_data=opening_data, max_ply=reference_identity["max_ply"],
    )
    if not final_check["complete"] or len(all_games) != 1000:
        raise ValueError(f"combined records are incomplete: {final_check['errors']}")

    totals = {"win": 0, "draw": 0, "loss": 0, "unfinished": 0}
    pair_results: dict[tuple[int, str], dict[str, str]] = {}
    opening_scores = {opening_id: [] for opening_id in opening_ids}
    for game in all_games:
        result = game["result_for_a"]
        totals[result] += 1
        pair_results.setdefault((game["global_round"], game["opening_id"]), {})[
            "red" if game["a_is_red"] else "black"
        ] = result
    for global_round in range(1, 11):
        for opening_id in opening_ids:
            pair = pair_results[(global_round, opening_id)]
            score = sum({"win": 1.0, "draw": 0.5, "loss": 0.0}[pair[color]] for color in ("red", "black")) / 2
            opening_scores[opening_id].append(score)

    summary = summarize_results(
        requested_games=1000,
        totals=totals,
        opening_scores=opening_scores,
        strategy_a=strategy_a,
        strategy_b=strategy_b,
        population_size=selection["population_size"],
        finite_population_verified=True,
        selected_opening_count=50,
        nodes_per_move=10000,
        selection_verified=True,
        paired_games_complete=True,
    )
    summary["batch_validation"] = {
        "complete": True,
        "experiment": reference_identity["experiment"],
        "baseline_profile": reference_identity["baseline_profile"],
        "unique_game_ids": final_check["unique_game_ids"],
        "global_rounds": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        "opening_count": 50,
        "paired_colors_per_opening_round": True,
        "candidate_side": "A",
        "baseline_side": "B",
        "score_for_candidate": "wdl_for_a",
        "nodes_per_move": 10000,
        "master_seed": master_seed,
        "batches": batch_reports,
        "engine_a_executable": reference_identity["engine_a_executable"],
        "engine_b_executable": reference_identity["engine_b_executable"],
        "engine_a_options": reference_identity["engine_a_options"],
        "engine_b_options": reference_identity["engine_b_options"],
    }
    return summary


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch", required=True, action="append", type=Path,
                        help="repeat exactly five times, in global-round order")
    parser.add_argument("--openings", required=True, type=Path)
    parser.add_argument("--selection-protocol", required=True, type=Path)
    parser.add_argument("--master-seed", required=True, type=int)
    parser.add_argument("--strategy-a", required=True, choices=("search", "random", "greedy"))
    parser.add_argument("--strategy-b", required=True, choices=("search", "random", "greedy"))
    parser.add_argument("--baseline-profile", choices=("final-ra-ce", "final-ra-ce-kh"),
                        help="named final default RA+CE baseline validation profile")
    parser.add_argument("--batch-launcher", action="append", type=Path,
                        help="repeat five times in batch order; each directory contains existing launcher command/launch/exit records")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        summary = aggregate_batch_directories(
            args.batch, args.openings, args.selection_protocol,
            master_seed=args.master_seed, strategy_a=args.strategy_a, strategy_b=args.strategy_b,
            baseline_profile=args.baseline_profile, batch_launchers=args.batch_launcher,
        )
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))
    encoded = json.dumps(summary, indent=2, ensure_ascii=False, allow_nan=True) + "\n"
    if args.output:
        if args.output.exists():
            parser.error("output summary already exists; choose a new path")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, allow_nan=True))
    return 0 if summary["complete"] else 2


if __name__ == "__main__":
    sys.exit(main())
