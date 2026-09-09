#!/usr/bin/env bash
# Downloads input data: the GTFS feeds (ZTP Kraków, Koleje Małopolskie MLD and
# SKA, WST Wieliczka), the OSM networks (Geofabrik + pyosmium) and MapLibre GL.
# Everything is cached — re-running only fetches what is missing.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/gtfs data/gtfs-t data/gtfs-mld data/gtfs-ska data/gtfs-wst data/osm web/vendor

# A downloaded extract is only accepted if it PARSES and carries a plausible
# number of elements. `grep -q '"elements"'` — the guard this family used
# everywhere — passes on a truncated response too: Brașov's roads arrived as a
# 65 kB fragment that still contained the string, was taken for complete, and
# silently skipped the city (16.08.2026).
# The minimum differs by extract: a road network runs to tens of thousands of
# ways, a tram network to a few hundred, so the caller passes its own floor
# rather than sharing one.
# A rejected file is deleted rather than left behind — the `[ ! -f … ]` gates
# below only ask whether the file exists, so a fragment on disk would be taken
# for a finished download on the next run.
ok_json () { # $1=file  $2=minimum element count
  python3 - "$1" "$2" <<'PYEOF' 2>/dev/null
import json, sys
try:
    sys.exit(0 if len(json.load(open(sys.argv[1])).get("elements", [])) >= int(sys.argv[2]) else 1)
except Exception:
    sys.exit(1)
PYEOF
}

# 1) GTFS — KMK buses
if [ ! -f data/gtfs/routes.txt ]; then
  echo "== GTFS_KRK_A.zip =="
  curl -fL --retry 3 --max-time 300 -o data/GTFS_KRK_A.zip https://gtfs.ztp.krakow.pl/GTFS_KRK_A.zip
  unzip -o data/GTFS_KRK_A.zip -d data/gtfs
fi

# 1b) GTFS — KMK trams
if [ ! -f data/gtfs-t/routes.txt ]; then
  echo "== GTFS_KRK_T.zip =="
  curl -fL --retry 3 --max-time 300 -o data/GTFS_KRK_T.zip https://gtfs.ztp.krakow.pl/GTFS_KRK_T.zip
  unzip -o data/GTFS_KRK_T.zip -d data/gtfs-t
fi

# 1c) GTFS — Małopolskie Linie Dowozowe (Koleje Małopolskie feeder buses),
#     the operator's OWN file (gtfs.kolejemalopolskie.com.pl, the one
#     odt.org.pl lists). It ships SHAPES, which the CC0 mirror at
#     files.girlc.at used until 9.09.2026 does not — the corridors are drawn
#     from the operator's geometry now, not reconstructed from stop sequences.
if [ ! -f data/gtfs-mld/routes.txt ]; then
  echo "== MLD (Koleje Małopolskie) =="
  curl -fL --retry 3 --max-time 600 -o data/gtfs-mld.zip "https://gtfs.kolejemalopolskie.com.pl/GTFS-ST/GTFS.zip"
  unzip -o data/gtfs-mld.zip -d data/gtfs-mld
fi

# 1c2) GTFS — the SKA lines. The same operator's RAIL timetable files every
#      train under the brand "KML" and never names a line, so SKA1–SKA3 exist
#      only in the sanitised copy gtfs.kasznia.net rebuilds from it (CC BY,
#      kasmar00/gtfs-polish-trains) — as proper routes, in KM's own colours.
if [ ! -f data/gtfs-ska/routes.txt ]; then
  echo "== SKA (Koleje Małopolskie) =="
  curl -fL --retry 3 --max-time 300 -o data/ska-gtfs.zip "https://gtfs.kasznia.net/static/sanitized/kml.zip"
  unzip -o data/ska-gtfs.zip -d data/gtfs-ska
fi

# 1d) GTFS — Wieliczka commune buses (Wielicka Spółka Transportowa). No GTFS
#     exists anywhere (odt.org.pl: request pending, "Brak umowy z dostawcą"); the
#     operator's KiedyPrzyjedzie instance is the only machine-readable timetable,
#     and pipeline/kp-wst-gtfs.py turns its public web API into a plain GTFS.
if [ ! -f data/gtfs-wst/routes.txt ]; then
  echo "== WST (Wieliczka) via KiedyPrzyjedzie =="
  python3 pipeline/kp-wst-gtfs.py data/gtfs-wst
