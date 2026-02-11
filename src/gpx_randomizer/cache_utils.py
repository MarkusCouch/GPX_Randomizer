from __future__ import annotations

import hashlib
import pickle
from pathlib import Path

CACHE_DIR = Path("cache")


def folder_fingerprint(folder: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(folder.glob("*.gpx")):
        stat = p.stat()
        h.update(p.name.encode())
        h.update(str(stat.st_size).encode())
        h.update(str(int(stat.st_mtime)).encode())
    return h.hexdigest()[:20]


def save_cache(key: str, graph) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    out = CACHE_DIR / f"{key}.pkl"
    with out.open("wb") as f:
        pickle.dump(graph, f)
    return out


def load_cache(key: str):
    path = CACHE_DIR / f"{key}.pkl"
    if not path.exists():
        return None
    with path.open("rb") as f:
        return pickle.load(f)
