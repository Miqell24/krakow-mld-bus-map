// Poles → stations → station-level line graph → corridors.
//
// Stations: the stop_code group ("835-03" → "835") is ZTP's id of the physical
// stop complex, shared between the bus and tram feeds (Nowy Kleparz is 835 in
// both) — so pole merging is data-driven; identical-name proximity is only a
// fallback. Consecutive stations of every kept variant become graph edges; an
// edge carries the SET of lines using it (rule 7 — one geometry per shared
// segment, by construction). Degree-2 chains with an unchanged line set are
// contracted into corridors with "beads" (intermediate stops): the layout
// (Etap 2) moves corridor endpoints only, beads follow their corridor.
import { makeProj } from '../lib/geo.mjs';

const normName = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

// Kraków's cross-feed fallback compares stop names for EQUALITY, because its two
// feeds are one operator writing one way. These four operators write the same
// stop four ways — measured over the 218 pairs that stand within 60 m of each
// other across feeds:
//   KM Rybnik    "Rybnik Chwałowice Kopalnia"   town prefix, plain spaces
//   BKM Żory     "Pszczyńska - Rondo"           no town, spaced hyphen
//   county       "RYDUŁTOWY, RYNEK"             ALL CAPS, "TOWN, STREET"
//   zbiorkom     "R-k Śródmieście Dw. Kolejowy" abbreviated town
// so equality merged 118 of them and left the operators as separate networks.
// The comparison below folds case, treats commas and hyphens as separators,
// expands the abbreviations, and accepts CONTAINMENT — one side may simply be
// missing the town. The distance guard (nameMergeM) is unchanged, so proximity
// alone still never merges anything: two "Centrum Przesiadkowe" 16 km apart
// stay two places.
const ABBREV = {
  'r-k': 'rybnik', 'dw': 'dworzec', 'w-wy': 'warszawy', 'woj': 'wojewódzki',
  'os': 'osiedle', 'pl': 'plac', 'zdr': 'zdrój', 'aut': 'autobusowy',
  'ul': '', 'im': '',
};
function nameTokens(name) {
  const s = name.toLowerCase()
    .replace(/[,–—]/g, ' ')
    .replace(/(\S)-(\S)/g, '$1 $2')
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const out = [];
  for (const raw of s.split(' ')) {
    if (!/[\p{L}\p{N}]/u.test(raw)) continue; // a lone hyphen is not a word
    const t = Object.prototype.hasOwnProperty.call(ABBREV, raw) ? ABBREV[raw] : raw;
    if (t) out.push(t);
  }
  return out;
}
function namesAgree(ta, tb) {
  if (!ta.length || !tb.length) return false;
  const A = new Set(ta), B = new Set(tb);
  let common = 0;
  for (const t of A) if (B.has(t)) common++;
  const small = Math.min(A.size, B.size);
  if (common === small) return true;            // one contains the other
  return common / small >= 0.6;
}

