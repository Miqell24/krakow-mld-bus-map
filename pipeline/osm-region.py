#!/usr/bin/env python3
"""Merge Overpass road tiles into one extract, keeping only the ways that run
within REACH of a stop of the given GTFS — the regional road network of
Małopolska is mostly roads no MLD bus ever sees, and the matcher's graph has
no use for them. Ways are deduplicated by id across tiles.

usage: osm-region.py stops.txt out.json tile1.json [tile2.json …]
"""
import csv, json, math, sys

stops_file, out_file, *tiles = sys.argv[1:]
REACH_KM = 2.0
CELL = 0.02  # degrees latitude per grid cell (~2.2 km)

cells = set()
n_stops = 0
with open(stops_file, encoding='utf-8-sig', newline='') as fh:
    for s in csv.DictReader(fh):
        try:
            lat, lon = float(s['stop_lat']), float(s['stop_lon'])
        except (KeyError, ValueError):
            continue
        n_stops += 1
        kx = math.cos(math.radians(lat))
        # mark every cell whose centre lies within REACH of the stop (plus one cell of slack)
        r_lat = REACH_KM / 111.13
        r_lon = REACH_KM / (111.32 * kx)
        for cy in range(math.floor((lat - r_lat) / CELL) - 1, math.floor((lat + r_lat) / CELL) + 2):
            for cx in range(math.floor((lon - r_lon) / (CELL / kx)) - 1, math.floor((lon + r_lon) / (CELL / kx)) + 2):
                cells.add((cy, cx))

def near(lat, lon):
    kx = math.cos(math.radians(lat))
    return (math.floor(lat / CELL), math.floor(lon / (CELL / kx))) in cells

seen = set()
kept = []
total = 0
for t in tiles:
    with open(t, encoding='utf-8') as fh:
        data = json.load(fh)
    n_tile = 0
    for e in data.get('elements', []):
        if e.get('type') != 'way' or not e.get('geometry'):
            continue
        total += 1
        if e['id'] in seen:
            continue
        g = e['geometry']
        # a way is kept when any of its vertices (sampled) lies in a marked cell
        step = max(1, len(g) // 12)
        if any(near(p['lat'], p['lon']) for p in g[::step]) or near(g[-1]['lat'], g[-1]['lon']):
            seen.add(e['id'])
            kept.append(e)
            n_tile += 1
    print(f'{t}: {len(data.get("elements", []))} ways, kept {n_tile}', file=sys.stderr)
    del data

with open(out_file, 'w', encoding='utf-8') as fh:
    json.dump({'version': 0.6, 'generator': 'osm-region.py (merged Overpass tiles)', 'elements': kept}, fh, separators=(',', ':'))
print(f'{n_stops} stops → {len(cells)} cells; {total} ways in tiles → {len(kept)} kept → {out_file}', file=sys.stderr)
