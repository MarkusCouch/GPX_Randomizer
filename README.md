# GPX Randomizer

Local Streamlit app to load GPX files, build a routable graph, and generate random routes with loop/A→B modes.

## Run

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
streamlit run app.py
```

## Tests

```bash
pytest -q
```
