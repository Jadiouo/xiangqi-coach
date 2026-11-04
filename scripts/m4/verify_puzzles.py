#!/usr/bin/env python3
"""Run the exhaustive mate proof CLI over extracted candidates and retain every outcome."""

from __future__ import annotations

import argparse
import json
import hashlib
import os
import shlex
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def checkpoint_metadata(input_path: Path, command: list[str], node_limit: int, timeout: float) -> dict:
    file_hashes = {}
    for argument in command:
        path = Path(argument)
        if path.is_file():
            resolved = str(path.resolve())
            file_hashes[resolved] = sha256_file(path)
    return {
        "input_sha256": sha256_file(input_path),
        "command": command,
        "command_file_sha256": file_hashes,
        "node_limit": node_limit,
        "timeout_seconds": timeout,
        "proof_rules_sha256": sha256_file(Path(__file__)),
    }


def parse_proof_output(text: str) -> dict:
    result = {"forced_mates": []}
    for line in text.splitlines():
        fields = line.split("\t")
        if fields[0] == "mate" and len(fields) == 3:
            result["forced_mates"].append({"first_move": fields[1], "in_attack_moves": int(fields[2])})
        elif len(fields) == 2 and fields[0] in ("complete", "nodes", "root_branches_checked", "unique"):
            if fields[0] == "complete":
                result[fields[0]] = fields[1] == "true"
            elif fields[0] in ("nodes", "root_branches_checked"):
                result[fields[0]] = int(fields[1])
            else:
                result[fields[0]] = fields[1]
    return result


def verify(candidates: list[dict], binary: str, node_limit: int, timeout: float) -> list[dict]:
    command = shlex.split(binary)
    if not command:
        raise ValueError("binary command cannot be empty")
    rows = []
    for candidate in candidates:
        record = {key: candidate.get(key) for key in (
            "id", "source_url", "source_page_sha256", "mate_in_attacker_moves", "fen", "claimed_first_move"
        )}
        try:
            completed = subprocess.run(
                command + [candidate["fen"], str(candidate["mate_in_attacker_moves"]), str(node_limit)],
                capture_output=True, text=True, timeout=timeout, check=False,
            )
            parsed = parse_proof_output(completed.stdout)
            if completed.returncode == 0 and parsed.get("complete") is True:
                status = "complete"
            elif completed.returncode == 3 and parsed.get("complete") is False:
                status = "incomplete"
            elif completed.returncode == 2:
                status = "invalid_position"
            else:
                status = "tool_error"
            record.update(parsed)
            record["proof_status"] = status
            record["claimed_first_move_forced"] = any(
                mate["first_move"] == candidate["claimed_first_move"] for mate in parsed.get("forced_mates", [])
            )
            record["unique_claim_matches_source"] = (
                status == "complete" and parsed.get("unique") == candidate["claimed_first_move"]
            )
            record["tool_stderr"] = completed.stderr.strip()
            record["tool_exit_code"] = completed.returncode
        except subprocess.TimeoutExpired as error:
            record.update({"proof_status": "timed_out", "tool_stderr": str(error)})
        except (OSError, ValueError, KeyError) as error:
            record.update({"proof_status": "tool_error", "tool_stderr": str(error)})
        rows.append(record)
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="candidate JSONL from extract_puzzles.py")
    parser.add_argument("--binary", required=True, help="mate-proof executable or shell-like command prefix")
    parser.add_argument("--node-limit", type=int, default=100_000)
    parser.add_argument("--timeout-seconds", type=float, default=30)
    parser.add_argument("--output", type=Path, required=True, help="write one proof result per candidate")
    parser.add_argument("--resume", action="store_true", help="continue only from a matching checkpoint")
    args = parser.parse_args()
    if args.node_limit < 1 or args.timeout_seconds <= 0:
        parser.error("node-limit and timeout-seconds must be positive")
    candidates = [json.loads(line) for line in args.input.read_text(encoding="utf-8").splitlines() if line.strip()]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    command = shlex.split(args.binary)
    if not command:
        raise ValueError("binary command cannot be empty")
    metadata_path = args.output.with_suffix(args.output.suffix + ".meta.json")
    metadata = checkpoint_metadata(args.input, command, args.node_limit, args.timeout_seconds)
    if args.resume:
        if not metadata_path.is_file() or not args.output.is_file():
            raise ValueError("checkpoint does not match: metadata or output is missing")
        saved_metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if saved_metadata != metadata:
            raise ValueError("checkpoint does not match input, binary, limits, timeout, or proof rules")
        checkpoint_bytes = args.output.read_bytes()
        if checkpoint_bytes and not checkpoint_bytes.endswith(b"\n"):
            last_complete_line = checkpoint_bytes.rfind(b"\n") + 1
            with args.output.open("r+b") as output:
                output.truncate(last_complete_line)
                output.flush()
                os.fsync(output.fileno())
            checkpoint_bytes = checkpoint_bytes[:last_complete_line]
        rows = [json.loads(line) for line in checkpoint_bytes.decode("utf-8").splitlines()]
        if len(rows) > len(candidates):
            raise ValueError("checkpoint does not match candidate order")
        identity_fields = ("id", "source_url", "source_page_sha256", "mate_in_attacker_moves", "fen", "claimed_first_move")
        for row, candidate in zip(rows, candidates):
            if any(row.get(field) != candidate.get(field) for field in identity_fields):
                raise ValueError("checkpoint row does not match candidate input")
    else:
        if args.output.exists() or metadata_path.exists():
            raise ValueError("output/checkpoint already exists; use --resume or choose a new output path")
        rows = []
        metadata_path.write_text(json.dumps(metadata, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        with args.output.open("xb"):
            pass

    with args.output.open("ab") as output:
        for candidate in candidates[len(rows):]:
            row = verify([candidate], args.binary, args.node_limit, args.timeout_seconds)[0]
            output.write((json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))
            output.flush()
            os.fsync(output.fileno())
            rows.append(row)
    by_target = defaultdict(Counter)
    for row in rows:
        target = str(row.get("mate_in_attacker_moves"))
        by_target[target][row["proof_status"]] += 1
        by_target[target]["unique_source_claim"] += int(row.get("unique_claim_matches_source", False))
    summary = {"count": len(rows), "node_limit": args.node_limit, "timeout_seconds": args.timeout_seconds,
               "counts_by_target": {key: dict(value) for key, value in sorted(by_target.items())},
               "output": str(args.output)}
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(2)
