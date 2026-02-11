from __future__ import annotations

from functools import lru_cache

try:
    import rasterio  # noqa: F401

    _HAS_RASTERIO = True
except Exception:
    _HAS_RASTERIO = False


def elevation_available() -> bool:
    return _HAS_RASTERIO


@lru_cache(maxsize=50000)
def edge_elevation_gain(edge_wkb: bytes, sample_step_m: float = 75.0) -> float:
    # Placeholder: no DEM attached; return 0 while maintaining cacheable interface.
    return 0.0
