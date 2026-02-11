from __future__ import annotations

from pathlib import Path
import tempfile
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

import folium
import streamlit as st
from streamlit_folium import st_folium
from shapely.geometry import LineString
from shapely.ops import transform

from gpx_randomizer.cache_utils import folder_fingerprint, load_cache, save_cache
from gpx_randomizer.config import Config
from gpx_randomizer.elevation import elevation_available
from gpx_randomizer.export import route_edges_to_linestring, write_gpx
from gpx_randomizer.geom import node_lines, snap_lines, to_local_metric_crs
from gpx_randomizer.graph_build import build_graph_from_segments
from gpx_randomizer.io_gpx import lines_bbox, load_gpx_folder
from gpx_randomizer.routing import add_temporary_start_node, stochastic_beam_search

config = Config()
st.set_page_config(page_title="GPX Randomizer", layout="wide")

for k, v in {
    "lines": [],
    "graph": None,
    "start_latlon": None,
    "route_geom": None,
    "connector_geom": None,
    "cache_key": None,
}.items():
    st.session_state.setdefault(k, v)

st.sidebar.header("Controls")
folder_str = st.sidebar.text_input("Folder path", value=".")
rebuild = st.sidebar.checkbox("Force rebuild cache", value=False)
mode = st.sidebar.selectbox("Mode", ["Loop", "A→B"])
target_km = st.sidebar.slider("Target length (km)", min_value=10, max_value=200, value=40)
branch_bias = st.sidebar.slider("Branch bias", min_value=-1.0, max_value=1.0, value=config.branch_bias_default)
hill_disabled = not elevation_available()
hill_bias = st.sidebar.slider("Hill bias", min_value=-1.0, max_value=1.0, value=config.hill_bias_default, disabled=hill_disabled)
seed_str = st.sidebar.text_input("Seed (optional)", value="")

if st.sidebar.button("Load & Build Graph"):
    folder = Path(folder_str)
    lines = load_gpx_folder(folder)
    st.session_state["lines"] = lines
    if not lines:
        st.warning("No GPX lines found.")
    else:
        key = folder_fingerprint(folder)
        st.session_state["cache_key"] = key
        graph = None if rebuild else load_cache(key)
        if graph is None:
            fwd, inv, proj_lines = to_local_metric_crs(lines)
            snapped = snap_lines(proj_lines, config.snap_m)
            segments_xy = node_lines(snapped)
            segments_ll = [transform(inv, s) for s in segments_xy if s.length > 0]
            graph = build_graph_from_segments(segments_ll, config)
            save_cache(key, graph)
            st.success(f"Built graph with {graph.number_of_nodes()} nodes and {graph.number_of_edges()} edges")
        else:
            st.info("Loaded graph from cache")
        st.session_state["graph"] = graph

if st.sidebar.button("Generate Route"):
    if st.session_state["graph"] is None:
        st.warning("Build graph first")
    elif st.session_state["start_latlon"] is None:
        st.warning("Click on map to choose a start point")
    else:
        seed = int(seed_str) if seed_str.strip() else None
        g2, start_node, connector = add_temporary_start_node(st.session_state["graph"], st.session_state["start_latlon"], config)
        cand = stochastic_beam_search(
            g2,
            start_node=start_node,
            target_km=float(target_km),
            mode=mode,
            branch_bias=float(branch_bias),
            hill_bias=float(hill_bias),
            seed=seed,
            config=config,
        )
        if cand and cand.path_edges:
            st.session_state["route_geom"] = route_edges_to_linestring(cand.path_edges, g2)
            st.session_state["connector_geom"] = connector
            st.success(f"Generated route: {cand.length_m/1000:.2f} km")
        else:
            st.warning("No route found")

if st.sidebar.button("Export GPX"):
    rg = st.session_state.get("route_geom")
    if rg is None:
        st.warning("Generate a route first")
    else:
        with tempfile.NamedTemporaryFile("w", suffix=".gpx", delete=False) as tmp:
            out_path = Path(tmp.name)
        write_gpx(rg, out_path, name="Randomized Route")
        content = out_path.read_bytes()
        st.sidebar.download_button("Download GPX", data=content, file_name="random_route.gpx", mime="application/gpx+xml")

st.title("GPX Randomizer")

lines = st.session_state["lines"]
bbox = lines_bbox(lines)
if bbox:
    center = [(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2]
else:
    center = [0.0, 0.0]

m = folium.Map(location=center, zoom_start=12)
for line in lines:
    folium.PolyLine([(lat, lon) for lon, lat in line.coords], color="gray", weight=2, opacity=0.6).add_to(m)

if st.session_state["start_latlon"]:
    folium.Marker(location=st.session_state["start_latlon"], tooltip="Start").add_to(m)

if isinstance(st.session_state.get("connector_geom"), LineString):
    folium.PolyLine([(lat, lon) for lon, lat in st.session_state["connector_geom"].coords], color="orange", weight=3, dash_array="6,6").add_to(m)

if isinstance(st.session_state.get("route_geom"), LineString):
    folium.PolyLine([(lat, lon) for lon, lat in st.session_state["route_geom"].coords], color="red", weight=4).add_to(m)

map_data = st_folium(m, use_container_width=True, height=700)
if map_data and map_data.get("last_clicked"):
    click = map_data["last_clicked"]
    st.session_state["start_latlon"] = (click["lat"], click["lng"])
    st.rerun()
