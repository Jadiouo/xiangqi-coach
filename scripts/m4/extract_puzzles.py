#!/usr/bin/env python3
"""Fetch and normalize XiangqiPlay puzzle candidates without asserting correctness."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


SOURCES = {
    1: "https://xiangqiplay.online/puzzles/mate-in-1",
    2: "https://xiangqiplay.online/puzzles/mate-in-2",
    3: "https://xiangqiplay.online/puzzles/mate-in-3",
}
PIECE_MAP = {
    "g": "k", "G": "K", "a": "a", "A": "A", "e": "b", "E": "B",
    "h": "n", "H": "N", "r": "r", "R": "R", "c": "c", "C": "C",
    "s": "p", "S": "P",
}


def parse_embedded_pool(html: str) -> list[dict]:
    """Extract the first JSON `pool` array from Next.js escaped RSC data."""
    unescaped = html.replace('\\"', '"')
    marker = '"pool":['
    marker_at = unescaped.find(marker)
    if marker_at < 0:
        raise ValueError("embedded puzzle pool not found")
    start = marker_at + len('"pool":')
    depth = 0
    in_string = False
    escaped = False
    end = None
    for index in range(start, len(unescaped)):
        char = unescaped[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char == "[":
            depth += 1
        elif char == "]":
            depth -= 1
            if depth == 0:
                end = index + 1
                break
    if end is None:
        raise ValueError("embedded puzzle pool has unclosed JSON array")
    pool = json.loads(unescaped[start:end])
    if not isinstance(pool, list) or not all(isinstance(item, dict) for item in pool):
        raise ValueError("embedded puzzle pool is not an array of objects")
    return pool


def flatboard_to_fen(flatboard: str, side: str) -> str:
    if len(flatboard) != 90:
        raise ValueError(f"flatboard must contain 90 squares, got {len(flatboard)}")
    if side not in ("r", "b"):
        raise ValueError(f"unknown side-to-move code: {side!r}")
    rows = []
    for rank in range(10):
        row = flatboard[rank * 9:(rank + 1) * 9]
        fen_row = []
        empty = 0
        for symbol in row:
            if symbol == ".":
                empty += 1
            else:
                try:
                    piece = PIECE_MAP[symbol]
                except KeyError as error:
                    raise ValueError(f"unknown piece code: {symbol!r}") from error
                if empty:
                    fen_row.append(str(empty))
                    empty = 0
                fen_row.append(piece)
        if empty:
            fen_row.append(str(empty))
        rows.append("".join(fen_row))
    return "/".join(rows) + (" w" if side == "r" else " b") + " - - 0 1"


def solution_to_iccs(solution: dict) -> str:
    def square(point: dict) -> str:
        row, col = point.get("row"), point.get("col")
        if not isinstance(row, int) or not 0 <= row < 10:
            raise ValueError(f"invalid source row: {row!r}")
        if not isinstance(col, int) or not 0 <= col < 9:
            raise ValueError(f"invalid source column: {col!r}")
        return chr(ord("a") + col) + str(9 - row)

    return square(solution["from"]) + square(solution["to"])


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "xiangqi-coach-m4-research/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 200:
            raise RuntimeError(f"GET {url} returned HTTP {response.status}")
        return response.read()


def extract(output: Path) -> list[dict]:
    extracted_at = datetime.now(timezone.utc).isoformat()
    records = []
    for target, url in SOURCES.items():
        raw = fetch(url)
        page = raw.decode("utf-8")
        page_hash = hashlib.sha256(raw).hexdigest()
        pool = parse_embedded_pool(page)
        for candidate in pool:
            first = candidate.get("solutions", [{}])[0]
            records.append({
                "id": candidate["id"],
                "source_url": url,
                "source_page_sha256": page_hash,
                "retrieved_at_utc": extracted_at,
                "source_flatboard": candidate["fen"],
                "source_side": candidate["side"],
                "mate_in_attacker_moves": target,
                "fen": flatboard_to_fen(candidate["fen"], candidate["side"]),
                "claimed_first_move": solution_to_iccs(first),
                "validation": {"status": "candidate-unverified"},
            })
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in records), encoding="utf-8")
    return records


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="write normalized candidate JSONL here")
    args = parser.parse_args()
    records = extract(args.output)
    print(json.dumps({"output": str(args.output), "count": len(records),
                      "counts_by_mate": {str(depth): sum(row["mate_in_attacker_moves"] == depth for row in records) for depth in (1, 2, 3)},
                      "status": "candidates only; legal moves, shortest mate, and uniqueness are not verified"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(2)
