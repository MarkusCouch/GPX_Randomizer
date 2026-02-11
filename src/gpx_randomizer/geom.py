from __future__ import annotations

import math
from collections.abc import Callable

import networkx as nx
import numpy as np
from pyproj import CRS, Geod, Transformer
from shapely.geometry import LineString, MultiLineString, Point
from shapely.ops import snap, transform, unary_union

GEOD = Geod(ellps="WGS84")


def geod_length_m(geom_wgs84) -> float:
    return float(abs(GEOD.geometry_length(geom_wgs84)))


def _utm_epsg_for_lonlat(lon: float, lat: float) -> int:
    zone = int((lon + 180) // 6) + 1
    if lat >= 0:
        return 32600 + zone
    return 32700 + zone


def to_local_metric_crs(lines_wgs84: list[LineString]) -> tuple[Callable, Callable, list[LineString]]:
    if not lines_wgs84:
        raise ValueError("Cannot project empty lines")
    cx = np.mean([l.centroid.x for l in lines_wgs84])
    cy = np.mean([l.centroid.y for l in lines_wgs84])
    epsg = _utm_epsg_for_lonlat(float(cx), float(cy))
    src = CRS.from_epsg(4326)
    dst = CRS.from_epsg(epsg)
    fwd = Transformer.from_crs(src, dst, always_xy=True).transform
    inv = Transformer.from_crs(dst, src, always_xy=True).transform
    projected = [transform(fwd, l) for l in lines_wgs84]
    return fwd, inv, projected


def snap_lines(lines_xy: list[LineString], snap_m: float) -> list[LineString]:
    if not lines_xy:
        return []
    unioned = unary_union(lines_xy)
    return [snap(l, unioned, snap_m) for l in lines_xy]


def node_lines(lines_xy: list[LineString]) -> list[LineString]:
    if not lines_xy:
        return []
    merged = unary_union(lines_xy)
    if isinstance(merged, LineString):
        geoms = [merged]
    elif isinstance(merged, MultiLineString):
        geoms = list(merged.geoms)
    else:
        geoms = [g for g in getattr(merged, "geoms", []) if isinstance(g, LineString)]
    return [g for g in geoms if len(g.coords) >= 2 and g.length > 0]


def find_nearest_edge(graph: nx.Graph, start_point: Point):
    best = None
    for u, v, data in graph.edges(data=True):
        geom = data["geometry"]
        proj = geom.project(start_point)
        nearest = geom.interpolate(proj)
        dist = geod_length_m(LineString([start_point, nearest]))
        if best is None or dist < best[0]:
            best = (dist, (u, v, data), nearest)
    return best


def point_key(p: Point, ndigits: int = 7) -> tuple[float, float]:
    return round(p.x, ndigits), round(p.y, ndigits)


def bearing_deg(a: tuple[float, float], b: tuple[float, float]) -> float:
    az12, _, _ = GEOD.inv(a[0], a[1], b[0], b[1])
    return float((az12 + 360) % 360)


def turn_angle_deg(prev_bearing: float, next_bearing: float) -> float:
    d = abs(next_bearing - prev_bearing) % 360
    return min(d, 360 - d)
