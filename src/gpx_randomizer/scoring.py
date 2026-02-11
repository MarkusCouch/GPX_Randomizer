from __future__ import annotations

import math


def score_step(
    turn_angle_deg: float,
    next_degree: int,
    repeat_count: int,
    ascent_per_km: float,
    branch_bias: float,
    hill_bias: float,
) -> float:
    # Higher score = better
    straight_pref = 1.0 - (turn_angle_deg / 180.0)
    branch_pref = 1.0 if next_degree >= 3 else 0.0
    corridor_pref = 1.0 if next_degree == 2 else 0.0

    score = 0.0
    score += (1 - abs(branch_bias)) * straight_pref
    score += branch_bias * branch_pref
    score += (-branch_bias) * corridor_pref
    score -= 1.2 * repeat_count

    ascent_norm = ascent_per_km / 100.0
    score += hill_bias * ascent_norm
    if hill_bias < 0:
        score -= abs(hill_bias) * ascent_norm
    return score


def softmax_weights(scores: list[float], temperature: float = 1.0) -> list[float]:
    if not scores:
        return []
    m = max(scores)
    exps = [math.exp((s - m) / max(temperature, 1e-6)) for s in scores]
    tot = sum(exps)
    return [e / tot for e in exps]
