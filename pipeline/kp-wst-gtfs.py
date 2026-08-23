#!/usr/bin/env python3
"""KiedyPrzyjedzie → GTFS for the Wieliczka commune buses (Wielicka Spółka
Transportowa, WST).

WST publishes no GTFS anywhere — not on odt.org.pl (the request there sits at
"Brak umowy z dostawcą", 19.08.2026), not on files.girlc.at, not on
cdn.zbiorkom.live; the only machine-readable timetable is the operator's own
KiedyPrzyjedzie instance (https://wieliczka.kiedyprzyjedzie.pl), the one the
WST website points riders to. Its public web API (the same calls the web page
makes, no key) gives everything a route map needs:

  GET /stops?rev=N                    every pole: id, code, name, lon/lat ×1e6
  GET /api/directions/<place>?date=D  the lines (and their headsigns) at a pole
  GET /api/timetables/<place>?date=D  every departure at a pole that day, with trip ids
                                      (this "intercity" instance lists all lines
                                      together; a &line= filter is ignored)
  GET /api/trip/<tripId>/<index>      the full stop sequence and times of one trip,
                                      with its line name and headsign

So: all poles → which poles are served → every trip id departing from each
served pole (union over poles, so trips starting mid-route are not missed) →
every trip once, and the LINE COMES FROM THE TRIP (the first version took it
from the query and filed every trip under the alphabetically first line — B2
swallowed nine lines). Out comes a plain GTFS (agency, stops, routes,
calendar_dates, trips, stop_times, feed_info) that pipeline/build.mjs reads
like any other feed. No shapes (the stop sequence becomes the matching
observation, like GPA or MLD) and no direction_id (the headsign is the
direction key).

Dates: the commune lines run school-day and holiday patterns; one school-day
date and one holiday date (both inside KiedyPrzyjedzie's horizon) give the
full picture. Each date becomes its own service_id.

Every GET is cached on disk (<outdir>/.kp-cache) — the API answers in ~1–3 s,
so a rerun must not pay for the ~2 500 calls again.

usage: kp-wst-gtfs.py <outdir> [date ...]     (dates YYYY-MM-DD)
"""
import csv, hashlib, json, os, re, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

BASE = 'https://wieliczka.kiedyprzyjedzie.pl'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
AGENCY = ('wst', 'Wielicka Spółka Transportowa Sp. z o.o.', 'https://wst.info.pl/')
THREADS = 6

out_dir = sys.argv[1]
dates = sys.argv[2:] or ['2026-09-02', '2026-08-25']
os.makedirs(out_dir, exist_ok=True)
cache_dir = os.path.join(out_dir, '.kp-cache')
os.makedirs(cache_dir, exist_ok=True)


def get(path, tries=4):
    """curl, not urllib: this python build has no CA bundle for urllib."""
    cp = os.path.join(cache_dir, hashlib.md5(path.encode()).hexdigest() + '.json')
    if os.path.exists(cp):
        with open(cp, encoding='utf-8') as fh:
            return json.load(fh)
    for attempt in range(tries):
        r = subprocess.run(['curl', '-sS', '--max-time', '60', '-A', UA, '-H', 'Accept: application/json',
                            '-H', 'Referer: ' + BASE + '/', BASE + path], capture_output=True, text=True)
        txt = r.stdout
        if r.returncode == 0 and txt and not txt.lstrip().startswith('<'):
            try:
                data = json.loads(txt)
            except json.JSONDecodeError:
                data = None
            if data is not None:
                with open(cp, 'w', encoding='utf-8') as fh:
                    json.dump(data, fh)
                return data
        time.sleep(1.5 * (attempt + 1))
    print(f'  ! gave up on {path}', file=sys.stderr)
    return None


t0 = time.time()
def log(m):
    print(f'[{time.time() - t0:5.0f}s] {m}', file=sys.stderr, flush=True)


# 1) the poles. The web page carries the stops revision; fall back to 0 (the
#    server answers the current set for any revision).
rev = 0
html = subprocess.run(['curl', '-sS', '--max-time', '60', '-A', UA, BASE + '/'], capture_output=True, text=True).stdout
m = re.search(r'data-stops-revision="(\d+)"', html)
if m:
    rev = int(m.group(1))
stops = (get(f'/stops?rev={rev}') or {}).get('stops') or []
if not stops:
    sys.exit('no stops from KiedyPrzyjedzie')
