#!/usr/bin/env python3
"""M5 lock, sample, match-audit, and combined decision entry point."""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
M4 = HERE.parent / "m4"
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(M4))
import audit
import future_openings
import protocol


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("verify-lock", help="verify a frozen candidate lock")
    check.add_argument("--candidate-lock", type=Path, required=True)
    sample = sub.add_parser("sample", help="lock one candidate-specific ordered-100 sample")
    sample.add_argument("--source-repo", type=Path, required=True)
    sample.add_argument("--candidate-lock", type=Path, required=True)
    sample.add_argument("--output-dir", type=Path, required=True)
    audit_parser = sub.add_parser("audit", help="audit one completed look from raw logs and Game replay")
    for flag, type_ in (("run", Path), ("candidate-lock", Path), ("binding", Path),
                        ("selection-manifest", Path), ("openings", Path),
                        ("look", int), ("receipt", Path)):
        audit_parser.add_argument(f"--{flag}", dest=flag.replace("-", "_"), type=type_, required=True)
    audit_parser.add_argument("--prior-look-receipt", type=Path)
    combine = sub.add_parser("combine", help="re-audit and combine both looks")
    combine.add_argument("--look1-receipt", type=Path, required=True)
    combine.add_argument("--look2-receipt", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "verify-lock":
        print(json.dumps(protocol.verify_lock(args.candidate_lock), ensure_ascii=False, sort_keys=True))
        return 0
    if args.command == "sample":
        protocol.verify_lock(args.candidate_lock)
        generated = future_openings.generate(args.source_repo, args.candidate_lock, args.output_dir)
        manifest_path = args.output_dir / "selection-manifest.json"
        binding = protocol.bind_selection(args.candidate_lock, manifest_path, args.output_dir / "ordered-100.jsonl")
        binding_path = args.output_dir / "m5-selection-binding.json"
        binding_path.write_text(json.dumps(binding, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"status": "locked-before-games", "candidate_id": binding["candidate_id"],
                          "openings": len(generated["ordered_openings"]), "sample_sha256": binding["sample_sha256"],
                          "manifest": str(manifest_path), "binding": str(binding_path)}, ensure_ascii=False))
        return 0
    if args.command == "audit":
        result = audit.audit_run(args.run, candidate_lock=args.candidate_lock, binding=args.binding,
                                 selection_manifest=args.selection_manifest, openings_tsv=args.openings,
                                 look=args.look, prior_receipt=args.prior_look_receipt)
        args.receipt.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"status": result["status"], "games": result["game_count"],
                          "replayed": result["replayed_games"], "receipt": str(args.receipt)}, ensure_ascii=False))
        return 0
    print(json.dumps(audit.combine_receipts(args.look1_receipt, args.look2_receipt), ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
