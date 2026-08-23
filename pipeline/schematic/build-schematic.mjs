// Schematic mode entry — npm run schematic [-- --debug --iters=80 --w4=8].
// Parallel branch of the pipeline: consumes the same GTFS as build.mjs but
// computes a transit-diagram layout instead of map-matching onto OSM. Never
// touches the geographic outputs; writes to data/out/schematic/.
//
// Etap 1 (current stage): station graph at GEOGRAPHIC positions — the identity
// layout. The /schematic/ page renders it so the topology (stations, corridors,
// branches, shared segments) can be inspected before any octilinear
// optimisation is switched on.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CONFIG, applyCliOverrides } from './config.mjs';
import { readFeed } from './network.mjs';
import { buildStations, buildGraph, contract } from './condense.mjs';
import { scoreStations } from './score.mjs';
import { runLayout } from './layout.mjs';
import { loadRiverGeo } from './river.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'data/out/schematic');
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const numSort = (a, b) => (Number(a) - Number(b)) || a.localeCompare(b);
const round6 = (v) => Math.round(v * 1e6) / 1e6;

const cfg = applyCliOverrides(CONFIG, process.argv.slice(2));

// ---------- intake ----------
const feedData = [];
for (const feed of cfg.feeds) feedData.push(await readFeed(ROOT, feed, cfg, log));

// ---------- stations, graph, corridors, scores ----------
const stationsInfo = buildStations(feedData, cfg, log);
const { stations, proj } = stationsInfo;
const graph = buildGraph(feedData, stationsInfo, cfg, log);
const contracted = contract(graph, stations, log);
const scored = scoreStations(stations, graph, contracted, cfg);
log(`major nodes (${scored.nMajor}): ${scored.top.join(', ')}`);

// ---------- positions ----------
// Default (and --graph mode): schematic position = geographic position.
// Layout mode: corridor endpoints from the octilinear search, beads spread
// evenly along their corridor's path — downstream reads sx/sy + corridor paths.
for (const st of stations) { st.sx = st.gpsX; st.sy = st.gpsY; }
let corridorCoords = null; // corridor id → [[mx,my],…] (bend-aware polylines)
let layoutStats = null;
let layoutScale = null; // m per grid unit — the diagram's own scale
let layoutCx = null, layoutCy = null; // origin of the grid, in projected meters
// the Vistula enters as a CONSTRAINT, before the layout runs — not as a band
// warped onto the finished diagram
const riverGeo = (cfg.graph || cfg.river === false) ? null : loadRiverGeo(
  join(ROOT, 'data/osm/wisla.json'), join(ROOT, 'data/osm/bridges.json'),
  stations, proj, cfg, log);

let layoutRiver = null;
if (!cfg.graph) {
  const res = runLayout(stations, contracted, graph, cfg, log, riverGeo);
  layoutRiver = res.river;
  // cfg.spread inflates the finished drawing around the grid origin: the
  // layout's own scale keeps the sheet the same size whatever the length
  // targets, so this is THE lever for more room between stops at a given zoom
  const SPREAD = cfg.spread || 1;
  const toM = (p) => [res.cx + p[0] * res.s * SPREAD, res.cy + p[1] * res.s * SPREAD];
  for (const [v, p] of res.pos) {
    const [mx, my] = toM(p);
    stations[v].sx = mx; stations[v].sy = my;
  }
  corridorCoords = new Map();
  for (const c of res.corr) {
    const raw = res.paths.get(c.i);
    if (!raw) continue; // beadless turning loop — nothing to draw
    const path = raw.map(toM);
    corridorCoords.set(c.id, path);
    if (!c.beads.length) continue;
    const segLens = [];
    let L = 0;
    for (let i = 1; i < path.length; i++) {
      const l = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
      segLens.push(l); L += l;
    }
    c.beads.forEach((bIdx, bi) => {
      let target = L * (bi + 1) / (c.beads.length + 1);
      let i = 0;
      while (i < segLens.length - 1 && target > segLens[i]) { target -= segLens[i]; i++; }
      const t = segLens[i] ? target / segLens[i] : 0;
      stations[bIdx].sx = path[i][0] + (path[i + 1][0] - path[i][0]) * t;
      stations[bIdx].sy = path[i][1] + (path[i + 1][1] - path[i][1]) * t;
    });
  }
  layoutStats = res.stats;
  layoutScale = res.s * SPREAD;
  layoutCx = res.cx; layoutCy = res.cy;
}

