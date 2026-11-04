#!/usr/bin/env python3
"""Create a deterministic review manifest from complete local proof outcomes."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import defaultdict
from pathlib import Path


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def build_manifest(candidates: list[dict], proofs: list[dict], per_depth: int,
                   candidate_sha256: str, proof_sha256: str) -> dict:
    candidate_by_id = {row["id"]: row for row in candidates}
    if len(candidate_by_id) != len(candidates):
        raise ValueError("candidate IDs must be unique")
    proofs_by_id = {row["id"]: row for row in proofs}
    if len(proofs_by_id) != len(proofs):
        raise ValueError("proof IDs must be unique")
    if set(proofs_by_id) != set(candidate_by_id):
        raise ValueError("proof and candidate IDs must match exactly")

    eligible = defaultdict(list)
    for candidate in candidates:
        proof = proofs_by_id[candidate["id"]]
        if (proof.get("proof_status") == "complete"
                and proof.get("unique_claim_matches_source") is True):
            eligible[int(candidate["mate_in_attacker_moves"])].append((candidate, proof))

    selected = []
    for depth in sorted(eligible):
        group = sorted(eligible[depth], key=lambda pair: pair[0]["id"])
        if len(group) < per_depth:
            raise ValueError(f"depth {depth} has {len(group)} eligible candidates; need {per_depth}")
        for candidate, proof in group[:per_depth]:
            selected.append({
                "id": candidate["id"],
                "mate_in_attacker_moves": depth,
                "source_url": candidate["source_url"],
                "source_page_sha256": candidate["source_page_sha256"],
                "fen": candidate["fen"],
                "claimed_first_move": candidate["claimed_first_move"],
                "proof_status": proof["proof_status"],
                "proof_unique_move": proof.get("unique"),
                "proof_nodes": proof.get("nodes"),
            })
    fens = [row["fen"] for row in selected]
    if len(set(fens)) != len(fens):
        raise ValueError("selected manifest contains duplicate FENs")
    return {
        "schema_version": 1,
        "status": "candidate-only-pending-external-oracle",
        "selection_rule": f"within each present target-depth bucket, choose first {per_depth} source IDs lexicographically among complete local proofs whose unique move matches the published first move",
        "unique_outcome_rule": "project game outcome; no legal move is a loss whether or not the side to move is in check",
        "candidate_input_sha256": candidate_sha256,
        "proof_input_sha256": proof_sha256,
        "selected": selected,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidates", type=Path, required=True)
    parser.add_argument("--proofs", type=Path, required=True)
    parser.add_argument("--per-depth", type=int, default=10)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.per_depth < 1:
        parser.error("per-depth must be positive")
    candidate_bytes = args.candidates.read_bytes()
    proof_bytes = args.proofs.read_bytes()
    manifest = build_manifest(
        [json.loads(line) for line in candidate_bytes.decode("utf-8").splitlines() if line.strip()],
        [json.loads(line) for line in proof_bytes.decode("utf-8").splitlines() if line.strip()],
        args.per_depth,
        hashlib.sha256(candidate_bytes).hexdigest(),
        hashlib.sha256(proof_bytes).hexdigest(),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "selected": len(manifest["selected"]), "status": manifest["status"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(2)
