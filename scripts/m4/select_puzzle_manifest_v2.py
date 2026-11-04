#!/usr/bin/env python3
"""Select an immutable new puzzle candidate version after external perft screening."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path


def _unique_by_id(rows: list[dict], label: str) -> dict[str, dict]:
    indexed = {row["id"]: row for row in rows}
    if len(indexed) != len(rows):
        raise ValueError(f"{label} IDs must be unique")
    return indexed


def build_manifest(candidates: list[dict], proofs: list[dict], oracle: list[dict], per_depth: int,
                   candidate_sha256: str, proof_sha256: str, oracle_sha256: str) -> dict:
    candidate_by_id = _unique_by_id(candidates, "candidate")
    proofs_by_id = _unique_by_id(proofs, "proof")
    oracle_by_id = _unique_by_id(oracle, "oracle")
    if set(proofs_by_id) != set(candidate_by_id):
        raise ValueError("proof and candidate IDs must match exactly")

    source_unique = {
        identifier: candidate_by_id[identifier]
        for identifier, proof in proofs_by_id.items()
        if proof.get("proof_status") == "complete"
        and proof.get("complete") is True
        and proof.get("unique_claim_matches_source") is True
    }
    if set(oracle_by_id) != set(source_unique):
        raise ValueError("oracle and source-unique IDs must match exactly")

    compatible: dict[str, dict] = {}
    excluded: list[dict] = []
    for identifier in sorted(source_unique):
        candidate = source_unique[identifier]
        proof = proofs_by_id[identifier]
        row = oracle_by_id[identifier]
        if row.get("run_status") != "complete":
            excluded.append({"id": identifier, "reason": row.get("run_status", "missing-status"),
                             "error": row.get("error")})
            continue
        if row.get("perft_only") is not True:
            excluded.append({"id": identifier, "reason": "not-perft-only-screen"})
            continue
        perft = row.get("perft")
        if not isinstance(perft, dict) or not all(str(depth) in perft for depth in (1, 2, 3)):
            excluded.append({"id": identifier, "reason": "missing-perft-depth"})
            continue
        root_moves = perft["1"].get("root_moves")
        if (row.get("claimed_first_move_legal") is not True
                or not isinstance(root_moves, list)
                or candidate["claimed_first_move"] not in root_moves):
            excluded.append({"id": identifier, "reason": "source-first-move-not-in-external-root-legal-set"})
            continue
        compatible[identifier] = {
            "id": identifier,
            "mate_in_attacker_moves": int(candidate["mate_in_attacker_moves"]),
            "source_url": candidate["source_url"],
            "source_page_sha256": candidate["source_page_sha256"],
            "fen": candidate["fen"],
            "claimed_first_move": candidate["claimed_first_move"],
            "proof_unique_move": proof.get("unique"),
            "proof_nodes": proof.get("nodes"),
            "external_perft": {str(depth): perft[str(depth)]["nodes"] for depth in (1, 2, 3)},
            "external_root_moves": root_moves,
            "external_claimed_first_move_legal": True,
        }

    by_depth: dict[int, list[dict]] = defaultdict(list)
    for row in compatible.values():
        by_depth[row["mate_in_attacker_moves"]].append(row)
    selected = []
    for depth in sorted({int(candidate["mate_in_attacker_moves"]) for candidate in candidates}):
        selected.extend(sorted(by_depth[depth], key=lambda row: row["id"])[:per_depth])
    counts = Counter(row["mate_in_attacker_moves"] for row in compatible.values())
    complete_buckets = all(counts[depth] >= per_depth for depth in (1, 2, 3))
    return {
        "schema_version": 2,
        "status": "candidate-only-pending-external-mate-search" if complete_buckets
                  else "insufficient-external-compatible-candidates",
        "selection_rule": f"from all source-unique local proof candidates, retain only full external perft 1-3 screens whose root legal set includes the source move; choose first {per_depth} IDs per mate-depth bucket",
        "unique_outcome_rule": "project Game outcome; no legal move is a loss whether or not the side to move is in check",
        "external_compatibility_rule": "official Pikafish UCI Threads=1 completes go perft 1, 2, and 3; root perft1 move set includes the source first move",
        "candidate_input_sha256": candidate_sha256,
        "proof_input_sha256": proof_sha256,
        "external_perft_results_sha256": oracle_sha256,
        "source_unique_pool_count": len(source_unique),
        "external_compatible_count": len(compatible),
        "external_compatible_counts_by_depth": {str(depth): counts[depth] for depth in (1, 2, 3)},
        "excluded": excluded,
        "selected": selected,
    }


def read_jsonl(path: Path) -> tuple[bytes, list[dict]]:
    raw = path.read_bytes()
    return raw, [json.loads(line) for line in raw.decode("utf-8").splitlines() if line.strip()]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidates", type=Path, required=True)
    parser.add_argument("--proofs", type=Path, required=True)
    parser.add_argument("--oracle-results", type=Path, required=True,
                        help="complete perft-only results.jsonl covering exactly all source-unique IDs")
    parser.add_argument("--per-depth", type=int, default=10)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.per_depth < 1:
        parser.error("per-depth must be positive")
    candidate_bytes, candidates = read_jsonl(args.candidates)
    proof_bytes, proofs = read_jsonl(args.proofs)
    oracle_bytes, oracle = read_jsonl(args.oracle_results)
    manifest = build_manifest(candidates, proofs, oracle, args.per_depth,
                              hashlib.sha256(candidate_bytes).hexdigest(),
                              hashlib.sha256(proof_bytes).hexdigest(),
                              hashlib.sha256(oracle_bytes).hexdigest())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "source_unique_pool_count": manifest["source_unique_pool_count"],
                      "external_compatible_counts_by_depth": manifest["external_compatible_counts_by_depth"],
                      "selected": len(manifest["selected"]), "status": manifest["status"]}, ensure_ascii=False))
    return 0 if manifest["status"] == "candidate-only-pending-external-mate-search" else 3


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, json.JSONDecodeError, KeyError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(2)