// ---------- emit ----------
mkdirSync(OUT, { recursive: true });
const fc = (features) => ({ type: 'FeatureCollection', features });
const write = (name, data) => {
  writeFileSync(join(OUT, name), JSON.stringify(data));
  log(`wrote ${name}${data.features ? ` (${data.features.length} features)` : ''}`);
};
const ll = (st) => {
  const [lon, lat] = proj.toLonLat(st.sx, st.sy);
  return [round6(lon), round6(lat)];
};
// Colour rule: a corridor takes the colour of the OPERATOR running it, and a
// corridor that several operators share gets its own colour. The brief allows
// the organiser to be told apart by colour but never to shape the geometry —
// so this is applied at emit time, on top of a layout that never saw it.
const agencyOfLine = new Map(graph.lines.map((l) => [l.id, l.agency]));
const corridorOp = (c) => {
  const ops = new Set();
  for (const id of c.lines) {
    const a = agencyOfLine.get(id);
    if (a) ops.add(a);
  }
  if (ops.size === 0) return 'other';
  if (ops.size > 1) return 'mix';
  return [...ops][0];
};

const modeLines = (c, mode) => {
  const pre = mode + ':';
  return [...c.lines].filter((id) => id.startsWith(pre)).map((id) => id.slice(pre.length)).sort(numSort);
};

// corridors → bus strokes + tram strokes. One geometry per shared segment
// (rule 7); like the printed KMK map, trams are ONE family-red stroke with the
// set of lines — never separated per line (user decision, 7.08).
const netFeatures = [], tramFeatures = [];
const llM = ([mx, my]) => {
  const [lon, lat] = proj.toLonLat(mx, my);
  return [round6(lon), round6(lat)];
};
for (const c of contracted.corridors) {
  // layout mode draws the corridor's bend-aware path; --graph mode chains stations
  const path = corridorCoords && corridorCoords.get(c.id);
  if (corridorCoords && !path) continue; // dropped beadless turning loop
  const coords = path ? path.map(llM) : [c.a, ...c.beads, c.b].map((i) => ll(stations[i]));
  if (coords.length < 2) continue;
  const bus = modeLines(c, 'bus');
  const tram = modeLines(c, 'tram');
  if (bus.length) netFeatures.push({
    type: 'Feature',
    properties: { id: c.id, lines: bus.join(' '), n: bus.length, tram: tram.length ? 1 : 0, op: corridorOp(c) },
    geometry: { type: 'LineString', coordinates: coords },
  });
  if (tram.length) tramFeatures.push({
    type: 'Feature',
    properties: { id: c.id, lines: tram.join(' '), n: tram.length, bus: bus.length ? 1 : 0 },
    geometry: { type: 'LineString', coordinates: coords },
  });
}

const stopFeatures = [], debugFeatures = [];
for (const st of stations) {
  if (!st.degree) continue; // pole groups no kept variant passes through
  const sch = ll(st);
  const gps = [round6(st.lon), round6(st.lat)];
  stopFeatures.push({
    type: 'Feature',
    properties: {
      id: st.id, name: st.name,
      bus: st.modes.includes('bus') ? 1 : 0, tram: st.modes.includes('tram') ? 1 : 0,
      n: st.nLines, imp: st.impN, node: st.isNode ? 1 : 0, deg: st.degree,
      term: st.termLines.length ? 1 : 0, major: st.major || 0,
    },
    geometry: { type: 'Point', coordinates: sch },
  });
  const d = Math.round(Math.hypot(st.sx - st.gpsX, st.sy - st.gpsY));
  debugFeatures.push(
    { type: 'Feature', properties: { t: 'vec', sid: st.id, d }, geometry: { type: 'LineString', coordinates: [gps, sch] } },
    { type: 'Feature', properties: { t: 'gps', sid: st.id }, geometry: { type: 'Point', coordinates: gps } },
    { type: 'Feature', properties: { t: 'sch', sid: st.id, name: st.name, imp: st.impN, d }, geometry: { type: 'Point', coordinates: sch } },
  );
}

// bbox of the schematic positions
let W = 180, S = 90, E = -180, N = -90;
for (const f of stopFeatures) {
  const [x, y] = f.geometry.coordinates;
  if (x < W) W = x; if (x > E) E = x;
  if (y < S) S = y; if (y > N) N = y;
}

