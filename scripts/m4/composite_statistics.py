"""Finite-population statistics for the new-50-opening composite trial."""

import math


def _look_opening_scores(bykey, rounds, label):
    opening_ids = sorted({key[0] for key in bykey})
    if len(opening_ids) != 50:
        raise ValueError(f"{label} must contain exactly 50 opening clusters")
    scores = {}
    values = {"win": 1.0, "draw": 0.5, "loss": 0.0}
    for opening_id in opening_ids:
        cluster = []
        for a_is_red in (True, False):
            for round_number in rounds:
                record = bykey.get((opening_id, a_is_red, round_number))
                if record is None:
                    raise ValueError(f"{label} missing {opening_id}/{a_is_red}/{round_number}")
                result = record[2]
                if result not in values:
                    raise ValueError(f"{label} has invalid result {result!r}")
                cluster.append(values[result])
        scores[opening_id] = sum(cluster) / len(cluster)
    return scores


def _interval(mean, alpha, finite_population_size=None, sample_size=None):
    radius_factor = 1.0
    if finite_population_size is not None:
        if sample_size is None or sample_size < 1 or sample_size > finite_population_size:
            raise ValueError("invalid finite-population interval sizes")
        radius_factor = 1.0 - (sample_size - 1) / finite_population_size
    radius = math.sqrt(radius_factor * math.log(2 / alpha) / (2 * sample_size))
    return [max(0.0, mean - radius), min(1.0, mean + radius)]


def calculate_combined_statistics(look1_bykey, look2_bykey, population_size=153):
    """Combine independent first/second 50-opening samples into n=100 of N=153."""
    first_ids = {key[0] for key in look1_bykey}
    second_ids = {key[0] for key in look2_bykey}
    overlap = first_ids & second_ids
    if overlap:
        raise ValueError(f"look opening sets overlap: {sorted(overlap)[:4]}")
    first = _look_opening_scores(look1_bykey, (1, 2), "look 1")
    second = _look_opening_scores(look2_bykey, (3, 4), "look 2")
    cluster_scores = {**first, **second}
    sample_size = len(cluster_scores)
    if sample_size != 100 or population_size != 153:
        raise ValueError("composite trial requires 100 distinct clusters from population 153")
    mean = sum(cluster_scores.values()) / sample_size
    return {
        "opening_cluster_count": sample_size,
        "finite_population_size": population_size,
        "per_look_cluster_counts": {"look1": len(first), "look2": len(second)},
        "cluster_scores": cluster_scores,
        "score_mean": mean,
        "report_95_ordinary_hoeffding_score_interval": _interval(mean, 0.05, None, sample_size),
        "decision_97_5_score_interval": _interval(mean, 0.025, population_size, sample_size),
        "decision_interval_method": "two-look Bonferroni finite-population Hoeffding-Serfling, alpha=.025 per look",
    }


def calculate_look_statistics(bykey, rounds=(1, 2), population_size=153):
    """Recompute one 50-cluster look's diagnostics and decision interval."""
    scores = _look_opening_scores(bykey, tuple(rounds), "look")
    if population_size != 153:
        raise ValueError("composite profile requires finite population 153")
    mean = sum(scores.values()) / 50
    return {
        "opening_cluster_count": 50,
        "finite_population_size": population_size,
        "cluster_scores": scores,
        "score_mean": mean,
        "report_95_ordinary_hoeffding_score_interval": _interval(mean, 0.05, None, 50),
        "decision_97_5_score_interval": _interval(mean, 0.025, population_size, 50),
    }


def should_run_second_look(interval):
    """Continue only when the first-look 97.5% score interval contains 0.5."""
    if (not isinstance(interval, (list, tuple)) or len(interval) != 2
            or not all(isinstance(value, (int, float)) for value in interval)
            or interval[0] > interval[1]):
        raise ValueError("score interval must be an ordered pair")
    return interval[0] <= 0.5 <= interval[1]
