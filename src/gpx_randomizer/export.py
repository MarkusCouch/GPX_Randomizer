from __future__ import annotations

from pathlib import Path

import gpxpy.gpx
from shapely.geometry import LineString


def route_edges_to_linestring(path_edges, graph) -> LineString:
    coords: list[tuple[float, float]] = []
    for u, v in path_edges:
        geom = graph[u][v]["geometry"]
        seg = list(geom.coords)
        if coords and coords[-1] == seg[0]:
            coords.extend(seg[1:])
        elif coords and coords[-1] == seg[-1]:
            coords.extend(reversed(seg[:-1]))
        else:
            coords.extend(seg)
    return LineString(coords)


def write_gpx(route_geom: LineString, out_path: Path, name: str = "Random Route") -> None:
    gpx = gpxpy.gpx.GPX()
    track = gpxpy.gpx.GPXTrack(name=name)
    gpx.tracks.append(track)
    seg = gpxpy.gpx.GPXTrackSegment()
    track.segments.append(seg)
    for lon, lat in route_geom.coords:
        seg.points.append(gpxpy.gpx.GPXTrackPoint(latitude=lat, longitude=lon))
    out_path.write_text(gpx.to_xml(), encoding="utf-8")
