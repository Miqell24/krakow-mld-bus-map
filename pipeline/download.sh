#!/usr/bin/env bash
# Downloads input data: ZTP GTFS feeds, OSM road network (Overpass), MapLibre GL.
# Everything is cached — re-running only fetches what is missing.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/gtfs data/gtfs-t data/osm web/vendor

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
#     the CC0 feed regenerated nightly at files.girlc.at (the operator's own
#     ald-gtfs.zip is the same data: no shapes, no direction_id). The host
#     answers 403 to a bare curl; a browser User-Agent is all it wants.
if [ ! -f data/gtfs-mld/routes.txt ]; then
  echo "== malopolskie_linie_dowozowe.zip =="
  curl -fL --retry 3 --max-time 300 -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" \
    -o data/gtfs-mld.zip https://files.girlc.at/gtfs/malopolskie_linie_dowozowe.zip
  unzip -o data/gtfs-mld.zip -d data/gtfs-mld
fi

# 1d) GTFS — Wieliczka commune buses (Wielicka Spółka Transportowa). No GTFS
#     exists anywhere (odt.org.pl: request pending, "Brak umowy z dostawcą"); the
#     operator's KiedyPrzyjedzie instance is the only machine-readable timetable,
#     and pipeline/kp-wst-gtfs.py turns its public web API into a plain GTFS.
if [ ! -f data/gtfs-wst/routes.txt ]; then
  echo "== WST (Wieliczka) via KiedyPrzyjedzie =="
  python3 pipeline/kp-wst-gtfs.py data/gtfs-wst
fi

# 2) OSM — roadways in the bbox of the whole bus network (GTFS shapes extent + margin;
#    suburban 2xx lines reach Krzeszowice, Skała, Świątniki), incl. highway=construction
if [ ! -f data/osm/krakow.json ]; then
  echo "== Overpass =="
  Q='[out:json][timeout:300];way(49.882,19.564,50.265,20.373)["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|busway|construction|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"];out geom;'
  ok=0
  for EP in "https://overpass-api.de/api/interpreter" \
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter" \
            "https://overpass.kumi.systems/api/interpreter"; do
    echo "-- $EP"
    if curl -fsS --max-time 300 -o data/osm/krakow.json --data-urlencode "data=$Q" "$EP" \
       && ok_json "data/osm/krakow.json" 2000; then
      ok=1; break
    fi
  done
  [ "$ok" = 1 ] || { rm -f data/osm/krakow.json; echo "Overpass: all mirrors failed" >&2; exit 1; }
fi

# 2a) OSM — the regional road network for the MLD corridors: the whole of
#     Małopolska (49.0–50.6 N, 19.15–21.55 E) in four Overpass tiles, without
#     parking aisles and driveways (a third of the region's ways, never ridden
#     by a bus), then pipeline/osm-region.py keeps only the ways within 2 km of
#     an MLD stop and merges the tiles into data/osm/malopolska.json. The
#     Kraków extract above keeps the city complete; the two are merged at build
#     time (cfg.osmFiles).
if [ ! -f data/osm/malopolska.json ]; then
  mkdir -p data/osm/tiles
  i=0
  for BB in "49.0,19.15,49.8,20.35" "49.0,20.35,49.8,21.55" "49.8,19.15,50.6,20.35" "49.8,20.35,50.6,21.55"; do
    i=$((i+1))
    [ -f "data/osm/tiles/tile$i.json" ] && continue
    Q="[out:json][timeout:900][maxsize:1500000000];(way($BB)[\"highway\"~\"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|busway|construction|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$\"];way($BB)[\"highway\"=\"service\"][\"service\"!~\"^(parking_aisle|driveway|drive-through|emergency_access)$\"];);out geom;"
    ok=0
    for EP in "https://overpass-api.de/api/interpreter" "https://maps.mail.ru/osm/tools/overpass/api/interpreter" "https://overpass.kumi.systems/api/interpreter"; do
      echo "-- tile $i ($BB) via $EP"
      if curl -fsS --max-time 900 -o "data/osm/tiles/tile$i.json" --data-urlencode "data=$Q" "$EP" \
         && ok_json "data/osm/tiles/tile$i.json" 2000; then ok=1; break; fi
    done
    [ "$ok" = 1 ] || { rm -f "data/osm/tiles/tile$i.json"; echo "Overpass (tile $i): all mirrors failed — split the tile and retry" >&2; exit 1; }
  done
  python3 pipeline/osm-region.py data/gtfs-mld/stops.txt data/osm/malopolska.json data/osm/tiles/tile*.json
fi

# 2b) OSM — tram tracks (separate network: railway=tram, not roadways)
if [ ! -f data/osm/krakow-tram.json ]; then
  echo "== Overpass (trams) =="
  QT='[out:json][timeout:120];way(49.95,19.77,50.15,20.25)["railway"~"^(tram|light_rail)$"];out geom;'
  ok=0
  for EP in "https://maps.mail.ru/osm/tools/overpass/api/interpreter" \
            "https://overpass-api.de/api/interpreter" \
            "https://overpass.kumi.systems/api/interpreter"; do
    echo "-- $EP"
    if curl -fsS --max-time 180 -o data/osm/krakow-tram.json --data-urlencode "data=$QT" "$EP" \
       && ok_json "data/osm/krakow-tram.json" 40; then
      ok=1; break
    fi
  done
  [ "$ok" = 1 ] || { rm -f data/osm/krakow-tram.json; echo "Overpass (tram): all mirrors failed" >&2; exit 1; }
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
