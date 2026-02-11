from __future__ import annotations

import copy
import random
from dataclasses import dataclass, field

import networkx as nx
from shapely.geometry import LineString, Point
from shapely.ops import substring

from .config import Config
from .geom import find_nearest_edge, geod_length_m, point_key, turn_angle_deg
from .scoring import score_step, softmax_weights


@dataclass
class Candidate:
    current_node: tuple[float, float]
    path_edges: list[tuple[tuple[float, float], tuple[float, float]]] = field(default_factory=list)
    length_m: float = 0.0
    score: float = 0.0
    used_edge_counts: dict[tuple[tuple[float, float], tuple[float, float]], int] = field(default_factory=dict)
    prev_bearing: float | None = None


def _norm_edge(u, v):
    return tuple(sorted([u, v]))


def add_temporary_start_node(graph: nx.Graph, start_latlon: tuple[float, float], config: Config | None = None):
    config = config or Config()
    g = copy.deepcopy(graph)
    p = Point(start_latlon[1], start_latlon[0])
    nearest = find_nearest_edge(g, p)
    if nearest is None:
        raise ValueError("Graph has no edges")
    dist_m, (u, v, data), nearest_pt = nearest
    if dist_m > config.max_connector_m:
        raise ValueError(f"Start point is too far from network: {dist_m:.0f} m")

    start_node = (round(p.x, 7), round(p.y, 7))
    split_node = point_key(nearest_pt)

    if g.has_edge(u, v):
        g.remove_edge(u, v)

    base_geom = data["geometry"]
    proj_dist = base_geom.project(nearest_pt)
    part1 = substring(base_geom, 0, proj_dist)
    part2 = substring(base_geom, proj_dist, base_geom.length)

    if isinstance(part1, LineString) and len(part1.coords) >= 2:
        g.add_edge(u, split_node, geometry=part1, length_m=geod_length_m(part1), bearing=data.get("bearing", 0.0), elev_gain_m=0.0)
    if isinstance(part2, LineString) and len(part2.coords) >= 2:
        g.add_edge(split_node, v, geometry=part2, length_m=geod_length_m(part2), bearing=data.get("bearing", 0.0), elev_gain_m=0.0)

    connector = LineString([p, nearest_pt])
    g.add_edge(start_node, split_node, geometry=connector, length_m=dist_m, bearing=0.0, elev_gain_m=0.0, is_connector=True)
    return g, start_node, connector


def _candidate_done(mode: str, cand: Candidate, start_node, target_m: float, tol: float) -> bool:
    within = abs(cand.length_m - target_m) <= (target_m * tol)
    if not within:
        return False
    if mode == "Loop":
        return cand.current_node == start_node
    return True


def stochastic_beam_search(
    graph: nx.Graph,
    start_node: tuple[float, float],
    target_km: float,
    mode: str = "Loop",
    branch_bias: float = 0.0,
    hill_bias: float = 0.0,
    seed: int | None = None,
    config: Config | None = None,
):
    config = config or Config()
    rng = random.Random(seed)
    target_m = target_km * 1000.0

    beam = [Candidate(current_node=start_node)]
    best: Candidate | None = None

    for _ in range(300):
        expanded: list[Candidate] = []
        for cand in beam:
            if _candidate_done(mode, cand, start_node, target_m, config.target_len_tol):
                if best is None or cand.score > best.score:
                    best = cand
                continue

            for nbr in graph.neighbors(cand.current_node):
                edge = graph[cand.current_node][nbr]
                ekey = _norm_edge(cand.current_node, nbr)
                repeat = cand.used_edge_counts.get(ekey, 0)
                bearing = edge.get("bearing", 0.0)
                ang = 0.0 if cand.prev_bearing is None else turn_angle_deg(cand.prev_bearing, bearing)
                step_score = score_step(
                    turn_angle_deg=ang,
                    next_degree=graph.degree[nbr],
                    repeat_count=repeat,
                    ascent_per_km=(edge.get("elev_gain_m", 0.0) / max(edge.get("length_m", 1.0), 1.0)) * 1000.0,
                    branch_bias=branch_bias,
                    hill_bias=hill_bias,
                )
                new = Candidate(
                    current_node=nbr,
                    path_edges=cand.path_edges + [(cand.current_node, nbr)],
                    length_m=cand.length_m + edge["length_m"],
                    score=cand.score + step_score,
                    used_edge_counts=dict(cand.used_edge_counts),
                    prev_bearing=bearing,
                )
                new.used_edge_counts[ekey] = repeat + 1

                # Encourage loop closure near budget.
                if mode == "Loop" and new.length_m > target_m * (1 - config.target_len_tol):
                    try:
                        back_len = nx.shortest_path_length(graph, new.current_node, start_node, weight="length_m")
                        if new.length_m + back_len <= target_m * (1 + config.target_len_tol):
                            sp = nx.shortest_path(graph, new.current_node, start_node, weight="length_m")
                            for i in range(len(sp) - 1):
                                u, v = sp[i], sp[i + 1]
                                e = graph[u][v]
                                new.path_edges.append((u, v))
                                new.length_m += e["length_m"]
                            new.current_node = start_node
                    except nx.NetworkXNoPath:
                        pass
                if new.length_m <= target_m * 1.4:
                    expanded.append(new)

        if not expanded:
            break
        # stochastic selection into next beam
        scores = [c.score for c in expanded]
        weights = softmax_weights(scores, temperature=1.2)
        k = min(config.beam_width, len(expanded))
        chosen_idx = rng.choices(range(len(expanded)), weights=weights, k=k)
        beam = [expanded[i] for i in chosen_idx]

    if best is None and beam:
        best = min(beam, key=lambda c: abs(c.length_m - target_m))
    return best
