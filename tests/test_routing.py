import networkx as nx
from shapely.geometry import LineString

from gpx_randomizer.config import Config
from gpx_randomizer.routing import stochastic_beam_search


def test_loop_route_length_and_closure():
    g = nx.Graph()
    a, b, c, d = (0.0, 0.0), (0.001, 0.0), (0.001, 0.001), (0.0, 0.001)
    for u, v in [(a, b), (b, c), (c, d), (d, a)]:
        g.add_edge(u, v, geometry=LineString([u, v]), length_m=1000.0, bearing=0.0, elev_gain_m=0.0)

    cand = stochastic_beam_search(
        g,
        start_node=a,
        target_km=4.0,
        mode="Loop",
        seed=42,
        config=Config(target_len_tol=0.1, beam_width=30),
    )
    assert cand is not None
    assert cand.current_node == a
    assert abs(cand.length_m - 4000) <= 400
