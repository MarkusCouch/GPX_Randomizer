from __future__ import annotations

import networkx as nx
from shapely.geometry import LineString, Point

from .config import Config
from .geom import bearing_deg, geod_length_m, point_key


def build_graph_from_segments(segments_wgs84: list[LineString], config: Config | None = None) -> nx.Graph:
    config = config or Config()
    g = nx.Graph()
    seen: set[tuple] = set()

    for seg in segments_wgs84:
        if len(seg.coords) < 2:
            continue
        length_m = geod_length_m(seg)
        if length_m < config.min_edge_m:
            continue

        a = point_key(Point(seg.coords[0]))
        b = point_key(Point(seg.coords[-1]))
        if a == b:
            continue
        edge_key = tuple(sorted([a, b])) + (round(length_m, 1),)
        if edge_key in seen:
            continue
        seen.add(edge_key)

        g.add_node(a)
        g.add_node(b)
        g.add_edge(
            a,
            b,
            geometry=seg,
            length_m=length_m,
            bearing=bearing_deg(a, b),
            elev_gain_m=0.0,
        )
    return g
