#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Cuts every OSM extract this sheet needs out of the Geofabrik voivodeship
.pbf files — the same JSON shape Overpass returns ('elements': ways with tags,
node ids and geometry), so build.mjs and pipeline/osm-region.py cannot tell the
difference.

Four cuts, all of them boxes download.sh asks Overpass for:
  data/osm/krakow.json        roads over the city and its ring
  data/osm/tiles/tile1..4     roads over the whole of Malopolska, which
                              osm-region.py then thins to 2 km around an MLD
                              stop and merges into data/osm/malopolska.json
  data/osm/krakow-tram.json   railway=tram / light_rail
  data/osm/krakow-rail.json   main-line track for the WHOLE Koleje Malopolskie
                              rail network, drawn whole: Sedziszow, Oswiecim,
                              Tarnow, Jaslo and Zakopane — three extracts

Written 9.09.2026, when every public Overpass mirror answered 504 for an hour.
"""
import json, os, re, sys
import osmium

ROOT = os.path.join(os.path.dirname(__file__), '..')
PBFS = [os.path.join(ROOT, 'data', n) for n in
        ('malopolskie-latest.osm.pbf', 'swietokrzyskie-latest.osm.pbf',
         'podkarpackie-latest.osm.pbf')]
ROAD_BOX = (49.882, 19.564, 50.265, 20.373)   # S, W, N, E — as download.sh
TRAM_BOX = (49.95, 19.77, 50.15, 20.25)
# Koleje Malopolskie's whole rail network as far as it runs in Poland: Zakopane
# in the south, Sedziszow in the north, Jaslo in the east — which is why this
# cut reads three extracts. The operator's one cross-border train (Muszyna -
# Plavec) is not on this sheet, so no Slovak track is needed.
RAIL_BOX = (49.25, 19.10, 50.65, 21.60)
TILES = [(49.0, 19.15, 49.8, 20.35), (49.0, 20.35, 49.8, 21.55),
         (49.8, 19.15, 50.6, 20.35), (49.8, 20.35, 50.6, 21.55)]
HW = re.compile(r'^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|busway|construction|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$')
# the regional tiles skip the service roads that are not through routes — the
# same exclusion download.sh puts in its tile query
SERVICE_SKIP = {'parking_aisle', 'driveway', 'drive-through', 'emergency_access'}
TRAM = re.compile(r'^(tram|light_rail)$')
# construction/disused/proposed ride along the way Vienna's Verbindungsbahn did:
# a line being rebuilt is tagged for what it is becoming, and build.mjs renames
# the admitted ways back to `rail` before the graph is built
RAIL = re.compile(r'^(rail|construction|disused|proposed|narrow_gauge)$')

road_file = os.path.join(ROOT, 'data/osm/krakow.json')
tram_file = os.path.join(ROOT, 'data/osm/krakow-tram.json')
rail_file = os.path.join(ROOT, 'data/osm/krakow-rail.json')
tile_files = [os.path.join(ROOT, f'data/osm/tiles/tile{i + 1}.json') for i in range(len(TILES))]
need_road = not os.path.exists(road_file)
need_tram = not os.path.exists(tram_file)
need_rail = not os.path.exists(rail_file)
need_tiles = [i for i, f in enumerate(tile_files)
              if not os.path.exists(f) and not os.path.exists(os.path.join(ROOT, 'data/osm/malopolska.json'))]
print('drogi:', need_road, '| tramwaje:', need_tram, '| kolej:', need_rail,
      '| kafle:', len(need_tiles), flush=True)
if not (need_road or need_tram or need_rail or need_tiles):
    sys.exit(0)
os.makedirs(os.path.join(ROOT, 'data/osm/tiles'), exist_ok=True)
out_road, out_tram, out_rail = [], [], []
out_tiles = {i: [] for i in need_tiles}


def inside(box, la0, lo0, la1, lo1):
    return la1 >= box[0] and la0 <= box[2] and lo1 >= box[1] and lo0 <= box[3]


class H(osmium.SimpleHandler):
    def way(self, w):
        tags = w.tags
        hw, rw = tags.get('highway'), tags.get('railway')
        is_road = hw is not None and HW.match(hw) is not None
        is_tile = is_road and bool(out_tiles) and not (
            hw == 'service' and tags.get('service') in SERVICE_SKIP)
        is_road = is_road and need_road
        is_tram = need_tram and rw is not None and TRAM.match(rw)
        is_rail = need_rail and rw is not None and RAIL.match(rw)
        if not (is_road or is_tile or is_tram or is_rail):
            return
        geom, ids = [], []
        la0, la1, lo0, lo1 = 90.0, -90.0, 180.0, -180.0
        for n in w.nodes:
            try:
                lo, la = n.lon, n.lat
            except osmium.InvalidLocationError:
                continue
            # node ids ride along: buildGraph() builds topology from el.nodes
            # and SILENTLY skips ways without them (the London t13 hole)
            ids.append(n.ref)
            geom.append({'lat': la, 'lon': lo})
            if la < la0: la0 = la
            if la > la1: la1 = la
            if lo < lo0: lo0 = lo
            if lo > lo1: lo1 = lo
        if len(geom) < 2:
            return
        el = {'type': 'way', 'id': w.id, 'nodes': ids,
              'tags': {t.k: t.v for t in tags}, 'geometry': geom}
        if is_road and inside(ROAD_BOX, la0, lo0, la1, lo1):
            out_road.append(el)
        if is_tram and inside(TRAM_BOX, la0, lo0, la1, lo1):
            out_tram.append(el)
        if is_rail and inside(RAIL_BOX, la0, lo0, la1, lo1):
            out_rail.append(el)
        if is_tile:
            for i in out_tiles:
                if inside(TILES[i], la0, lo0, la1, lo1):
                    out_tiles[i].append(el)


for pbf in PBFS:
    if not os.path.exists(pbf):
        sys.exit('brak ' + pbf + ' — pobierz go (pipeline/download.sh)')
    print('czytam', os.path.basename(pbf), flush=True)
    H().apply_file(pbf, locations=True, idx='flex_mem')

GEN = 'pbf-cut.py (Geofabrik malopolskie + swietokrzyskie + podkarpackie)'


def dump(path, els, what):
    uniq, ids = [], set()
    for e in els:                      # a way on a voivodeship border is in both
        if e['id'] in ids:
            continue
        ids.add(e['id'])
        uniq.append(e)
    json.dump({'version': 0.6, 'generator': GEN, 'elements': uniq}, open(path, 'w'))
    print(f'{what}: {len(uniq)}', flush=True)


if need_road:
    dump(road_file, out_road, 'drogi')
if need_tram:
    dump(tram_file, out_tram, 'torowiska')
if need_rail:
    dump(rail_file, out_rail, 'tory kolejowe')
for i in need_tiles:
    dump(tile_files[i], out_tiles[i], f'kafel {i + 1}')
print('gotowe', flush=True)
