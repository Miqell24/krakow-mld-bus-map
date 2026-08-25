// Report of gaps in the GTFS feed's shapes.txt — for manual verification
// and reporting to the publisher. A gap = a pair of adjacent shape points more than
// THRESHOLD meters apart (the trace jumps in a straight line instead of following the
// roadway). ALL shapes used by trips are analyzed, results grouped by location.
// Usage: node pipeline/report-gaps.mjs [threshold_m]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { iterCsv, readCsv } from './lib/csv.mjs';
import { makeProj } from './lib/geo.mjs';
import { areaName, modeLabel, pipelineName, publisherName } from './lib/identity.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GTFS = join(ROOT, 'data/gtfs');
const THRESHOLD = Number(process.argv[2]) || 200;
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

// ---------- feed_info + routes + trips ----------
const feedInfoPath = join(GTFS, 'feed_info.txt');
const feedInfo = existsSync(feedInfoPath) ? ((await readCsv(feedInfoPath))[0] || {}) : {};
const routes = await readCsv(join(GTFS, 'routes.txt'));
const routeToLine = new Map(routes.map((r) => [r.route_id, r.route_short_name]));
const routeToType = new Map(routes.map((r) => [r.route_id, r.route_type]));
const shapeLines = new Map(); // shape_id -> Set(line)
const routeTypes = new Set(); // route_type of every route whose shapes are reported on
for await (const t of iterCsv(join(GTFS, 'trips.txt'))) {
  const L = routeToLine.get(t.route_id);
  if (!L || !t.shape_id) continue;
  routeTypes.add(routeToType.get(t.route_id));
  let s = shapeLines.get(t.shape_id);
  if (!s) shapeLines.set(t.shape_id, (s = new Set()));
  s.add(L);
}
log(`shapes in use: ${shapeLines.size}`);

// ---------- shapes.txt: gap detection ----------
const pts = new Map();
for await (const s of iterCsv(join(GTFS, 'shapes.txt'))) {
  if (!shapeLines.has(s.shape_id)) continue;
  let a = pts.get(s.shape_id);
  if (!a) pts.set(s.shape_id, (a = []));
  a.push([Number(s.shape_pt_sequence), Number(s.shape_pt_lat), Number(s.shape_pt_lon)]);
}
// Local projection derived from the feed itself, not a hardcoded city center: the
// kx = cos(lat0) factor scales every east-west distance, so a wrong origin applies
// the THRESHOLD above and the cluster radius below at the wrong scale. Centroid
// rather than build.mjs' bbox center — a handful of far-flung shapes (national
// feeds carry them) drags a bbox center off the network, a centroid barely moves.
let latSum = 0, lonSum = 0, nPts = 0;
for (const arr of pts.values()) for (const [, lat, lon] of arr) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  latSum += lat; lonSum += lon; nPts++;
}
const proj = makeProj(latSum / nPts, lonSum / nPts);
const gaps = []; // {lat, lon, x, y, len, shapeId, lines}
for (const [sid, arr] of pts) {
  arr.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < arr.length; i++) {
    const [, la1, lo1] = arr[i - 1];
    const [, la2, lo2] = arr[i];
    const [x1, y1] = proj.toXY(la1, lo1);
    const [x2, y2] = proj.toXY(la2, lo2);
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len > THRESHOLD) {
      const lat = (la1 + la2) / 2, lon = (lo1 + lo2) / 2;
      const [x, y] = proj.toXY(lat, lon);
      gaps.push({ lat, lon, x, y, len, shapeId: sid, lines: shapeLines.get(sid) });
    }
  }
}
log(`gaps > ${THRESHOLD} m (across all variants): ${gaps.length}`);

// ---------- grouping by location (gap midpoint, 250 m radius) ----------
const clusters = [];
for (const g of gaps.sort((a, b) => b.len - a.len)) {
  let c = clusters.find((c) => Math.hypot(c.x - g.x, c.y - g.y) < 250);
  if (!c) clusters.push((c = { x: g.x, y: g.y, lat: g.lat, lon: g.lon, maxLen: 0, lines: new Set(), shapes: new Set(), n: 0 }));
  c.maxLen = Math.max(c.maxLen, g.len);
  for (const L of g.lines) c.lines.add(L);
  c.shapes.add(g.shapeId);
  c.n++;
}
log(`locations after grouping: ${clusters.length}`);

