"""M5 difficulty match runner and independently auditable validation helpers."""

from .difficulty_match import (
    BASELINE_OPTIONS,
    CALLER_NODES,
    MAX_PLY,
    WORKERS,
    DifficultyMatchError,
    aggregate_pair,
    audit_batch,
    audit_run_directory,
    derive_game_seed,
    derive_move_seed,
    read_openings_with_source_groups,
    read_source_group_set,
    run_pair,
    schedule_pair,
    apply_run_kind_gate,
    validate_opening_count,
    verify_source_group_disjoint,
)

__all__ = [
    "BASELINE_OPTIONS", "CALLER_NODES", "MAX_PLY", "WORKERS", "DifficultyMatchError",
    "aggregate_pair", "audit_batch", "audit_run_directory", "derive_game_seed",
    "derive_move_seed", "read_openings_with_source_groups", "read_source_group_set",
    "run_pair", "schedule_pair", "verify_source_group_disjoint",
    "apply_run_kind_gate", "validate_opening_count",
]
