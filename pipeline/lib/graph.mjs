// Directed road graph from an Overpass response (out geom):
// - segment = a pair of adjacent way nodes (precision needed for matching),
// - directionality from oneway / oneway:bus / junction=roundabout,
// - access: buses may use bus gates (access=no + bus/psv=yes),
// - spatial index (grid) + Dijkstra (multi-source, with a distance cap).

const HIGHWAY_OK = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
  'residential', 'living_street', 'service', 'busway', 'construction',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);

const PSV_OK = new Set(['yes', 'designated', 'permissive']);
const HARD_ONEWAY = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link']);
const PEN_NO_ACCESS = 3;   // roads with access/motor_vehicle=no|private and no bus exemption
const PEN_DRIVEWAY = 4;    // service=driveway — sometimes a mistag of a real street
                           // (e.g. the estate road at Wieliczka Kampus used by 204/224/904)
// Driving against a oneway: temporary traffic layouts at construction sites
// (Kocmyrzowska, Meissnera) run buses both ways on one carriageway while OSM keeps
// the permanent oneway. ×5 lost to a parallel side street 15 m away (the ladder
// weave on Meissnera); ×2.5 lets a consistent shape on the carriageway win against
// an alternative further than ~12 m, while still damping accidental wrong-way shortcuts.
const PEN_CONTRAFLOW = 2.5;

// Rail mode (STASY): graph built from tracks — metro tunnels (railway=subway),
// tram tracks and surface rail (parts of M1 run in a rail-tagged corridor; plain
// rail also brings the suburban railway, which is harmless — Viterbi consistency
// keeps each line on its own connected network). Depot tracks excluded.
const RAIL_OK = new Set(['subway', 'tram', 'light_rail', 'rail']);
function tramAccess(tags) {
  if (!tags || !RAIL_OK.has(tags.railway)) return null;
  const s = tags.service;
  // Crossovers are how a train changes track at a junction — excluding them
  // tore the SKM lines apart at Warszawa Zachodnia/Ochota/Wschodnia, and the
  // cross-city tunnel's platform tracks at Śródmieście are tagged siding, so
  // heavy rail keeps its sidings too. Tram sidings, yards and spurs (depot
  // tracks) stay out, as everywhere in the family.
  if (s === 'yard' || s === 'spur') return null;
  if (s === 'siding' && tags.railway !== 'rail') return null;
  return { restricted: false, driveway: false };
}

// null = way excluded; {restricted|driveway} = in the graph but with a cost penalty.
// The GTFS trace is sometimes the only evidence that KMK has right of way (e.g. the
// access=no links at Bronowicka), so hard-excluding such roads breaks the matching
// of a dozen lines.
function wayAccess(tags) {
  if (!tags || !HIGHWAY_OK.has(tags.highway)) return null;
  if (tags.area === 'yes') return null;
  const psv = PSV_OK.has(tags.psv) || PSV_OK.has(tags.bus) || tags.access === 'psv';
  let driveway = false;
  if (tags.highway === 'service' && !psv) {
    const s = tags.service;
    if (s === 'parking_aisle' || s === 'drive-through') return null;
    driveway = s === 'driveway';
  }
  if (tags.highway === 'construction') {
    // only if what is being built is a roadway (not a sidewalk/path)
    if (tags.construction && !HIGHWAY_OK.has(tags.construction)) return null;
  }
  const noAccess = tags.access === 'no' || tags.access === 'private';
  const noMotor = tags.motor_vehicle === 'no' || tags.motor_vehicle === 'private';
  return { restricted: !psv && (noAccess || noMotor), driveway };
}

function wayDirections(tags) {
  if (tags['oneway:bus'] === 'no' || tags['oneway:psv'] === 'no') return { fwd: true, bwd: true };
  const ow = tags.oneway;
  if (ow === 'yes' || ow === '1' || ow === 'true') return { fwd: true, bwd: false };
  if (ow === '-1') return { fwd: false, bwd: true };
  if (ow === 'no') return { fwd: true, bwd: true };
  if (tags.junction === 'roundabout' || tags.junction === 'circular') return { fwd: true, bwd: false };
  return { fwd: true, bwd: true };
}

