from shapely.geometry import LineString

from gpx_randomizer.geom import node_lines


def test_crossing_lines_create_more_segments():
    lines = [
        LineString([(0, 0), (2, 2)]),
        LineString([(0, 2), (2, 0)]),
    ]
    segs = node_lines(lines)
    assert len(segs) > len(lines)
