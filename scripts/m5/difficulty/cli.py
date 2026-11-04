"""CLI for a single M5 n-versus-n+2 difficulty batch."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from final_contract import (
    FinalContractError, create_final_freeze, select_final_openings,
    write_contract_once,
)
from difficulty_match import (
    BASELINE_OPTIONS,
    DifficultyMatchError,
    audit_run_directory,
    read_openings_with_source_groups,
    read_source_group_set,
    run_pair,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    run = subparsers.add_parser("run", help="run exactly one pilot or final level pair")
    run.add_argument("--engine", required=True, help="immutable xq-uci command")
    run.add_argument("--openings-tsv", required=True, type=Path)
    run.add_argument("--opening-jsonl", required=True, type=Path)
    run.add_argument("--lower-level", required=True, type=int, choices=range(1, 9))
    run.add_argument("--run-kind", required=True, choices=("pilot", "final"))
    run.add_argument("--pilot-count", type=int, help="pilot only: exact subset size (1–50; final is always 50)")
    run.add_argument("--output", required=True, type=Path)
    run.add_argument("--master-seed", required=True, type=int)
    run.add_argument("--pilot-opening-jsonl", type=Path,
                     help="required for final runs; source groups must be disjoint")
    run.add_argument("--final-freeze", type=Path, help="required for a frozen final run")
    run.add_argument("--final-selection", type=Path, help="required for a frozen final run")
    audit = subparsers.add_parser("audit", help="replay the completed UCI/raw/Game evidence")
    audit.add_argument("--run", required=True, type=Path)
    audit.add_argument("--openings-tsv", required=True, type=Path)
    audit.add_argument("--opening-jsonl", required=True, type=Path)
    audit.add_argument("--pilot-opening-jsonl", type=Path,
                       help="required when auditing a final run")
    audit.add_argument("--final-freeze", type=Path, help="required when auditing a final run")
    audit.add_argument("--final-selection", type=Path, help="required when auditing a final run")
    series = subparsers.add_parser("audit-series", help="audit all eight final pairs against one freeze and holdout")
    series.add_argument("--final-freeze", required=True, type=Path)
    series.add_argument("--final-selection", required=True, type=Path)
    series.add_argument("--batch-root", required=True, type=Path,
                        help="contains pair-1 through pair-8 completed run directories")
    freeze_cmd = subparsers.add_parser("freeze-final", help="validate and freeze candidate before any sampling")
    freeze_cmd.add_argument("--source-repo", required=True, type=Path)
    freeze_cmd.add_argument("--binary", required=True, type=Path)
    freeze_cmd.add_argument("--profile", required=True, type=Path)
    freeze_cmd.add_argument("--eligible", required=True, type=Path)
    freeze_cmd.add_argument("--pilot", required=True, type=Path)
    freeze_cmd.add_argument("--master-seed", required=True, type=int)
    freeze_cmd.add_argument("--freeze-time", required=True)
    freeze_cmd.add_argument("--binary-build-source-head", required=True)
    freeze_cmd.add_argument("--output", required=True, type=Path)
    sample_cmd = subparsers.add_parser("select-final", help="sample once using OS entropy and exclusive registration")
    sample_cmd.add_argument("--freeze", required=True, type=Path)
    sample_cmd.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "freeze-final":
            freeze = create_final_freeze(
                source_repo=args.source_repo, binary_path=args.binary, profile_path=args.profile,
                eligible_path=args.eligible, pilot_path=args.pilot, engine_options=BASELINE_OPTIONS,
                master_seed=args.master_seed, freeze_time=args.freeze_time,
                binary_build_source_head=args.binary_build_source_head)
            digest = write_contract_once(args.output, freeze)
            result = {"freeze_path": str(args.output.resolve()), "freeze_file_sha256": digest,
                      "freeze_sha256": freeze["freeze_sha256"], "sampling_started": False}
        elif args.command == "select-final":
            freeze = json.loads(args.freeze.read_text(encoding="utf-8"))
            selection = select_final_openings(freeze, args.output_dir)
            result = {"selection": str((args.output_dir / "selection.json").resolve()),
                      "selection_sha256": selection["selection_sha256"],
                      "registration": selection["registration"]["path"]}
        elif args.command == "run":
            if args.run_kind == "final" and args.pilot_count is not None:
                raise DifficultyMatchError("--pilot-count is only valid for pilot runs")
            expected_count = args.pilot_count if args.pilot_count is not None else 50
            openings = read_openings_with_source_groups(
                args.openings_tsv, args.opening_jsonl, expected_count=expected_count
            )
            final_identity = None
            if args.run_kind == "final":
                if args.pilot_opening_jsonl is None or args.final_freeze is None or args.final_selection is None:
                    raise DifficultyMatchError("final run requires pilot openings, --final-freeze, and --final-selection")
                from final_contract import validate_final_contract_inputs
                freeze = json.loads(args.final_freeze.read_text(encoding="utf-8"))
                selection = json.loads(args.final_selection.read_text(encoding="utf-8"))
                final_identity = validate_final_contract_inputs(
                    freeze, selection, openings, args.master_seed, args.engine, args.lower_level)
            elif args.final_freeze is not None or args.final_selection is not None:
                raise DifficultyMatchError("final freeze/selection inputs are only valid for final runs")
            pilot_groups = (read_source_group_set(args.pilot_opening_jsonl)
                            if args.pilot_opening_jsonl is not None else None)
            result = run_pair(
                engine_command=args.engine,
                openings=openings,
                lower_level=args.lower_level,
                output=args.output,
                master_seed=args.master_seed,
                run_kind=args.run_kind,
                pilot_source_groups=pilot_groups,
                final_contract_identity=final_identity,
            )
        elif args.command == "audit":
            manifest = json.loads((args.run / "run-manifest.json").read_text(encoding="utf-8"))
            openings = read_openings_with_source_groups(
                args.openings_tsv, args.opening_jsonl,
                expected_count=manifest.get("opening_count"),
            )
            pilot_groups = None
            if manifest.get("run_kind") == "final":
                if args.pilot_opening_jsonl is None:
                    raise DifficultyMatchError("final audit requires --pilot-opening-jsonl")
                pilot_groups = read_source_group_set(args.pilot_opening_jsonl)
            final_identity = None
            if manifest.get("run_kind") == "final":
                if args.final_freeze is None or args.final_selection is None:
                    raise DifficultyMatchError("final audit requires --final-freeze and --final-selection")
                from final_contract import validate_final_contract_inputs
                freeze = json.loads(args.final_freeze.read_text(encoding="utf-8"))
                selection = json.loads(args.final_selection.read_text(encoding="utf-8"))
                final_identity = validate_final_contract_inputs(
                    freeze, selection, openings, manifest.get("master_seed"),
                    manifest.get("engine", {}).get("command", ""), manifest.get("lower_level"))
            result = audit_run_directory(args.run, openings, pilot_source_groups=pilot_groups,
                                         final_contract_identity=final_identity)
        elif args.command == "audit-series":
            from final_contract import audit_final_series
            freeze = json.loads(args.final_freeze.read_text(encoding="utf-8"))
            selection = json.loads(args.final_selection.read_text(encoding="utf-8"))
            batches = {level: args.batch_root / f"pair-{level}" for level in range(1, 9)}
            result = audit_final_series(freeze, selection, batches)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
        return 0
    except (DifficultyMatchError, FinalContractError, ValueError, OSError, json.JSONDecodeError, KeyError) as error:
        parser.exit(2, f"difficulty validation error: {error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
