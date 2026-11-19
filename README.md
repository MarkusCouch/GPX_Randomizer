# GPX Randomizer

Aus einer GPX-Sammlung wird ein Wegenetz, aus dem sich neue Runden und A→B-Touren
zusammensetzen lassen. Läuft komplett im Browser (kein Backend).

**Live:** https://markuscouch.github.io/GPX_Randomizer/

Die App liegt in [`docs/`](docs/). Details, Aufbau und Lizenzhinweise:
[`docs/README.md`](docs/README.md).

## Veröffentlichen

Repo → *Settings → Pages → Build and deployment* → Source: *Deploy from a branch*,
Branch: `main`, Ordner: `/docs` → *Save*.

## Lokal testen

```bash
cd docs && python3 -m http.server 8000
```

Dann http://localhost:8000 öffnen.