export function buildGraph(elements, proj, mode = 'road') {
  const nodes = new Map();      // nodeId -> {x, y, lon, lat}
  const segs = [];              // {idx, a, b, ax..by, len, wayId, wayPos, name, roundabout, fwd, bwd}
  const out = new Map();        // nodeId -> [{to, segIdx, len}]
  const segByNodes = new Map(); // "a|b" -> segIdx (traversal a->b)
  const ways = new Map();       // wayId -> {name, roundabout, nodeIds}

  const pushOut = (n, e) => {
    let arr = out.get(n);
    if (!arr) out.set(n, (arr = []));
    arr.push(e);
  };

  for (const el of elements) {
    if (el.type !== 'way') continue;
    const acc = mode === 'tram' ? tramAccess(el.tags) : wayAccess(el.tags);
    if (!acc) continue;
    const ids = el.nodes, geo = el.geometry;
    if (!ids || !geo || ids.length !== geo.length || ids.length < 2) continue;
    const { fwd, bwd } = wayDirections(el.tags);
    const rb = mode !== 'tram' && (el.tags.junction === 'roundabout' || el.tags.junction === 'circular');
    // never wrong-way on roundabouts and expressways; elsewhere allowed with a penalty
    const hard = rb || HARD_ONEWAY.has(el.tags.highway);
    const base = acc.driveway ? PEN_DRIVEWAY : (acc.restricted ? PEN_NO_ACCESS : 1);
    const fwdPen = fwd ? base : (hard ? Infinity : base * PEN_CONTRAFLOW);
    const bwdPen = bwd ? base : (hard ? Infinity : base * PEN_CONTRAFLOW);
    const name = el.tags.name || el.tags.ref || '';
    ways.set(el.id, { name, roundabout: rb, nodeIds: ids });

    for (let i = 0; i < ids.length; i++) {
      if (!nodes.has(ids[i]) && geo[i]) {
        const [x, y] = proj.toXY(geo[i].lat, geo[i].lon);
        nodes.set(ids[i], { x, y, lon: geo[i].lon, lat: geo[i].lat });
      }
    }
    for (let i = 0; i + 1 < ids.length; i++) {
      const a = ids[i], b = ids[i + 1];
      if (a === b) continue;
      const na = nodes.get(a), nb = nodes.get(b);
      if (!na || !nb) continue;
      const len = Math.hypot(nb.x - na.x, nb.y - na.y);
      if (len === 0) continue;
      const idx = segs.length;
      segs.push({
        idx, a, b, ax: na.x, ay: na.y, bx: nb.x, by: nb.y, len,
        wayId: el.id, wayPos: i, name, roundabout: rb, fwdPen, bwdPen, pen: base,
      });
      // edge cost = length × penalty (geometry stays true)
      if (isFinite(fwdPen)) { pushOut(a, { to: b, segIdx: idx, len: len * fwdPen }); segByNodes.set(a + '|' + b, idx); }
      if (isFinite(bwdPen)) { pushOut(b, { to: a, segIdx: idx, len: len * bwdPen }); segByNodes.set(b + '|' + a, idx); }
    }
  }

  const CELL = 120;
  const grid = new Map();
  for (const s of segs) {
    const x0 = Math.floor(Math.min(s.ax, s.bx) / CELL), x1 = Math.floor(Math.max(s.ax, s.bx) / CELL);
    const y0 = Math.floor(Math.min(s.ay, s.by) / CELL), y1 = Math.floor(Math.max(s.ay, s.by) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = cx + ',' + cy;
        let arr = grid.get(k);
        if (!arr) grid.set(k, (arr = []));
        arr.push(s.idx);
      }
    }
  }

  return { nodes, segs, out, segByNodes, grid, CELL, ways };
}