// ---------- union-find ----------
function makeUF(n) {
  const p = new Int32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  const find = (i) => { while (p[i] !== i) { p[i] = p[p[i]]; i = p[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) p[rb] = ra; };
  return { find, union };
}

// ---------- poles → stations ----------
export function buildStations(feedData, cfg, log) {
  const poles = [];
  feedData.forEach((fd, fi) => {
    for (const [stopId, p] of fd.poles) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
      poles.push({ key: fi + ':' + stopId, fi, ...p });
    }
  });
  let latMin = 90, latMax = -90, lonMin = 180, lonMax = -180;
  for (const p of poles) {
    if (p.lat < latMin) latMin = p.lat; if (p.lat > latMax) latMax = p.lat;
    if (p.lon < lonMin) lonMin = p.lon; if (p.lon > lonMax) lonMax = p.lon;
  }
  const proj = makeProj((latMin + latMax) / 2, (lonMin + lonMax) / 2);
  for (const p of poles) [p.x, p.y] = proj.toXY(p.lat, p.lon);

  const uf = makeUF(poles.length);

  // 1) same feed + same group — distance-guarded: ZTP reuses a few group
  // numbers for two unrelated complexes (tram 798 is both "UJ / AST" and
  // "Muzeum Lotnictwa Polskiego", 4.4 km apart), so a pole joins its group
  // cluster only near an existing member
  const byFeedGroup = new Map();
  poles.forEach((p, i) => {
    const k = p.fi + ':' + p.group;
    let arr = byFeedGroup.get(k);
    if (!arr) byFeedGroup.set(k, (arr = []));
    arr.push(i);
  });
  let groupSplits = 0;
  for (const arr of byFeedGroup.values()) {
    for (let i = 1; i < arr.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = poles[arr[i]], b = poles[arr[j]];
        if (Math.hypot(a.x - b.x, a.y - b.y) < cfg.groupMergeM) { uf.union(arr[i], arr[j]); break; }
      }
    }
    if (arr.length > 1 && new Set(arr.map((i) => uf.find(i))).size > 1) groupSplits++;
  }

  // 2) same group across feeds — on the CLUSTERS left by step 1 (a reused
  // group number may hold several), centroid distance-guarded
  const centroid = (arr) => {
    let x = 0, y = 0;
    for (const i of arr) { x += poles[i].x; y += poles[i].y; }
    return [x / arr.length, y / arr.length];
  };
  const clusters = new Map(); // root → pole indices (unions so far stay inside one feed+group)
  poles.forEach((_, i) => {
    const r = uf.find(i);
    let arr = clusters.get(r);
    if (!arr) clusters.set(r, (arr = []));
    arr.push(i);
  });
  const byGroup = new Map();
  for (const [root, arr] of clusters) {
    const p = poles[arr[0]];
    const [cx, cy] = centroid(arr);
    // Kraków's two feeds share ZTP's complex numbering, so a group number means
    // the same place in both. These four operators number independently — group
    // "2" in Rybnik has nothing to do with group "2" in the county — so the key
    // is namespaced per feed and this pass never welds across operators. Cross
    // feed merging is left to the name fallback below.
    let m = byGroup.get(p.fi + ':' + p.group);
    if (!m) byGroup.set(p.fi + ':' + p.group, (m = []));
    m.push({ root, fi: p.fi, cx, cy });
  }
  let crossMerges = 0;
  for (const cl of byGroup.values()) {
    if (cl.length < 2) continue;
    for (let i = 0; i < cl.length; i++) for (let j = i + 1; j < cl.length; j++) {
      if (cl[i].fi === cl[j].fi) continue;
      if (Math.hypot(cl[i].cx - cl[j].cx, cl[i].cy - cl[j].cy) < cfg.crossFeedMergeM) { uf.union(cl[i].root, cl[j].root); crossMerges++; }
    }
  }

  // 3) fallback: the same name, written by another operator, close by
  const CELL = cfg.nameMergeM;
  const grid = new Map();
  poles.forEach((p, i) => {
    p.tok = nameTokens(p.name);
    const k = Math.floor(p.x / CELL) + '|' + Math.floor(p.y / CELL);
    let arr = grid.get(k);
    if (!arr) grid.set(k, (arr = []));
    arr.push(i);
  });
  let nameMerges = 0;
  poles.forEach((p, i) => {
    const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const j of grid.get((cx + dx) + '|' + (cy + dy)) || []) {
        if (j <= i) continue;
        const q = poles[j];
        if (q.fi === p.fi) continue; // same feed is grouped by stop_code already
        if (uf.find(i) === uf.find(j)) continue;
        if (Math.hypot(p.x - q.x, p.y - q.y) >= cfg.nameMergeM) continue;
        if (!namesAgree(p.tok, q.tok)) continue;
        uf.union(i, j);
        nameMerges++;
      }
    }
  });

  // roots → stations
  const byRoot = new Map();
  poles.forEach((p, i) => {
    const r = uf.find(i);
    let arr = byRoot.get(r);
    if (!arr) byRoot.set(r, (arr = []));
    arr.push(i);
  });
  const stations = [];
  const stationOfPole = new Map();
  for (const arr of byRoot.values()) {
    const idx = stations.length;
    let x = 0, y = 0;
    const nameCount = new Map();
    const groups = new Set(), feeds = new Set();
    for (const i of arr) {
      const p = poles[i];
      x += p.x; y += p.y;
      nameCount.set(p.name, (nameCount.get(p.name) || 0) + 1);
      groups.add(p.group); feeds.add(p.fi);
      stationOfPole.set(p.key, idx);
    }
    x /= arr.length; y /= arr.length;
    const [lon, lat] = proj.toLonLat(x, y);
    stations.push({
      idx, id: 's' + idx,
      name: [...nameCount.entries()].sort((a, b) => b[1] - a[1])[0][0],
      x, y, lon, lat, gpsX: x, gpsY: y,
      poles: arr.length, groups: [...groups], feeds: feeds.size,
    });
  }
  log(`stations: ${stations.length} from ${poles.length} poles (${crossMerges} cross-feed group merges, ` +
    `${nameMerges} name merges, ${groupSplits} reused group numbers split by distance)`);
  return { stations, stationOfPole, proj, bbox: [lonMin, latMin, lonMax, latMax] };
}