fi

# 2) OSM — from the Geofabrik voivodeship extracts, not Overpass. On 9.09.2026
#    every public mirror answered these queries with 504 for an hour (the wall
#    Berlin, London, São Paulo and Vienna hit before), so the cuts are made
#    locally: pipeline/pbf-cut.py (needs `pip3 install --user osmium`) writes
#    exactly the JSON Overpass would have returned, node ids included, for
#    every box this sheet needs — the city's roads, the four Małopolska road
#    tiles, the tram tracks and the main-line track of the SKA trains, which
#    reaches Sędziszów and so reads świętokrzyskie as well as małopolskie.
#    pipeline/osm-region.py then thins the regional tiles to 2 km around an MLD
#    stop and merges them into data/osm/malopolska.json; the Kraków extract
#    keeps the city complete and the two are merged at build time.
if [ ! -f data/osm/krakow.json ] || [ ! -f data/osm/krakow-tram.json ]    || [ ! -f data/osm/krakow-rail.json ] || [ ! -f data/osm/malopolska.json ]; then
  python3 -c "import osmium" 2>/dev/null || { echo "brak pakietu osmium — zainstaluj: pip3 install --user osmium" >&2; exit 1; }
  for V in malopolskie swietokrzyskie podkarpackie; do
    if [ ! -f "data/$V-latest.osm.pbf" ]; then
      echo "== Geofabrik $V-latest.osm.pbf =="
      curl -fL --retry 5 --retry-delay 5 -C - --max-time 3600 -o "data/$V-latest.osm.pbf"         "https://download.geofabrik.de/europe/poland/$V-latest.osm.pbf"
    fi
  done
  echo "== cutting OSM out of the extracts =="
  python3 pipeline/pbf-cut.py
  if [ ! -f data/osm/malopolska.json ]; then
    python3 pipeline/osm-region.py data/gtfs-mld/stops.txt data/osm/malopolska.json data/osm/tiles/tile*.json
  fi
fi

# 3) MapLibre GL (vendored, no CDN at runtime)
if [ ! -f web/vendor/maplibre-gl.js ]; then
  echo "== MapLibre GL =="
  curl -fL --retry 3 -o web/vendor/maplibre-gl.js  https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.js
  curl -fL --retry 3 -o web/vendor/maplibre-gl.css https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.css
fi

echo "OK — data ready:"
du -sh data/GTFS_KRK_A.zip data/osm/krakow.json web/vendor/maplibre-gl.js 2>/dev/null || true

# 3) OSM — the Vistula and its bridges, for the network diagram (pipeline/schematic):
#    the river is a layout CONSTRAINT there (banks, crossings at the real bridges)
if [ ! -f data/osm/wisla.json ]; then
  echo "== Overpass (Wisła) =="
  QW='[out:json][timeout:180];way["waterway"="river"]["name"~"^Wis[łl]a$"](49.93,19.70,50.16,20.30);out geom;'
  for EP in "https://overpass-api.de/api/interpreter" "https://maps.mail.ru/osm/tools/overpass/api/interpreter" "https://overpass.kumi.systems/api/interpreter"; do
    curl -fsS --max-time 300 -o data/osm/wisla.json --data-urlencode "data=$QW" "$EP" && break
  done
fi
if [ ! -f data/osm/bridges.json ]; then
  echo "== Overpass (bridges) =="
  QB='[out:json][timeout:180];(way["bridge"="yes"]["highway"](49.98,19.80,50.10,20.15);way["bridge"="yes"]["railway"](49.98,19.80,50.10,20.15);way["bridge"="yes"]["man_made"="bridge"](49.98,19.80,50.10,20.15););out geom;'
  for EP in "https://overpass-api.de/api/interpreter" "https://maps.mail.ru/osm/tools/overpass/api/interpreter" "https://overpass.kumi.systems/api/interpreter"; do
    curl -fsS --max-time 400 -o data/osm/bridges.json --data-urlencode "data=$QB" "$EP" && break
  done
fi