// Candidates: projections of point (x,y) onto segments within `radius`, up to `maxN`
// nearest. `perWay` caps candidates per OSM way: at interchange stations the dense
// trackage of one line (many short station segments) can fill every slot before a
// parallel line's tunnel appears at all (M1 vs M3 at Monastiraki) — diversity, not
// a bigger N, is what fixes that.
export function candidates(graph, x, y, radius, maxN, perWay = Infinity) {
  const { grid, CELL, segs } = graph;
  const r2 = radius * radius;
  const seen = new Set();
  const res = [];
  const cx0 = Math.floor((x - radius) / CELL), cx1 = Math.floor((x + radius) / CELL);
  const cy0 = Math.floor((y - radius) / CELL), cy1 = Math.floor((y + radius) / CELL);
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cy = cy0; cy <= cy1; cy++) {
      const arr = grid.get(cx + ',' + cy);
      if (!arr) continue;
      for (const i of arr) {
        if (seen.has(i)) continue;
        seen.add(i);
        const s = segs[i];
        const dx = s.bx - s.ax, dy = s.by - s.ay;
        let t = ((x - s.ax) * dx + (y - s.ay) * dy) / (s.len * s.len);
        t = Math.max(0, Math.min(1, t));
        const px = s.ax + t * dx, py = s.ay + t * dy;
        const d2 = (x - px) * (x - px) + (y - py) * (y - py);
        if (d2 <= r2) {
          const dist = Math.sqrt(d2);
          // penalty-aware ranking: at similar distances a regular roadway beats
          // a driveway/restricted one — otherwise a thicket of access roads (e.g.
          // the hospital grounds in Kobierzyn on route 151) crowds out the real road
          res.push({ segIdx: i, t, x: px, y: py, dist, rank: dist + (s.pen - 1) * 4 });
        }
      }
    }
  }
  res.sort((p, q) => p.rank - q.rank);
  if (perWay === Infinity) return res.slice(0, maxN);
  const perWayCnt = new Map();
  const picked = [];
  for (const c of res) {
    const w = segs[c.segIdx].wayId;
    const n = perWayCnt.get(w) || 0;
    if (n >= perWay) continue;
    perWayCnt.set(w, n + 1);
    picked.push(c);
    if (picked.length >= maxN) break;
  }
  return picked;
}

class MinHeap {
  constructor() { this.a = []; }
  push(d, n) {
    const a = this.a;
    a.push([d, n]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    if (a.length === 0) return null;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

// Multi-source Dijkstra: sources = Map(nodeId -> starting cost).
// Stops after reaching all targets or exceeding maxDist.
// Returns {dist: Map, prev: Map} (prev has no entries for start nodes).
// noPen: route on RAW meters, ignoring the soft contraflow multiplier (hard
// oneways stay closed — their edges are absent from the adjacency). Used when
// bridging GTFS shape gaps: there the objective is geometry that follows the
// corridor, and a 2.5× contraflow surcharge otherwise beats real distance and
// sends the bridge around the block (X499 at El Kafr: the Nahia Axis
// eastbound carriageway is unmapped there).
// `raw` in the result: REAL meters along each node's min-COST path. The HMM
// scores transitions on raw meters — the contraflow surcharge picks between
// comparable paths but must not read as fake distance: scored as distance it
// compounds along a oneway corridor until a genuine 500 m detour looks
// cheaper than the straight street the shape actually follows.
// sources: Map node → cost (raw defaults to cost) or node → { cost, raw }.
export function dijkstra(graph, sources, targets, maxDist, noPen = false) {
  const dist = new Map();
  const raw = new Map();
  const prev = new Map();
  const heap = new MinHeap();
  for (const [n, v] of sources) {
    const c = typeof v === 'number' ? v : v.cost;
    if (c <= maxDist && (dist.get(n) ?? Infinity) > c) {
      dist.set(n, c);
      raw.set(n, typeof v === 'number' ? v : v.raw);
      heap.push(c, n);
    }
  }
  const remaining = new Set();
  for (const t of targets) if (!dist.has(t)) remaining.add(t);
  while (heap.size) {
    const [d, n] = heap.pop();
    if (d !== dist.get(n)) continue;
    if (remaining.delete(n) && remaining.size === 0) break;
    if (d > maxDist) break;
    const edges = graph.out.get(n);
    if (!edges) continue;
    for (const e of edges) {
      const rawLen = graph.segs[e.segIdx].len;
      const nd = d + (noPen ? rawLen : e.len);
      if (nd > maxDist) continue;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        raw.set(e.to, raw.get(n) + rawLen);
        prev.set(e.to, n);
        heap.push(nd, e.to);
      }
    }
  }
  return { dist, raw, prev };
}

// Reconstructs the node path from a source (a node absent from prev) to `to`.
export function pathTo(prev, to) {
  const path = [to];
  let cur = to;
  while (prev.has(cur)) {
    cur = prev.get(cur);
    path.push(cur);
  }
  path.reverse();
  return path;
}