// ---------- line numbers along the corridors (KMK-style, mode-colored) ----------
// One label per corridor, laid along the stroke; identical line sets repeating
// within a short distance are dropped so long corridors don't stutter.
const numberFeatures = [];
{
  const placed = []; // {x,y,text}
  const MIN_APART = (layoutScale || 300) * 2.2;
  const cand = [];
  for (const c of contracted.corridors) {
    const path = corridorCoords && corridorCoords.get(c.id);
    if (corridorCoords && !path) continue;
    const pts = path || [c.a, ...c.beads, c.b].map((i) => [stations[i].sx, stations[i].sy]);
    if (pts.length < 2) continue;
    // anchor at the middle of the corridor's longest straight leg
    let bi = 0, bl = -1;
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (l > bl) { bl = l; bi = i; }
    }
    if (bl < (layoutScale || 300) * 0.8) continue; // too short to carry a label
    const [x0, y0] = pts[bi - 1], [x1, y1] = pts[bi];
    let ang = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI;
    if (ang > 90) ang -= 180; else if (ang < -90) ang += 180; // never upside down
    for (const mode of ['bus', 'tram']) {
      const lines = modeLines(c, mode);
      if (!lines.length) continue;
      cand.push({
        x: (x0 + x1) / 2, y: (y0 + y1) / 2, len: bl, mode, op: corridorOp(c),
        text: lines.join(' '), n: lines.length,
        // MapLibre reserves the box of the ROTATED label, so wrap wide sets
        angle: -Math.round(ang * 10) / 10,
      });
    }
  }
  cand.sort((a, b) => b.len - a.len); // long corridors claim their label first
  for (const c of cand) {
    const dup = placed.some((p) => p.text === c.text && p.mode === c.mode &&
      Math.hypot(p.x - c.x, p.y - c.y) < MIN_APART);
    if (dup) continue;
    placed.push(c);
    numberFeatures.push({
      type: 'Feature',
      properties: {
        text: c.text, n: c.n, mode: c.mode, angle: c.angle, op: c.op,
      },
      geometry: { type: 'Point', coordinates: llM([c.x, c.y]) },
    });
  }
}

// ---------- terminus badges: which lines END here (rule 13) ----------
const terminalFeatures = [];
for (const st of stations) {
  if (!st.termLines.length) continue;
  for (const mode of ['bus', 'tram']) {
    const pre = mode + ':';
    const lines = st.termLines.filter((id) => id.startsWith(pre))
      .map((id) => id.slice(pre.length)).sort(numSort);
    if (!lines.length) continue;
    terminalFeatures.push({
      type: 'Feature',
      properties: {
        name: st.name, mode, text: lines.join(' '), n: lines.length,
        // a terminus that is also a through-stop for other lines is not a tip
        tip: st.degree <= 1 ? 1 : 0,
      },
      geometry: { type: 'Point', coordinates: ll(st) },
    });
  }
}

// ---------- Wisła + mosty, prosto z layoutu ----------
// The control points come out of the joint optimisation; here they are only
// converted to meters and relinked with 0/45/90° segments, exactly like the
// transport corridors, so the band reads as part of the same drawing.
const riverFeatures = [], bridgeFeatures = [];
if (layoutRiver && layoutCx !== null) {
  const toM = (p) => [layoutCx + p[0] * layoutScale, layoutCy + p[1] * layoutScale];
  const octi = (a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (dx === 0 || dy === 0 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-9) return [b];
    const d = Math.min(Math.abs(dx), Math.abs(dy));
    const sx = Math.sign(dx), sy = Math.sign(dy);
    return [[a[0] + sx * d, a[1] + sy * d], b];
  };
  const pts = layoutRiver.pos.map(toM);
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1], b = pts[i];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    for (const p of octi(a, b)) out.push(p);
  }
  if (out.length > 1) riverFeatures.push({
    type: 'Feature', properties: { name: 'Wisła' },
    geometry: { type: 'LineString', coordinates: out.map(llM) },
  });
  layoutRiver.pos.forEach((p, i) => {
    if (!layoutRiver.isBridge[i]) return;
    const name = layoutRiver.names[layoutRiver.bridgeOf[i]] || 'most';
    bridgeFeatures.push({
      type: 'Feature',
      properties: { name, rail: /kolejow/i.test(name) ? 1 : 0 },
      geometry: { type: 'Point', coordinates: llM(toM(p)) },
    });
  });
}

write('network.geojson', fc(netFeatures));
write('tram.geojson', fc(tramFeatures));
write('stops.geojson', fc(stopFeatures));
write('debug.geojson', fc(debugFeatures));
write('numbers.geojson', fc(numberFeatures));
write('terminals.geojson', fc(terminalFeatures));
write('river.geojson', fc(riverFeatures));
write('bridges.geojson', fc(bridgeFeatures));

const busLineCount = graph.lines.filter((l) => l.mode === 'bus').length;
const tramLineCount = graph.lines.filter((l) => l.mode === 'tram').length;
write('meta.json', {
  generatedAt: new Date().toISOString(),
  stage: cfg.graph ? 'graph' : 'layout',
  layout: layoutStats,
  bbox: [W, S, E, N],
  counts: {
    stations: stopFeatures.length,
    layoutNodes: contracted.layoutNodes.size,
    corridors: contracted.corridors.length,
    busLines: busLineCount,
    tramLines: tramLineCount,
  },
  modes: cfg.feeds.map((f) => ({ mode: f.mode, label: f.label, color: f.color })),
  weights: cfg.weights,
});
log(`done — ${busLineCount} bus + ${tramLineCount} tram lines, stage "${cfg.graph ? 'graph' : 'layout'}"`);
