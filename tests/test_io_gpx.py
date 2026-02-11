from pathlib import Path

from gpx_randomizer.io_gpx import load_gpx_folder


def test_load_gpx_folder(tmp_path: Path):
    gpx = '''<?xml version="1.0"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>x</name><trkseg>
    <trkpt lat="52.0" lon="13.0"></trkpt>
    <trkpt lat="52.001" lon="13.001"></trkpt>
  </trkseg></trk>
</gpx>'''
    (tmp_path / "a.gpx").write_text(gpx, encoding="utf-8")
    lines = load_gpx_folder(tmp_path)
    assert lines
