# GPX Randomizer

Aus deiner GPX-Sammlung wird ein Wegenetz, aus dem sich neue Runden und A→B-Touren
zusammensetzen lassen. Routing und Netzaufbau laufen komplett im Browser (Web Worker),
es gibt kein Backend.

**Stand:** MVP 07.3 · Beispieldatensatz mit 24 anonymisierten Touren (Berlin & Brandenburg)

## Auf GitHub Pages veröffentlichen

1. Neues Repository auf GitHub anlegen und den Inhalt dieses Ordners hochladen
   (Dateien an die Wurzel des Repos, nicht den Ordner selbst).
2. Im Repo: **Settings → Pages → Build and deployment**
   - Source: **Deploy from a branch**
   - Branch: **main**, Ordner **/ (root)** → Save
3. Nach ca. 1 Minute ist die App unter
   `https://<dein-name>.github.io/<repo-name>/` erreichbar.

Die Datei `.nojekyll` sorgt dafür, dass GitHub die Dateien unverändert ausliefert.

## Lokal starten

Wegen ES-Modulen und `fetch` funktioniert ein Doppelklick auf `index.html` nicht.
Stattdessen im Ordner einen kleinen Server starten:

```bash
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

## Aufbau

```
index.html                  Oberfläche
css/app.css                 Styles der App
css/maplibre-gl.css         Styles der Kartenbibliothek
js/app.js                   UI, Import/Export, Ablaufsteuerung
js/network.js               Wegenetz-Aufbau und Routensuche (läuft im Worker)
js/worker.js                Web Worker
js/osm.js, js/osm-data.js   OSM-Zuordnung, Referenzdaten, Overpass-Nachladen
js/map.js, js/geo.js        Kartenansicht, Geometrie
vendor/maplibre-gl.js       MapLibre GL JS 4.7.1 (BSD-3-Clause)
data/demo-tracks.json       24 Beispiel-Tracks
data/osm-reference.json     vorbereitete OSM-Referenz (ca. 13 MB)
beispielrunde-schmoeckwitzwerder.gpx   Beispiel-Route für Navigationsgeräte
```

## Eigene Tracks

Im Tab **Datensatz** lassen sich eigene GPX-Dateien hinzufügen. Das Wegenetz wird dann
neu aufgebaut. Dabei können OSM-Abfragen (Overpass API) ausgelöst werden.

## Netzwerkzugriffe

- Hintergrundkarte: `tiles.openfreemap.org` (ohne Internet bleibt das Wegenetz nutzbar)
- Neue GPX-Importe: optional `overpass-api.de`

## Lizenzen und Hinweise

- OSM-Daten: © OpenStreetMap-Mitwirkende, ODbL 1.0, siehe `OSM-NOTICE.txt`
- MapLibre GL JS: BSD-3-Clause
- Die enthaltenen GPX-Tracks sind Nutzereingaben; bitte nur veröffentlichen, wenn du
  dazu berechtigt bist. Für den Code ist noch keine Lizenz festgelegt (z. B. MIT ergänzen).
