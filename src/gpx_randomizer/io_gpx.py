from __future__ import annotations

from pathlib import Path

import gpxpy
from shapely.geometry import LineString


def _to_line(points: list[tuple[float, float]]) -> LineString | None:
    if len(points) < 2:
        return None
    line = LineString(points)
    if line.length == 0:
        return None
    return line


def load_gpx_folder(folder: Path) -> list[LineString]:
    lines: list[LineString] = []
    for path in sorted(folder.glob("*.gpx")):
        with path.open("r", encoding="utf-8") as f:
            gpx = gpxpy.parse(f)
        for track in gpx.tracks:
            for seg in track.segments:
                pts = [(p.longitude, p.latitude) for p in seg.points]
                line = _to_line(pts)
                if line is not None:
                    lines.append(line)
        for route in gpx.routes:
            pts = [(p.longitude, p.latitude) for p in route.points]
            line = _to_line(pts)
            if line is not None:
                lines.append(line)
    return lines


def lines_bbox(lines: list[LineString]) -> tuple[float, float, float, float] | None:
    if not lines:
        return None
    minx = min(l.bounds[0] for l in lines)
    miny = min(l.bounds[1] for l in lines)
    maxx = max(l.bounds[2] for l in lines)
    maxy = max(l.bounds[3] for l in lines)
    return minx, miny, maxx, maxy
