# krakow-mld-bus-map — Kraków + Małopolska feeder lines (MLD)

The second variant of the Kraków map (23.08.2026): the KMK network exactly as on
[krakow-bus-map](https://miqell24.github.io/krakow-bus-map/) **plus everything
else Koleje Małopolskie run** — the Małopolskie Linie Dowozowe feeder buses
A1…A74, which fan out from the railway stations across the whole voivodeship
from Olkusz and Oświęcim to Tarnów, Nowy Sącz, Podhale and Poprad, and (since
9.09.2026) **the operator's whole rail network** those buses feed: the three
numbered SKA lines and the trains it brands by name instead — Dunajec
(Oświęcim – Kraków – Nowy Sącz), Hubal (Jasło – Tarnów – Kraków), Luxtorpeda
(Kraków – Zakopane) and the unnumbered KML from Nowy Sącz through Gorlice to
Jasło — on one sheet
of all Małopolska. **277 lines / 13 162 km**: 176 KMK buses, 70 MLD lines, 10
Wieliczka commune buses (WST), 23 trams and the operator's eight rail lines,
drawn exactly along
roadways and tracks (own HMM/Viterbi map matching on an OSM graph), line
numbers written parallel to every street they use, labeled stops, true
roundabout arcs. Weighted mean matching error 0.5 m. The original Kraków map
stays untouched — this is a separate project (port 8156, `npm run serve`).

Feeds: ZTP Kraków (buses `data/gtfs`, trams `data/gtfs-t`); the MLD feed from
**the operator's own file** (`data/gtfs-mld`,
gtfs.kolejemalopolskie.com.pl/GTFS-ST/GTFS.zip, the one odt.org.pl lists —
since 9.09.2026 in place of the CC0 mirror at files.girlc.at, because the
producer's file ships SHAPES and the mirror does not: the MLD corridors are
drawn from the operator's own geometry now, not reconstructed from stop
sequences; the "ZKA" rail-replacement routes stay out); the rail lines
(`data/gtfs-ska`) from gtfs.kasznia.net's sanitised copy of Koleje
Małopolskie's rail timetable, which is the only place the line numbers and the
train names survive — the producer files every train under the brand "KML"; and the Wieliczka commune
buses (`data/gtfs-wst`, B2…Z1): WST publishes no GTFS, so
`pipeline/kp-wst-gtfs.py` builds one from the operator's KiedyPrzyjedzie
timetable API (the same calls the public web page makes; no shapes, no
direction_id).

The road graph is the Kraków extract plus a regional extract of Małopolska,
both cut from the Geofabrik małopolskie/świętokrzyskie extracts by
`pipeline/pbf-cut.py` (Overpass answered 504 for an hour on 9.09.2026);
`pipeline/osm-region.py` keeps the regional ways within 2 km of an MLD stop and
merges them at load via `cfg.osmFiles`. The rail lines ride the rail slice of the graph
with the rail-trunk treatment (wide ribbon, station discs, names that never
fade), drawn WHOLE — SKA3 is 142 km end to end and the Dunajec calls at 53
stations. SKA1–SKA3 keep the operator's own colours, the named trains and the
KML take the rail purple (the Berlin arrangement). The rail cut therefore
reaches Zakopane and Jasło, and reads three Geofabrik extracts — małopolskie,
świętokrzyskie and podkarpackie. **The one train that leaves the country stays
out**: the Beliansky Express runs Muszyna – Plavec into Slovakia, and this is a
Małopolska sheet.

**What the operator calls these trains.** Koleje Małopolskie's own timetable page
lists eight rail relations: SKA1, SKA2 (two branches: Miechów – Sędziszów and
Skawina – Zator – Oświęcim), SKA3 (Tarnów, and Trzebinia – Oświęcim), **K5**
Kraków – Zakopane, **K7/K71** Kraków – Nowy Sącz / Jasło – Krynica-Zdrój, and
**M7** Muszyna – Poprad-Tatry. The SKA numbers reach the feed; the K and M ones
do not — there the same trains carry their brand names, which is what this map
prints: **K5 is the Luxtorpeda**, and **K7/K71 is the Dunajec, the Hubal and the
unnumbered KML** between them. They stay separate keys on purpose: filed under
one "K7" the three would share a direction key and two of the three corridors —
Kraków – Tarnów – Gorlice – Jasło and Nowy Sącz – Gorlice – Jasło — would lose
their geometry to the longest of them. M7 is the cross-border train and is not
on this sheet.

**Live map:** https://miqell24.github.io/krakow-mld-bus-map/ (local build on port 8156).

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
