"""Pure helpers for leak-resistant win-probability calibration experiments."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import math
from typing import Iterable, Mapping, Sequence


class CalibrationError(ValueError):
    """Raised when records cannot safely be used for calibration."""


def _required_text(row: Mapping[str, object], key: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value:
        raise CalibrationError(f"missing or invalid {key}")
    return value


def _components(rows: Sequence[Mapping[str, object]]) -> dict[str, tuple[str, ...]]:
    parents: dict[str, str] = {}

    def find(item: str) -> str:
        parents.setdefault(item, item)
        while parents[item] != item:
            parents[item] = parents[parents[item]]
            item = parents[item]
        return item

    def union(left: str, right: str) -> None:
        a, b = find(left), find(right)
        if a != b:
            parents[max(a, b)] = min(a, b)

    position_sources: dict[str, set[str]] = {}
    for row in rows:
        source = _required_text(row, "source_pgn_sha256")
        position = _required_text(row, "position_key")
        find(source)
        position_sources.setdefault(position, set()).add(source)
    for sources in position_sources.values():
        sources = sorted(sources)
        for other in sources[1:]:
            union(sources[0], other)
    groups: dict[str, list[str]] = {}
    for source in sorted(parents):
        groups.setdefault(find(source), []).append(source)
    return {source: tuple(groups[find(source)]) for source in parents}


def split_source_groups(
    rows: Sequence[Mapping[str, object]], *, salt: str, train_fraction: float = 0.8
) -> dict[str, str]:
    """Assign source-PGN connected components deterministically to train/heldout."""
    if not salt:
        raise CalibrationError("salt must be non-empty")
    if not 0.0 < train_fraction < 1.0:
        raise CalibrationError("train_fraction must be strictly between 0 and 1")
    components = _components(rows)
    assignments: dict[str, str] = {}
    for members in sorted(set(components.values())):
        material = "\0".join((salt, *members)).encode("utf-8")
        fraction = int.from_bytes(hashlib.sha256(material).digest()[:8], "big") / 2**64
        split = "train" if fraction < train_fraction else "heldout"
        for source in members:
            assignments[source] = split
    return assignments


def deduplicate_replays(records: Iterable[Mapping[str, object]]) -> list[Mapping[str, object]]:
    """Deduplicate by full starting FEN and complete ICCS sequence, ignoring seeds."""
    unique: dict[tuple[str, tuple[str, ...]], Mapping[str, object]] = {}
    for record in records:
        fen = _required_text(record, "starting_fen")
        moves = record.get("iccs_moves")
        if not isinstance(moves, (list, tuple)) or any(not isinstance(move, str) or not move for move in moves):
            raise CalibrationError("iccs_moves must be a sequence of non-empty strings")
        key = (fen, tuple(moves))
        split = record.get("split")
        previous = unique.get(key)
        if previous is not None:
            if previous.get("split") != split:
                raise CalibrationError("duplicate replay crosses train/heldout split")
            if previous.get("outcome") != record.get("outcome"):
                raise CalibrationError("duplicate replay has conflicting outcomes")
            continue
        unique[key] = record
    return list(unique.values())


def logistic_probability(cp: float, k: float = 300.0) -> float:
    """SPEC §8.1 logistic probability for a centipawn-like score and positive k."""
    if not math.isfinite(cp) or not math.isfinite(k) or k <= 0:
        raise CalibrationError("cp must be finite and k must be finite and positive")
    z = cp / k
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    exp_z = math.exp(z)
    return exp_z / (1.0 + exp_z)


def _target(record: Mapping[str, object]) -> float:
    perspective = _required_text(record, "perspective")
    outcome = _required_text(record, "outcome")
    if perspective not in {"red", "black"}:
        raise CalibrationError("perspective must be red or black")
    if outcome == "draw":
        return 0.5
    if outcome not in {"red_win", "black_win"}:
        raise CalibrationError("outcome must be red_win, black_win, or draw")
    winner = outcome.removesuffix("_win")
    return 1.0 if winner == perspective else 0.0


def _logistic_loss(cp: float, k: float, target: float) -> float:
    if not math.isfinite(cp):
        raise CalibrationError("cp must be finite")
    z = cp / k
    # Stable binary cross-entropy with fractional target (a draw is 0.5).
    softplus_z = max(z, 0.0) + math.log1p(math.exp(-abs(z)))
    softplus_neg_z = max(-z, 0.0) + math.log1p(math.exp(-abs(z)))
    if target == 0.0:
        return softplus_z
    if target == 1.0:
        return softplus_neg_z
    return (1.0 - target) * softplus_z + target * softplus_neg_z


def game_log_losses(records: Iterable[Mapping[str, object]], k: float) -> dict[str, float]:
    """Return one equally point-averaged log loss per game (then caller averages games)."""
    if not math.isfinite(k) or k <= 0:
        raise CalibrationError("k must be finite and positive")
    by_game: dict[str, list[float]] = {}
    for record in records:
        if "mate" in record or record.get("score_type") == "mate":
            raise CalibrationError("mate samples are excluded from k calibration")
        game_id = _required_text(record, "game_id")
        cp = record.get("cp")
        if not isinstance(cp, (int, float)) or isinstance(cp, bool):
            raise CalibrationError("cp must be numeric")
        by_game.setdefault(game_id, []).append(_logistic_loss(float(cp), k, _target(record)))
    if not by_game:
        raise CalibrationError("at least one non-mate analysis sample is required")
    return {game: sum(losses) / len(losses) for game, losses in by_game.items()}


def game_log_loss(records: Iterable[Mapping[str, object]], k: float) -> float:
    per_game = game_log_losses(records, k)
    return sum(per_game.values()) / len(per_game)


def separate_mate_summary(records: Iterable[Mapping[str, object]]) -> dict[str, int]:
    """Score mate predictions as binary 0/1 labels, outside the k objective."""
    total = actual_positive = correct = 0
    for record in records:
        if "mate" not in record and record.get("score_type") != "mate":
            continue
        predicted = record.get("mate")
        if predicted not in {"win", "loss"}:
            raise CalibrationError("mate must be win or loss from the sample perspective")
        actual = _target(record)
        # Mate certainty is evaluated as binary: only an eventual win is 1;
        # a draw or loss is 0. This is a separate diagnostic, never a k sample.
        actual_binary = 1 if actual == 1.0 else 0
        total += 1
        actual_positive += actual_binary
        correct += int((predicted == "win") == bool(actual_binary))
    return {"count": total, "actual_positive": actual_positive, "correct": correct}


@dataclass(frozen=True)
class FitResult:
    k: float
    train_log_loss: float
    boundary_hit: bool
    grid_min: float
    grid_max: float


@dataclass(frozen=True)
class HeldoutComparison:
    fitted_k: float
    baseline_k: float
    fitted_log_loss: float
    baseline_log_loss: float
    sample_games: int
    status: str


@dataclass(frozen=True)
class CalibrationReport:
    fit: FitResult
    comparison: HeldoutComparison


def default_k_grid() -> tuple[float, ...]:
    values = {300.0}
    for i in range(401):
        values.add(10.0 * (1000.0 ** (i / 400.0)))
    return tuple(sorted(values))


def fit_k(
    train_records: Iterable[Mapping[str, object]],
    *,
    grid: Sequence[float] | None = None,
) -> FitResult:
    """Fit k using only training samples."""
    records = list(train_records)
    candidates = tuple(grid) if grid is not None else default_k_grid()
    if not candidates or any(not math.isfinite(k) or k <= 0 for k in candidates):
        raise CalibrationError("k grid must contain only finite positive values")
    if 300.0 not in candidates:
        raise CalibrationError("k grid must include baseline k=300")
    # Validate that training contains usable non-mate data before optimization.
    losses = [(k, game_log_loss(records, k)) for k in candidates]
    best_k, best_loss = min(losses, key=lambda item: (item[1], abs(item[0] - 300.0), item[0]))
    return FitResult(best_k, best_loss, best_k in {min(candidates), max(candidates)}, min(candidates), max(candidates))


def compare_heldout(
    fit: FitResult, heldout_records: Iterable[Mapping[str, object]], *, baseline_k: float = 300.0
) -> HeldoutComparison:
    records = list(heldout_records)
    fitted_loss = game_log_loss(records, fit.k)
    baseline_loss = game_log_loss(records, baseline_k)
    games = len({str(record["game_id"]) for record in records})
    return HeldoutComparison(
        fit.k,
        baseline_k,
        fitted_loss,
        baseline_loss,
        games,
        "improved" if fitted_loss < baseline_loss else "not_improved",
    )


def calibrate(
    train_records: Iterable[Mapping[str, object]],
    heldout_records: Iterable[Mapping[str, object]],
    *,
    grid: Sequence[float] | None = None,
) -> CalibrationReport:
    """Fit exclusively on train, then compare the unchanged heldout set with k=300."""
    fit = fit_k(train_records, grid=grid)
    comparison = compare_heldout(fit, heldout_records)
    return CalibrationReport(fit, comparison)