// ---------- nearest named OSM street (approximate) ----------
log('Indexing named OSM streets…');
const osm = JSON.parse(readFileSync(join(ROOT, 'data/osm/krakow.json'), 'utf8'));
const CELL = 250;
const nameGrid = new Map();
for (const el of osm.elements) {
  if (el.type !== 'way' || !el.tags || !el.tags.name || !el.tags.highway || !el.geometry) continue;
  for (let i = 0; i < el.geometry.length; i += 3) {
    const g = el.geometry[i];
    const [x, y] = proj.toXY(g.lat, g.lon);
    const k = Math.floor(x / CELL) + ',' + Math.floor(y / CELL);
    let arr = nameGrid.get(k);
    if (!arr) nameGrid.set(k, (arr = []));
    arr.push([x, y, el.tags.name]);
  }
}
function nearestName(x, y) {
  let best = null, bestD = 400;
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
    const arr = nameGrid.get((cx + dx) + ',' + (cy + dy));
    if (!arr) continue;
    for (const [px, py, name] of arr) {
      const d = Math.hypot(px - x, py - y);
      if (d < bestD) { bestD = d; best = name; }
    }
  }
  return best;
}

// ---------- Markdown report ----------
const numSort = (a, b) => (Number(a) - Number(b)) || a.localeCompare(b);
clusters.sort((a, b) => b.maxLen - a.maxLen);
const rows = clusters.map((c, i) => {
  const vicinity = nearestName(c.x, c.y) || '—';
  const lines = [...c.lines].sort(numSort).join(', ');
  const pos = `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`;
  const osmLink = `https://www.openstreetmap.org/?mlat=${c.lat.toFixed(5)}&mlon=${c.lon.toFixed(5)}#map=17/${c.lat.toFixed(5)}/${c.lon.toFixed(5)}`;
  const gLink = `https://www.google.com/maps?q=${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
  return `| ${i + 1} | ${Math.round(c.maxLen)} | ${vicinity} | ${lines} | ${c.shapes.size} | ${pos} [OSM](${osmLink}) · [Google](${gLink}) |`;
});

const lineCount = new Set(clusters.flatMap((c) => [...c.lines])).size;
// Who this report is about — derived from the project and the feed (lib/identity.mjs)
// rather than written down here: this pipeline is cloned city to city, and a name typed
// into the template below travels with the clone and mislabels its report.
const AREA = areaName(ROOT);
const MODE = modeLabel(routeTypes);
const PUBLISHER = await publisherName(GTFS, feedInfo);

const md = `# Gap report for shapes.txt — ${AREA} ${MODE} GTFS

- **Feed:** ${PUBLISHER}, version \`${feedInfo.feed_version || '?'}\` (valid ${feedInfo.feed_start_date || '?'}–${feedInfo.feed_end_date || '?'}), contact: ${feedInfo.feed_contact_email || '—'}
- **Generated:** ${new Date().toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })} by the \`${pipelineName(ROOT)}\` pipeline
- **Gap definition:** a pair of adjacent \`shapes.txt\` points more than ${THRESHOLD} m apart in a straight line — the trace "jumps" instead of following the roadway (the GTFS spec requires shapes to trace the actual travel path).
- **Scope:** all ${pts.size} shapes used by trips in the feed.

## Summary

| | |
|---|---|
| gaps > ${THRESHOLD} m in total (across all route variants) | **${gaps.length}** |
| unique locations after grouping (250 m radius) | **${clusters.length}** |
| lines affected | **${lineCount}** |
| longest gap | **${Math.round(clusters[0]?.maxLen || 0)} m** |

Gaps cluster where infrastructure changed (construction sites, detours, new roads,
loops on closed premises) — this looks like holes in the geometric base layer of the
system that generates shapes, replicated into every run through a given corridor.

## Locations (longest gap first)

"Vicinity" is the nearest named OpenStreetMap street (approximate). "Variants" — the
number of shapes with a gap at this location. Links open the spot for manual checking.

| # | max [m] | vicinity | lines | variants | position |
|---|---|---|---|---|---|
${rows.join('\n')}

## Methodology

Computed on raw \`shapes.txt\` (no map matching): for every shape the distances
between consecutive points (\`shape_pt_sequence\`) were measured in a local metric
projection; pairs above the ${THRESHOLD} m threshold were grouped spatially by gap
midpoint. Script: \`pipeline/report-gaps.mjs\` (\`npm run report\`), regenerate
after every feed update.
`;

writeFileSync(join(ROOT, 'data/gtfs-gaps-report.md'), md);
log(`Wrote data/gtfs-gaps-report.md (${clusters.length} locations)`);
