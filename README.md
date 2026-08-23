# krakow-mld-bus-map — Kraków + Małopolska feeder lines (MLD)

The second variant of the Kraków map (23.08.2026): the KMK network exactly as on
[krakow-bus-map](https://miqell24.github.io/krakow-bus-map/) **plus the
Małopolskie Linie Dowozowe** — the Koleje Małopolskie feeder buses A1…A71 that
run from the railway stations across the whole voivodeship, from Olkusz and
Oświęcim to Tarnów, Nowy Sącz, Podhale and Poprad — on one sheet of all
Małopolska. **164 KMK bus lines + 67 MLD lines + 10 Wieliczka commune buses (WST) + 23 tram lines** drawn exactly
along roadways and tracks (own HMM/Viterbi map matching on an OSM graph), line
numbers written parallel to every street they use, labeled stops, true roundabout
arcs. The MLD numbers follow the KMK numbers in every list (street rows, badges,
panel). The original Kraków map stays untouched — this is a separate project
(port 8156, `npm run serve`).

Feeds: ZTP Kraków (buses `data/gtfs`, trams `data/gtfs-t`), the MLD feed from
files.girlc.at (`data/gtfs-mld`, CC0, regenerated nightly; no shapes, no
direction_id — stop sequences are the matching observations, the headsign the
direction key; the two "ZKA" routes are rail-replacement buses and stay out) and
the Wieliczka commune buses (`data/gtfs-wst`, B2…Z1): WST publishes no GTFS, so
`pipeline/kp-wst-gtfs.py` builds one from the operator's KiedyPrzyjedzie timetable
API (the same calls the public web page makes; no shapes, no direction_id).
The road graph is the Kraków extract plus a regional extract of Małopolska
(Overpass in tiles, `pipeline/osm-region.py` keeps the ways within 2 km of an
MLD stop, merged at load via `cfg.osmFiles`). Local only, not published.

**Live map:** not published (local build on port 8156).

## Network diagram

`/schematic/` is the second face of this map: an automatic transit diagram of
the same network (ported from the Rybnik Region map, 21.08.2026). Stop order,
branches and shared segments come straight from the two ZTP feeds; the station
graph is contracted into corridors and laid out on an octilinear grid by a
Stott–Rodgers-style local search with a cost built from geographic anchoring,
octant fidelity, crossings, overlaps and bends; the Vistula enters the layout
as a constraint (stations keep their bank, lines cross at their real bridges,
which are drawn as anchors). `npm run schematic` (`pipeline/schematic/`) reads
`data/gtfs*`, `data/osm/wisla.json` and `data/osm/bridges.json` and writes
`data/out/schematic/`; the page exports the whole sheet as one print-quality
PNG with a legend band. Kraków: 187 lines, 1 464 stations, 906 corridors,
13 Vistula bridges recognised, crossings 110 → 42 after the layout.

## Two views

The panel's **Corridors / Lines** switch (ported from the Tricity map, 21.08.2026)
redraws the same network line by line: a roadway carrying up to four lines is
drawn as four coloured strands side by side (each line keeps one colour across the
whole map), anything busier becomes one grey trunk with its numbers beside it in
the lines' colours. `npm run lines` (`pipeline/lines.mjs`) derives the strand
files from `data/out/`; `npm run audit` checks the drawn result (torn ends,
folds, doubles, every line one connected piece).

## Features

- GTFS (ZTP Kraków) matched onto the OSM road/tram network — mean error ~0.3 m,
  data gaps in the feed bridged by graph routing, unmapped construction sites drawn
  from the raw trace.
- KMK-style rendering: one stroke per roadway, aggregated line numbers rotated
  parallel to streets, shared bus+tram corridors get a single two-color number
  segment, termini labeled with their lines.
- Poster-style base map (warm tinted districts, green parks, blue water,
  pale-yellow motorways), narrow Roboto Condensed labels, stops drawn as
  half-discs oriented to the pole's side of the street, termini as filled discs.
- Panel with bus/tram visibility filters and a clickable line list (click a line to
  see its route with all stops).
- Poster-grade PNG export: the current view re-rendered in tiles at ~+3 zoom levels
  of extra detail (street and stop names become legible as you zoom into the image).
- GTFS shapes.txt quality report (`npm run report` → `data/gtfs-gaps-report.md`).

## Requirements

Node ≥ 18 (no npm dependencies), `curl`, `unzip`, internet on first run.

## Usage

```bash
npm run download   # ZTP GTFS + OSM (Overpass) + MapLibre (cached in data/ and web/vendor/)
npm run build      # extraction + map matching + GeoJSON files into data/out/
npm run serve      # http://localhost:8124
```

## Structure

- `pipeline/download.sh` — input data download
- `pipeline/build.mjs` — GTFS → OSM graph → HMM/Viterbi → `data/out/*.geojson`
- `pipeline/lib/` — csv (streaming), geo (local projection), graph (graph + Dijkstra), hmm (Viterbi)
- `pipeline/report-gaps.mjs` — GTFS shapes.txt gap report
- `web/` — MapLibre GL frontend (vendored, OpenFreeMap positron tiles)
- `docs/` — static bundle published via GitHub Pages (web + data/out copies)

Full plan and roadmap: [PLAN.md](PLAN.md).

## Data attribution

Map data © OpenStreetMap contributors · tiles by OpenFreeMap · timetables: GTFS ZTP Kraków.
