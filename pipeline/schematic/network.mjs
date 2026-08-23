// GTFS intake for the schematic mode. Mirrors phases 1–4 of pipeline/build.mjs
// (routes → trips → stop_times → stops) with one deliberate difference: build.mjs
// elects a single representative shape per line+direction, the diagram keeps
// EVERY stop-sequence pattern above a trip-share threshold — real branches must
// appear (rule 8), depot runs and rare short-turns must not.
import { join } from 'node:path';
import { iterCsv, readCsv } from '../lib/csv.mjs';

// One feed → { mode, lines: [{line, mode, dirs: [{dir, variants: [{stops, trips,
// headsign}]}]}], poles: Map(stop_id → {name, lat, lon, group}) }
export async function readFeed(root, feed, cfg, log) {
  const dir = join(root, feed.gtfsDir);

  // 1) routes.txt → route_id → line (short name)
  const routes = await readCsv(join(dir, 'routes.txt'));
  const routeToLine = new Map();
  for (const r of routes) {
    // a multi-mode feed is split by route_type per cfg feed entry (Warsaw: one
    // ZTM bundle carries buses, trams, metro and SKM)
    if (feed.routeTypes && !feed.routeTypes.includes((r.route_type || '').trim())) continue;
    if (feed.skipRoute && feed.skipRoute(r)) continue;
    // the feed's own key rule decides what a line is called here, and null
    // drops the route entirely (depot runs, lines duplicated by another feed)
    const key = feed.mapKey
      ? feed.mapKey((r.route_short_name || '').trim())
      : (r.route_short_name || '').trim();
    if (key) routeToLine.set(r.route_id, key);
  }

  // 2) trips.txt → trip → line + direction + headsign
  const tripInfo = new Map();
  for await (const t of iterCsv(join(dir, 'trips.txt'))) {
    const line = routeToLine.get(t.route_id);
    if (!line) continue;
    tripInfo.set(t.trip_id, { line, dir: t.direction_id || '0', headsign: (t.trip_headsign || '').trim() });
  }

  // 3) stop_times.txt (streaming — the bus feed has 1.6M rows) → per-trip stop list
  const tripStops = new Map();
  for await (const st of iterCsv(join(dir, 'stop_times.txt'))) {
    if (!tripInfo.has(st.trip_id)) continue;
    let arr = tripStops.get(st.trip_id);
    if (!arr) tripStops.set(st.trip_id, (arr = []));
    arr.push([Number(st.stop_sequence), st.stop_id]);
  }

  // fold identical sequences: line|dir → signature → variant
  const byLineDir = new Map();
  for (const [tripId, seq] of tripStops) {
    seq.sort((a, b) => a[0] - b[0]);
    const stops = seq.map((s) => s[1]);
    if (stops.length < 2) continue;
    const { line, dir: d, headsign } = tripInfo.get(tripId);
    const key = line + '|' + d;
    let m = byLineDir.get(key);
    if (!m) byLineDir.set(key, (m = new Map()));
    const sig = stops.join(',');
    let v = m.get(sig);
    if (!v) m.set(sig, (v = { stops, trips: 0, headsigns: new Map() }));
    v.trips++;
    v.headsigns.set(headsign, (v.headsigns.get(headsign) || 0) + 1);
  }
  tripStops.clear();

  // 4) keep the branches, drop the noise
  const linesByName = new Map();
  let variantsKept = 0, variantsSeen = 0;
  for (const [key, m] of byLineDir) {
    const bar = key.indexOf('|');
    const line = key.slice(0, bar), d = key.slice(bar + 1);
    const all = [...m.values()].sort((a, b) => b.trips - a.trips);
    variantsSeen += all.length;
    const minTrips = Math.max(cfg.variantMinTrips, all[0].trips * cfg.variantMinShare);
    const kept = all.filter((v, i) => i === 0 || v.trips >= minTrips).slice(0, cfg.variantMax);
    variantsKept += kept.length;
    let e = linesByName.get(line);
    if (!e) linesByName.set(line, (e = { line, mode: feed.mode, dirs: [] }));
    e.dirs.push({
      dir: d,
      variants: kept.map((v) => ({
        stops: v.stops, trips: v.trips,
        headsign: [...v.headsigns.entries()].sort((a, b) => b[1] - a[1])[0][0],
      })),
    });
  }
  for (const e of linesByName.values()) e.dirs.sort((a, b) => a.dir.localeCompare(b.dir));

  // 5) stops.txt → poles with the station group from stop_code ("835-03" → "835")
  const poles = new Map();
  for (const s of await readCsv(join(dir, 'stops.txt'))) {
    const name = (s.stop_name || '').replace(/\s+/g, ' ').trim();
    const code = (s.stop_code || '').trim();
    // KM Rybnik writes the complex/pole pair with a slash ("2/1"), Kraków with
    // a dash ("835-03"); the other two feeds number every pole separately, so
    // they fall through to the stop id and rely on the name merge
    const dash = Math.max(code.indexOf('-'), code.indexOf('/'));
    poles.set(s.stop_id, {
      name,
      lat: Number(s.stop_lat),
      lon: Number(s.stop_lon),
      // a feed may name its own rule (ZTM Warszawa: stop_id = 4-digit complex +
      // 2-digit pole, and stop_code is only the pole); otherwise the code's
      // dash/slash convention, else the id
      group: feed.groupOf ? feed.groupOf(s) : (dash > 0 ? code.slice(0, dash) : (code || s.stop_id)),
    });
  }

  log(`${feed.label}: ${linesByName.size} lines, ${variantsKept}/${variantsSeen} variants kept, ${poles.size} poles`);
  return { mode: feed.mode, feed, lines: [...linesByName.values()], poles };
}