log(f'{len(stops)} poles (revision {rev})')

# 2) which poles are served at all (one date is enough for that)
def directions(pid):
    d = get(f'/api/directions/{pid}?date={dates[0]}') or {}
    return pid, {x['line'] for x in d.get('directions', [])}
served = []
with ThreadPoolExecutor(max_workers=THREADS) as ex:
    for pid, lines in ex.map(directions, [s[0] for s in stops]):
        if lines:
            served.append(pid)
log(f'{len(served)} poles served')

# 3) every trip id departing from a served pole, per date
trip_dates = {}  # trip_id → set(date)
def timetable(args):
    date, pid = args
    d = get(f'/api/timetables/{pid}?date={date}') or {}
    return date, [x['trip_id'] for x in d.get('departures', [])]
jobs = [(date, pid) for date in dates for pid in served]
with ThreadPoolExecutor(max_workers=THREADS) as ex:
    for date, tids in ex.map(timetable, jobs):
        for tid in tids:
            trip_dates.setdefault(tid, set()).add(date)
log(f'{len(trip_dates)} distinct trips from {len(jobs)} timetable calls')

# 4) each trip once: stop sequence, line, headsign
def trip(tid):
    d = get(f'/api/trip/{tid}/0') or {}
    return tid, d
trips = {}
with ThreadPoolExecutor(max_workers=THREADS) as ex:
    for tid, d in ex.map(trip, sorted(trip_dates)):
        times = d.get('times') or []
        line = ((d.get('line') or {}).get('name') or '').strip()
        if times and line:
            trips[tid] = (line, d.get('direction') or times[-1]['stop_name'], times)
log(f'{len(trips)} trips with stop sequences')

# 5) GTFS
def w(name, header, rows):
    with open(os.path.join(out_dir, name), 'w', encoding='utf-8', newline='') as fh:
        cw = csv.writer(fh)
        cw.writerow(header)
        cw.writerows(rows)

lines_all = sorted({v[0] for v in trips.values()})
used_stops = {t['place_id'] for v in trips.values() for t in v[2]}
w('agency.txt', ['agency_id', 'agency_name', 'agency_url', 'agency_timezone', 'agency_lang'],
  [[AGENCY[0], AGENCY[1], AGENCY[2], 'Europe/Warsaw', 'pl']])
w('stops.txt', ['stop_id', 'stop_code', 'stop_name', 'stop_lat', 'stop_lon'],
  [[s[0], s[1], s[2], f'{s[4] / 1e6:.6f}', f'{s[3] / 1e6:.6f}'] for s in stops if s[0] in used_stops])
w('routes.txt', ['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type'],
  [[l, AGENCY[0], l, '', '3'] for l in lines_all])
# one service per queried date, valid on that day only — the map needs the
# trips and their counts, not a calendar to plan by
w('calendar_dates.txt', ['service_id', 'date', 'exception_type'],
  [[f'd{d}', d.replace('-', ''), '1'] for d in dates])
trip_rows, st_rows = [], []
for tid in sorted(trips):
    line, headsign, times = trips[tid]
    for date in sorted(trip_dates[tid]):
        trip_id = f'{tid}_{date}'
        trip_rows.append([line, f'd{date}', trip_id, headsign])
        for i, t in enumerate(times):
            hhmm = (t.get('departure_time') or '00:00') + ':00'
            st_rows.append([trip_id, hhmm, hhmm, t['place_id'], i + 1])
w('trips.txt', ['route_id', 'service_id', 'trip_id', 'trip_headsign'], trip_rows)
w('stop_times.txt', ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'], st_rows)
w('feed_info.txt', ['feed_publisher_name', 'feed_publisher_url', 'feed_lang', 'feed_start_date', 'feed_end_date', 'feed_version'],
  [['WST timetables via kiedyPrzyjedzie.pl (converted by krakow-bus-map/pipeline/kp-wst-gtfs.py)',
    BASE, 'pl', min(dates).replace('-', ''), max(dates).replace('-', ''), time.strftime('%Y%m%d')]])
per_line = {}
for line, _, _ in trips.values():
    per_line[line] = per_line.get(line, 0) + 1
log(f'wrote {out_dir}: {len(lines_all)} lines ({", ".join(f"{l} {n}" for l, n in sorted(per_line.items()))}), '
    f'{len(trip_rows)} trip-days, {len(st_rows)} stop_times, {len(used_stops)} stops')