// ---------- Dijkstra over the local (short-hop) network, capped ----------
function shortestLocal(adj, from, to, cap) {
  const dist = new Map([[from, 0]]);
  const prev = new Map();
  const heap = [[0, from]];
  while (heap.length) {
    heap.sort((a, b) => a[0] - b[0]);
    const [d, u] = heap.shift();
    if (u === to) break;
    if (d > cap || d > (dist.get(u) ?? Infinity)) continue;
    for (const [w, len] of adj.get(u) || []) {
      const nd = d + len;
      if (nd > cap) continue;
      if (nd < (dist.get(w) ?? Infinity)) { dist.set(w, nd); prev.set(w, u); heap.push([nd, w]); }
    }
  }
  if (!prev.has(to) && from !== to) return null;
  const out = [to];
  while (out[0] !== from) {
    const p = prev.get(out[0]);
    if (p === undefined) return null;
    out.unshift(p);
  }
  return out;
}

// ---------- station-level line graph ----------
export function buildGraph(feedData, stationsInfo, cfg, log) {
  const { stationOfPole, stations } = stationsInfo;
  const lines = [];
  feedData.forEach((fd, fi) => {
    for (const L of fd.lines) {
      const dirs = [];
      for (const d of L.dirs) {
        // pole sequence → station sequence; variants that fold into the same
        // station path (pole-level noise: same stations, different platforms)
        // are merged and their trip counts pooled
        const bySig = new Map();
        for (const v of d.variants) {
          const path = [];
          for (const stopId of v.stops) {
            const st = stationOfPole.get(fi + ':' + stopId);
            if (st === undefined) continue;
            if (path[path.length - 1] !== st) path.push(st);
          }
          if (path.length < 2) continue;
          const sig = path.join(',');
          let e = bySig.get(sig);
          if (!e) bySig.set(sig, (e = { path, trips: 0, headsign: v.headsign }));
          e.trips += v.trips;
        }
        if (bySig.size) dirs.push({ dir: d.dir, variants: [...bySig.values()].sort((a, b) => b.trips - a.trips) });
      }
      if (dirs.length) lines.push({ id: fd.mode + ':' + L.line, mode: fd.mode, line: L.line, agency: fd.feed.label, dirs });
    }
  });

  const dist = (a, b) => Math.hypot(stations[a].x - stations[b].x, stations[a].y - stations[b].y);

  // ---------- express services: run them along the corridor, not across it ----------
  // A limited-stop line (Kraków's 7xx) records one GTFS hop over several
  // kilometres: 712 goes Tyniecka Autostrada → Zielińskiego in a single step,
  // 6.8 km, no stop between. Drawn as a direct chord that invents a link which
  // does not exist on the street — the express in fact drives the very corridor
  // that Kolna, Kostrze and Widłakowa sit on. So a long hop is spliced onto the
  // local path whenever one exists at a comparable length; only a hop with no
  // local corridor under it (open country) stays a chord.
  const localAdj = new Map();
  const addLocal = (a, b, len) => {
    for (const [x, y] of [[a, b], [b, a]]) {
      let l = localAdj.get(x);
      if (!l) localAdj.set(x, (l = []));
      if (!l.some((e) => e[0] === y)) l.push([y, len]);
    }
  };
  const used = new Set();
  for (const line of lines) for (const d of line.dirs) for (const v of d.variants) {
    for (const st of v.path) used.add(st);
    for (let i = 1; i < v.path.length; i++) {
      const L = dist(v.path[i - 1], v.path[i]);
      if (L <= cfg.expressHopM) addLocal(v.path[i - 1], v.path[i], L);
    }
  }
  // Corridors can be broken between two stops that no single line joins: 203
  // terminates at Wały Wiślane and the Kostrze corridor starts 360 m away at
  // Kostrze OSP (the printed map shows them as one complex). For deciding what
  // an express runs along, that gap is nothing — so bridge short gaps. These
  // links exist ONLY inside this search; they never become drawn edges.
  {
    const CS = cfg.expressBridgeM;
    const buckets = new Map();
    for (const st of used) {
      const k = Math.floor(stations[st].x / CS) + '|' + Math.floor(stations[st].y / CS);
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = []));
      b.push(st);
    }
    let bridges = 0;
    for (const st of used) {
      const gx = Math.floor(stations[st].x / CS), gy = Math.floor(stations[st].y / CS);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const other of buckets.get((gx + dx) + '|' + (gy + dy)) || []) {
          if (other <= st) continue;
          const L = dist(st, other);
          if (L <= CS && !(localAdj.get(st) || []).some((e) => e[0] === other)) {
            addLocal(st, other, L);
            bridges++;
          }
        }
      }
    }
    if (bridges) log(`express search: ${bridges} short gaps bridged between corridors`);
  }
  let rerouted = 0, chords = 0, inserted = 0;
  for (const line of lines) for (const d of line.dirs) for (const v of d.variants) {
    const out = [v.path[0]];
    for (let i = 1; i < v.path.length; i++) {
      const a = v.path[i - 1], b = v.path[i];
      const L = dist(a, b);
      if (L > cfg.expressHopM) {
        const via = shortestLocal(localAdj, a, b, L * cfg.expressDetourMax);
        if (via && via.length > 2) {
          for (let k = 1; k < via.length; k++) out.push(via[k]);
          rerouted++; inserted += via.length - 2;
          continue;
        }
        chords++;
      }
      out.push(b);
    }
    v.path = out;
  }
  if (rerouted) log(`express hops: ${rerouted} routed along the local corridor ` +
    `(+${inserted} pass-through stations), ${chords} kept as direct chords`);

  // edges: undirected, keyed 'min|max'; the line SET is the payload
  const edges = new Map();
  const adj = new Map(); // station idx → [edge keys]
  const stTerm = new Map(); // station idx → Set(line ids terminating here)
  for (const line of lines) for (const d of line.dirs) for (const v of d.variants) {
    const p = v.path;
    for (const endSt of [p[0], p[p.length - 1]]) {
      let s = stTerm.get(endSt);
      if (!s) stTerm.set(endSt, (s = new Set()));
      s.add(line.id);
    }
    for (let i = 1; i < p.length; i++) {
      const a = Math.min(p[i - 1], p[i]), b = Math.max(p[i - 1], p[i]);
      const key = a + '|' + b;
      let e = edges.get(key);
      if (!e) {
        edges.set(key, (e = { key, a, b, lines: new Set(), trips: 0, geoLen: dist(a, b) }));
        for (const s of [a, b]) {
          let l = adj.get(s);
          if (!l) adj.set(s, (l = []));
          l.push(key);
        }
      }
      e.lines.add(line.id);
      e.trips += v.trips;
    }
  }
  log(`graph: ${lines.length} lines, ${edges.size} edges, ${adj.size} stations in use`);
  return { lines, edges, adj, stTerm };
}

