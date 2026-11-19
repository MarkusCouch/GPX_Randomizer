# GPX Randomizer

## Web-MVP (GitHub Pages)

Das statische Browser-MVP liegt in [`docs/`](docs/) und läuft komplett im Browser (kein Backend).
Details, Aufbau und Lizenzhinweise: [`docs/README.md`](docs/README.md).

**Veröffentlichen:** Repo → *Settings → Pages → Build and deployment* →
Source: *Deploy from a branch*, Branch: `main`, Ordner: `/docs` → *Save*.
Danach erreichbar unter `https://markuscouch.github.io/GPX_Randomizer/`.

**Lokal testen:**

```bash
cd docs && python3 -m http.server 8000
```

## Streamlit-Prototyp (lokal)

Lokale Streamlit-App, die GPX-Dateien lädt, einen routingfähigen Graphen baut und Zufallsrouten (Rundtour / A→B) erzeugt.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
streamlit run app.py
```

Tests:

```bash
pytest -q
```
