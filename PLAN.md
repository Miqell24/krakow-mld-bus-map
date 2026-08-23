# PLAN — Interactive KMK Kraków map (started with: bus line 102)

Target: an interactive (zoom/pan) web map of Kraków public transport in the visual
logic of the official KMK map (ztp.krakow.pl → "Mapy i schematy KMK"): lines drawn
**exactly along roadways**, line numbers written along every street they use, stops
labeled, correct roundabout arcs and intersection turns. Start: **bus 102**, with an
architecture ready for all lines from day one.

## Architecture

- **Plain JavaScript**: pipeline in Node ≥ 18 (no npm dependencies), frontend in the browser.
- **Input data**: ZTP Kraków GTFS (`gtfs.ztp.krakow.pl/GTFS_KRK_A.zip` — buses)
  + OSM road network via the Overpass API (bbox of the whole city and beyond).
- **Map matching**: own HMM/Viterbi implementation (Newson–Krumm 2009) on a directed
  road graph — the heart of the project.
- **Frontend**: MapLibre GL JS (vendored) + OSM vector tiles from OpenFreeMap
  (`positron` style — light background like the KMK map). Static server on port **8124**.

## Stages — step by step

### Stage 1 — data download (`pipeline/download.sh`)
1. ZTP bus GTFS → `data/gtfs/` (routes, trips, shapes, stop_times, stops).
2. Overpass: all roadways in the Kraków bbox (`motorway…residential`, `service`, `busway`,
   `*_link` **and `highway=construction`** — roadworks/the tram build to Mistrzejowice
   can "puncture" the graph while buses really drive there) → `data/osm/krakow.json`.
   Mirror order: overpass-api.de → maps.mail.ru → kumi.systems.
3. MapLibre GL 5.6.1 → `web/vendor/` (no CDN at runtime).

### Stage 2 — line extraction from GTFS (`pipeline/build.mjs`)
1. `routes.txt` → `route_id` for each `route_short_name`.
2. `trips.txt` → the line's trips; for each direction (`direction_id` 0/1) pick the
   **representative route variant** = the `shape_id` serving the most trips.
3. `stop_times.txt` (streamed — the file is huge) → the stop sequence of the
   representative trip in each direction.
4. `shapes.txt` (streamed) → the route polyline; `stops.txt` → pole names and positions.

### Stage 3 — road graph from OSM (`pipeline/lib/graph.mjs`)
1. Every pair of adjacent way nodes = a **directed segment** of the graph.
2. Directionality: `oneway=yes/-1`, exceptions `oneway:bus|psv=no`,
   **`junction=roundabout/circular` ⇒ always one-way** (crucial for roundabouts).
3. Access filters: `access=no/private` drops out unless `bus=yes`/`psv=yes` (bus
   gates!); service roads like `parking_aisle` drop out; others carry cost penalties.
4. Spatial index (120 m grid) for fast candidate lookup.

### Stage 4 — HMM/Viterbi map matching (`pipeline/lib/hmm.mjs`) — THE HEART
1. The GTFS polyline resampled every ~20 m = observations.
2. **Candidates**: projections of each point onto segments within 45 m (retry 70 m
   before declaring a hole), up to 12 per point, penalty-aware ranking.
3. **Emission**: Gaussian penalty for projection distance, σ = 8 m.
4. **Transition**: `-|routing_dist − straight_dist| / β`, β = 32 m; routing distance
   via Dijkstra on the directed graph (capped), with correct partial-segment math.
5. **Viterbi** picks the globally most consistent segment chain; when no transition
   exists — a controlled break, bridged by routing.
6. Output geometry = a **chain of OSM nodes**, not GPS points ⇒ on a roundabout the
   line follows the true arc (one-way rules force the loop, no shortcut through the
   middle), and turns run along roadway axes — zero corner cutting.
7. Quality report: matched point %, mean error, break count, roundabout segments used.

### Stage 5 — data products (`data/out/`)
- `route.geojson` — per-direction runs (with headsigns).
- `streets.geojson` — segments merged per street with the line list — this is where
  the **line numbers written along streets** come from; scales to many lines.
- `stops.geojson` — stops **snapped to the matched route** (the dot sits on the line,
  like on the KMK map), with names; termini highlighted.
- `labels.geojson` — one number label per (street × line set), with street bearing.
- `meta.json` — statistics, bbox, line info.

### Stage 6 — frontend in the KMK map logic (`web/`)
- Bus line: **navy stroke with a white casing** along roadways; trams red.
- Line numbers rotated parallel to the street, standing beside it; shared bus+tram
  corridors get one two-color number segment.
- Stops: white dots with a colored ring **on the line**, labels with halo, termini
  bold with their line numbers; label density depends on zoom.
- Layers inserted BELOW the base style street names (names stay readable).
- Zoom/pan/scale, stop popup, minimal English panel: legend, bus/tram visibility
  filters, clickable line list (click = that line's route with all stops), poster
  PNG export.

### Stage 7 — verification
- Browser console clean; visual checks: full overview, close-ups of **roundabouts**
  and selected intersections; stop list consistency with GTFS.

## Roadmap (after acceptance)
1. ~~All bus lines~~ done (164 lines). ~~All tram lines~~ done (23 lines).
2. KMK-style corridors: merging twin carriageways into one stroke, ramp absorption,
   smoothing — **roundabouts always excluded** (true arc). Deferred: needs a
   "corridor axes" preprocessing approach.
3. Route variants + one-way arrows (ZTP convention).
4. Per-tram-line colors.
5. Line/stop search with highlighting, GTFS-RT (live positions), hosting.
