#!/usr/bin/env python3
"""Select a reproducible uniform sample from an eligible finite population."""

import random
from collections.abc import Mapping, Sequence
from typing import Any


def select_rows(rows: Sequence[Mapping[str, Any]], seed: int, count: int = 50) -> list[dict[str, Any]]:
    if not isinstance(seed, int) or not 0 <= seed < 2**64:
        raise ValueError("seed must be an unsigned 64-bit integer")
    if count <= 0:
        raise ValueError("sample count must be positive")
    population = [dict(row) for row in rows]
    if any(not isinstance(row.get("position_key"), str) for row in population):
        raise ValueError("each eligible row must have a string position_key")
    population.sort(key=lambda row: row["position_key"])
    keys = [row["position_key"] for row in population]
    if len(set(keys)) != len(keys):
        raise ValueError("eligible population contains duplicate position_key values")
    if len(population) < count:
        raise ValueError(f"eligible population has {len(population)} rows; {count} required")
    return random.Random(seed).sample(population, count)


def eligible_rows(rows: Sequence[Mapping[str, Any]], threshold_cp: int = 100) -> list[dict[str, Any]]:
    """Return sorted rows that satisfy the predeclared external-score gate."""
    eligible = []
    for source in rows:
        row = dict(source)
        validation = row.get("validation", {})
        if validation.get("balanced") is not True:
            continue
        balance = row.get("reference_balance", {})
        final = balance.get("final_info") or {}
        bestmove = balance.get("bestmove")
        red_to_move = row.get("red_to_move_after_cutoff")
        score = final.get("score")
        pv = final.get("pv") or []
        gate_passes = (
            validation.get("acceptance_reason") == "within_external_balance_threshold"
            and final.get("score_type") == "cp"
            and final.get("bound") is None
            and balance.get("bound") == "none"
            and isinstance(score, int)
            and abs(score) <= threshold_cp
            and balance.get("score_cp_stm") == score
            and isinstance(bestmove, str)
            and bool(pv)
            and pv[0] == bestmove
            and bestmove in row.get("root_legal_moves", [])
            and isinstance(red_to_move, bool)
            and balance.get("score_cp_red") == (score if red_to_move else -score)
        )
        if not gate_passes:
            raise ValueError(f"balanced row {row.get('opening_id')!r} fails balance gate")
        eligible.append(row)
    eligible.sort(key=lambda row: row["position_key"])
    if len({row["position_key"] for row in eligible}) != len(eligible):
        raise ValueError("eligible population contains duplicate position_key values")
    return eligible