// ---------- contraction: uniform degree-2 chains → corridors with beads ----------
export function contract(graph, stations, log) {
  const { edges, adj, stTerm } = graph;
  const setKey = (e) => [...e.lines].sort().join(' ');
  const isLayoutNode = (s) => {
    const inc = adj.get(s);
    if (!inc || inc.length !== 2) return true;
    if (stTerm.has(s)) return true;
    return setKey(edges.get(inc[0])) !== setKey(edges.get(inc[1]));
  };

  const corridors = [];
  const visited = new Set();
  let loopStubs = 0;
  // A turning loop (the corridor leaves a junction and comes back: 203 runs
  // Kolna → Tor Kajakowy → Kolna Kapliczka → Kolna) is NOT drawn as a closed
  // shape — the printed KMK map shows it as a plain dead-end branch with the
  // turning point at the tip. Converting it here, rather than when drawing,
  // means the tip is an ordinary layout node: the optimiser then keeps the
  // branch clear of other corridors instead of dropping it on top of them.
  const asStub = (junction, beads, lines, geoLen) => {
    const j = stations[junction];
    const far = (i) => Math.hypot(stations[i].x - j.x, stations[i].y - j.y);
    const ordered = [...beads].sort((a, b) => far(a) - far(b));
    const tip = ordered.pop();
    // the turning point terminates those lines, so it earns a terminus badge
    let s = stTerm.get(tip);
    if (!s) stTerm.set(tip, (s = new Set()));
    for (const id of lines) s.add(id);
    loopStubs++;
    return { a: junction, b: tip, beads: ordered, lines, geoLen };
  };
  const walk = (startSt, firstKey) => {
    let prevKey = firstKey;
    let e = edges.get(firstKey);
    visited.add(firstKey);
    let cur = e.a === startSt ? e.b : e.a;
    const beads = [];
    let geoLen = e.geoLen;
    while (!isLayoutNode(cur)) {
      const [k1, k2] = adj.get(cur);
      const nextKey = k1 === prevKey ? k2 : k1;
      if (visited.has(nextKey)) break; // pure cycle guard
      beads.push(cur);
      visited.add(nextKey);
      const ne = edges.get(nextKey);
      geoLen += ne.geoLen;
      cur = ne.a === cur ? ne.b : ne.a;
      prevKey = nextKey;
    }
    const base = (cur === startSt && beads.length)
      ? asStub(startSt, beads, e.lines, geoLen)
      : { a: startSt, b: cur, beads, lines: e.lines, geoLen };
    if (cur === startSt && !beads.length) return; // degenerate: nothing to draw
    corridors.push({ id: 'c' + corridors.length, ...base });
  };

  for (const s of adj.keys()) {
    if (!isLayoutNode(s)) continue;
    for (const key of adj.get(s)) if (!visited.has(key)) walk(s, key);
  }
  // isolated cycles with no natural layout node: promote an arbitrary station
  for (const [key, e] of edges) if (!visited.has(key)) walk(e.a, key);

  const layoutNodes = new Set();
  for (const c of corridors) { layoutNodes.add(c.a); layoutNodes.add(c.b); }
  log(`contraction: ${corridors.length} corridors between ${layoutNodes.size} layout nodes ` +
    `(${stations.length - layoutNodes.size} beads, ${loopStubs} turning loops straightened into stubs)`);
  return { corridors, layoutNodes };
}
