// HMM/Viterbi map matching (Newson–Krumm 2009) on a directed road graph.
// Observations = GTFS polyline points; states = projections onto nearby segments;
// emission = Gaussian distance penalty; transition = penalty for |route − straight line|.
// The result follows OSM nodes, so roundabouts and intersections get true geometry.
import { candidates, dijkstra, pathTo } from './graph.mjs';

function emission(d, sigma) { return -0.5 * (d / sigma) * (d / sigma); }

// noPen (all four helpers below): soft contraflow multipliers drop to 1 —
// raw meters only. Hard oneways (infinite pen) stay impossible. Switched on
// for GTFS shape-gap legs, where the bridge must follow the corridor and a
// contraflow surcharge otherwise loses to a longer around-the-block detour.
// Each entry/exit carries `raw` (real meters) beside the penalized `cost`:
// paths are CHOSEN by cost but SCORED by raw meters — a surcharge read as
// distance compounds along oneway corridors until a genuine block-circling
// detour outranks the straight street the shape drives (X499 rectangle).
function exits(graph, c, noPen) {
  const s = graph.segs[c.segIdx];
  const list = [];
  if (isFinite(s.fwdPen)) list.push({ node: s.b, raw: (1 - c.t) * s.len, cost: (1 - c.t) * s.len * (noPen ? 1 : s.fwdPen) });
  if (isFinite(s.bwdPen)) list.push({ node: s.a, raw: c.t * s.len, cost: c.t * s.len * (noPen ? 1 : s.bwdPen) });
  return list;
}

function entries(graph, c, noPen) {
  const s = graph.segs[c.segIdx];
  const list = [];
  if (isFinite(s.fwdPen)) list.push({ node: s.a, raw: c.t * s.len, cost: c.t * s.len * (noPen ? 1 : s.fwdPen) });
  if (isFinite(s.bwdPen)) list.push({ node: s.b, raw: (1 - c.t) * s.len, cost: (1 - c.t) * s.len * (noPen ? 1 : s.bwdPen) });
  return list;
}

// Travel along a shared segment; cost includes directional penalties (null =
// impossible), raw is the real meters of the same move.
function sameSegDist(graph, a, b, noPen) {
  if (a.segIdx !== b.segIdx) return null;
  const s = graph.segs[a.segIdx];
  let best = null;
  if (isFinite(s.fwdPen) && b.t >= a.t) {
    best = { cost: (b.t - a.t) * s.len * (noPen ? 1 : s.fwdPen), raw: (b.t - a.t) * s.len };
  }
  if (isFinite(s.bwdPen) && b.t <= a.t) {
    const cost = (a.t - b.t) * s.len * (noPen ? 1 : s.bwdPen);
    if (best === null || cost < best.cost) best = { cost, raw: (a.t - b.t) * s.len };
  }
  return best;
}

// Per B-candidate: { cost, raw } of the min-cost connection, or null.
function routeDistances(graph, a, candsB, cap, noPen) {
  const sources = new Map();
  for (const e of exits(graph, a, noPen)) {
    const cur = sources.get(e.node);
    if (cur === undefined || e.cost < cur.cost) sources.set(e.node, { cost: e.cost, raw: e.raw });
  }
  const entryLists = candsB.map((c) => entries(graph, c, noPen));
  const targets = new Set();
  for (const list of entryLists) for (const e of list) targets.add(e.node);
  const { dist, raw } = dijkstra(graph, sources, targets, cap, noPen);
  return candsB.map((b, k) => {
    let best = sameSegDist(graph, a, b, noPen);
    for (const e of entryLists[k]) {
      const d = dist.get(e.node);
      if (d !== undefined) {
        const cost = d + e.cost;
        if (best === null || cost < best.cost) best = { cost, raw: raw.get(e.node) + e.raw };
      }
    }
    return best;
  });
}

// Geometry of the a→b connection (without the start point). Returns {d, coords, nodesPath|null}.
function connectPair(graph, a, b, cap, noPen) {
  const ss = sameSegDist(graph, a, b, noPen);
  const sources = new Map();
  for (const e of exits(graph, a, noPen)) {
    const cur = sources.get(e.node);
    if (cur === undefined || e.cost < cur) sources.set(e.node, e.cost);
  }
  const entryList = entries(graph, b, noPen);
  const targets = new Set(entryList.map((e) => e.node));
  const { dist, prev } = dijkstra(graph, sources, targets, cap, noPen);
  let best = null;
  for (const e of entryList) {
    const d = dist.get(e.node);
    if (d !== undefined) {
      const total = d + e.cost;
      if (!best || total < best.total) best = { total, node: e.node };
    }
  }
  if (ss !== null && (best === null || ss.cost <= best.total)) {
    return { d: ss.cost, coords: [[b.x, b.y]], nodesPath: null };
  }
  if (best === null) return null;
  const nodesPath = pathTo(prev, best.node);
  const coords = [];
  for (const n of nodesPath) {
    const nd = graph.nodes.get(n);
    coords.push([nd.x, nd.y]);
  }
  coords.push([b.x, b.y]);
  return { d: best.total, coords, nodesPath };
}

function argmax(arr) {
  let bi = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] > arr[bi]) bi = i;
  return bi;
}

function appendCoords(coords, extra) {
  for (const p of extra) {
    const last = coords[coords.length - 1];
    if (Math.abs(last[0] - p[0]) > 0.01 || Math.abs(last[1] - p[1]) > 0.01) coords.push(p);
  }
}

// pts: [[x,y], ...] (resampled GTFS polyline in local coordinates).
// Points with no roadway within ~70 m stay unassigned — if GTFS drives a road that
// is missing from OSM (new infrastructure), it is better to draw the raw trace than
// to pull the route onto random nearby streets (see the fallback in reconstruction).
export function matchShape(graph, pts, opts = {}) {
  const sigma = opts.sigma ?? 8;
  const beta = opts.beta ?? 32;
  const radii = opts.radii ?? [45, 70];
  const maxCand = opts.maxCand ?? 12;
  const perWay = opts.perWay ?? Infinity;
  // legs longer than this are GTFS shape gaps: bridge them on raw meters
  // (noPen) so the bridge hugs the corridor instead of dodging soft oneways
  const gapMin = opts.gapMin ?? Infinity;

  const obs = [];
  let skipped = 0;
  pts.forEach((p, idx) => {
    let cand = [];
    for (const r of radii) {
      cand = candidates(graph, p[0], p[1], r, maxCand, perWay);
      if (cand.length) break;
    }
    if (cand.length) obs.push({ x: p[0], y: p[1], cand, idx });
    else skipped++;
  });
  const N = obs.length;
  if (N === 0) return null;

  const NEG = -Infinity;
  const scoresHist = [obs[0].cand.map((c) => emission(c.dist, sigma))];
  const back = [];
  const breaks = new Set();
  const breakPts = [];

  for (let i = 1; i < N; i++) {
    const A = obs[i - 1], B = obs[i];
    const prevScores = scoresHist[i - 1];
    const dGc = Math.hypot(B.x - A.x, B.y - A.y);
    const cap = Math.max(400, dGc * 4 + 300);
    const noPen = dGc > gapMin;
    const rd = A.cand.map((c, j) => (prevScores[j] === NEG ? null : routeDistances(graph, c, B.cand, cap, noPen)));
    const ns = new Array(B.cand.length).fill(NEG);
    const bp = new Array(B.cand.length).fill(-1);
    for (let k = 0; k < B.cand.length; k++) {
      let best = NEG, bj = -1;
      for (let j = 0; j < A.cand.length; j++) {
        if (!rd[j] || rd[j][k] === null) continue;
        // scored on RAW meters — the contraflow surcharge steers the path
        // choice inside dijkstra but must not masquerade as extra distance
        const s = prevScores[j] - Math.abs(rd[j][k].raw - dGc) / beta;
        if (s > best) { best = s; bj = j; }
      }
      if (bj >= 0) { ns[k] = best + emission(B.cand[k].dist, sigma); bp[k] = bj; }
    }
    let allNeg = true;
    for (const s of ns) if (s !== NEG) { allNeg = false; break; }
    if (allNeg) {
      breaks.add(i);
      breakPts.push([B.x, B.y]);
      for (let k = 0; k < B.cand.length; k++) { ns[k] = emission(B.cand[k].dist, sigma); bp[k] = -1; }
    }
    let mx = -Infinity;
    for (const s of ns) if (s > mx) mx = s;
    for (let k = 0; k < ns.length; k++) if (ns[k] !== NEG) ns[k] -= mx;
    scoresHist.push(ns);
    back.push(bp);
  }

  const chosen = new Array(N);
  chosen[N - 1] = argmax(scoresHist[N - 1]);
  for (let i = N - 1; i >= 1; i--) {
    const j = back[i - 1][chosen[i]];
    chosen[i - 1] = j >= 0 ? j : argmax(scoresHist[i - 1]);
  }

  const c0 = obs[0].cand[chosen[0]];
  const coords = [[c0.x, c0.y]];
  // Count TRAVELED meters per segment (not the mere fact of touching it) — a candidate
  // projected near a corner onto a long perpendicular segment must not drag the whole
  // block into the streets layer ("tails" at turns on a sparse OSM grid).
  const usedLen = new Map();
  // Traveled t-envelope per segment (t along seg a→b). Long straight OSM
  // segments otherwise draw in FULL once ≥25 m of them is ridden — at spur
  // tips and route ends that left dangling 70–150 m stubs hanging past the
  // real turnaround (user report: "torn" line ends on the Al Wafaa spur).
  const usedIv = new Map();
  const use = (si, m, t0, t1) => {
    usedLen.set(si, (usedLen.get(si) || 0) + m);
    if (t0 !== undefined && t1 > t0) {
      let iv = usedIv.get(si);
      if (!iv) usedIv.set(si, (iv = [t0, t1]));
      else {
        if (t0 < iv[0]) iv[0] = t0;
        if (t1 > iv[1]) iv[1] = t1;
      }
    }
  };
  const rawStretches = [];
  let bridged = 0, rawFallbacks = 0, rawMeters = 0, sumDist = 0;

  for (let i = 1; i < N; i++) {
    const A = obs[i - 1], B = obs[i];
    const a = A.cand[chosen[i - 1]];
    const b = B.cand[chosen[i]];
    sumDist += b.dist;
    // length of the raw GTFS trace between observations (incl. unassigned points)
    let rawLen = 0;
    for (let p = A.idx; p < B.idx; p++) {
      rawLen += Math.hypot(pts[p + 1][0] - pts[p][0], pts[p + 1][1] - pts[p][1]);
    }
    const isBreak = breaks.has(i);
    const spansSkipped = B.idx - A.idx > 1;
    // same gap classification as the Viterbi loop — the reconstructed path
    // must be the one the transition scores were computed on
    const noPen = Math.hypot(B.x - A.x, B.y - A.y) > gapMin;
    let conn = connectPair(graph, a, b, Math.max(500, rawLen * 4 + 300), noPen);
    if (!conn) conn = connectPair(graph, a, b, rawLen * 8 + 2000, noPen);
    // The bridge is judged on a broken chain / across unassigned points — and,
    // more strictly, on shape-gap legs: if it comes out absurdly longer than
    // the raw trace, the road does not exist in OSM — draw the GTFS trace
    // instead of fabricating a detour via ramps. Gap-leg case: the Viterbi may
    // legitimately target a frontage street whose only graph entry lies around
    // the block (unstitched parallel ways are routine in OSM) — X499 at El
    // Kafr drew an 850 m rectangle over a 340 m straight corridor.
    const wildDetour = conn && (
      ((isBreak || spansSkipped) && conn.d > Math.max(rawLen * 2.5, rawLen + 150)) ||
      (noPen && conn.d > Math.max(rawLen * 2.2, rawLen + 150)));
    if (conn && !wildDetour) {
      appendCoords(coords, conn.coords);
      if (conn.nodesPath) {
        const sa = graph.segs[a.segIdx];
        const first = conn.nodesPath[0];
        if (first === sa.b) use(a.segIdx, (1 - a.t) * sa.len, a.t, 1);
        else if (first === sa.a) use(a.segIdx, a.t * sa.len, 0, a.t);
        for (let p = 0; p + 1 < conn.nodesPath.length; p++) {
          const si = graph.segByNodes.get(conn.nodesPath[p] + '|' + conn.nodesPath[p + 1]);
          if (si !== undefined) use(si, graph.segs[si].len, 0, 1);
        }
        const sb = graph.segs[b.segIdx];
        const last = conn.nodesPath[conn.nodesPath.length - 1];
        if (last === sb.a) use(b.segIdx, b.t * sb.len, 0, b.t);
        else if (last === sb.b) use(b.segIdx, (1 - b.t) * sb.len, b.t, 1);
      } else {
        use(a.segIdx, Math.abs(b.t - a.t) * graph.segs[a.segIdx].len, Math.min(a.t, b.t), Math.max(a.t, b.t));
      }
      if (isBreak) bridged++;
    } else {
      const raw = [[a.x, a.y]];
      for (let p = A.idx + 1; p < B.idx; p++) raw.push([pts[p][0], pts[p][1]]);
      raw.push([b.x, b.y]);
      appendCoords(coords, raw.slice(1));
      rawStretches.push(raw);
      rawFallbacks++;
      rawMeters += rawLen;
    }
  }

  // A segment enters the streets layer only once ≥25 m or ≥half of its length was
  // traveled (short intersection segments stay, glancing touches drop out).
  const usedSegs = new Set();
  for (const [si, m] of usedLen) {
    if (m >= Math.min(25, graph.segs[si].len * 0.5)) usedSegs.add(si);
  }

  let roundaboutSegs = 0;
  for (const si of usedSegs) if (graph.segs[si].roundabout) roundaboutSegs++;

  return {
    coords,
    usedSegs,
    usedIv,
    breakPts,
    rawStretches,
    stats: {
      observations: pts.length,
      matched: N,
      noCandidates: skipped,
      viterbiBreaks: breaks.size,
      bridged: bridged,
      rawStretchCount: rawFallbacks,
      rawMeters: Math.round(rawMeters),
      meanError: N > 1 ? sumDist / (N - 1) : 0,
      roundaboutSegs: roundaboutSegs,
      extStart: 0,
      extEnd: 0,
    },
  };
}

function pointToPolyline(coords, p) {
  let best = Infinity;
  for (let i = 0; i + 1 < coords.length; i++) {
    const a = coords[i], b = coords[i + 1];
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const l2 = vx * vx + vy * vy;
    let t = l2 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
    if (d < best) best = d;
  }
  return best;
}

// Segment bookkeeping of one routed leg — same rules as the reconstruction loop
// above, so an extended stretch enters the streets layer on equal terms.
function useConn(graph, use, a, conn, b) {
  if (conn.nodesPath) {
    const sa = graph.segs[a.segIdx];
    const first = conn.nodesPath[0];
    if (first === sa.b) use(a.segIdx, (1 - a.t) * sa.len, a.t, 1);
    else if (first === sa.a) use(a.segIdx, a.t * sa.len, 0, a.t);
    for (let p = 0; p + 1 < conn.nodesPath.length; p++) {
      const si = graph.segByNodes.get(conn.nodesPath[p] + '|' + conn.nodesPath[p + 1]);
      if (si !== undefined) use(si, graph.segs[si].len, 0, 1);
    }
    const sb = graph.segs[b.segIdx];
    const last = conn.nodesPath[conn.nodesPath.length - 1];
    if (last === sb.a) use(b.segIdx, b.t * sb.len, 0, b.t);
    else if (last === sb.b) use(b.segIdx, (1 - b.t) * sb.len, b.t, 1);
  } else {
    use(a.segIdx, Math.abs(b.t - a.t) * graph.segs[a.segIdx].len, Math.min(a.t, b.t), Math.max(a.t, b.t));
  }
}

// Route through a chain of points, greedily leg by leg. `from` seeds the chain
// (all its candidates compete on the first leg), every `target` is then reached
// from the candidate the previous leg settled on. A leg with no road route — or
// one whose route is an absurd detour — ends the chain: half an extension beats
// invented geometry.
function chainThrough(graph, from, targets, use, opts) {
  const coords = [];
  let curCands = candidates(graph, from.pt[0], from.pt[1], from.radius, 6);
  if (!curCands.length) return { coords, reached: 0, meters: 0 };
  let cur = null, meters = 0, reached = 0;
  for (const t of targets) {
    const cands = candidates(graph, t.pt[0], t.pt[1], t.radius, 8);
    if (!cands.length) break;
    const src = cur ? [cur] : curCands;
    const gap = Math.hypot(t.pt[0] - (cur ? cur.x : from.pt[0]), t.pt[1] - (cur ? cur.y : from.pt[1]));
    if (gap > opts.maxGap) break;
    const cap = Math.max(400, gap * 2.5 + 300);
    let best = null;
    for (const a of src) {
      for (const b of cands) {
        const conn = connectPair(graph, a, b, cap, false);
        // the emission side still matters: a candidate 150 m off the pole that
        // routes 20 m shorter is not the stop's street
        if (conn && (!best || conn.d + b.dist * 2 < best.conn.d + best.b.dist * 2)) best = { a, b, conn };
      }
    }
    if (!best) break;
    if (!cur) coords.push([best.a.x, best.a.y]);
    appendCoords(coords, best.conn.coords);
    useConn(graph, use, best.a, best.conn, best.b);
    meters += best.conn.d;
    cur = best.b;
    reached++;
  }
  return { coords, reached, meters };
}

// Terminal repair — the drawn line must reach the stops it serves.
//
// Source geometry regularly stops short of a terminus: the Jastrzębie shape of
// line 303 ends 1.3 km before Kamień Rzędówka, TPBI's tram 1 gives up 3 km before
// Romprim, and a stop-sequence pseudo-shape silently loses its last observation
// when the pole coordinate lies off every road (Lyski Rondo sits 115 m into a
// field, outside the candidate net — user report). Whatever the cause, the line
// ends in mid-street while the terminus disc, its name and the line badges float
// away from any route: the most visible defect the map can show.
//
// Fix: take the stops at either end that the matched geometry never comes near
// and chain them onto it through the graph, leg by leg, the way a pseudo match
// would have drawn them. Guarded: a run that is far from ALL its stops is a
// broken match, not a short shape, and is left untouched.
export function extendToStops(graph, res, stopsXY, opts = {}) {
  const trigger = opts.trigger ?? 120;
  const radius = opts.radius ?? 160;
  const maxGap = opts.maxGap ?? 4000;
  const coords = res.coords;
  if (!Array.isArray(stopsXY) || stopsXY.length < 2 || coords.length < 2) return null;

  const far = stopsXY.map((p) => pointToPolyline(coords, p) > trigger);
  let head = 0;
  while (head < far.length && far[head]) head++;
  let tail = 0;
  while (tail < far.length - head && far[far.length - 1 - tail]) tail++;
  if (!head && !tail) return null;
  if (head + tail >= far.length) return null;

  const usedLen = new Map();
  const use = (si, m, t0, t1) => {
    usedLen.set(si, (usedLen.get(si) || 0) + m);
    if (t0 !== undefined && t1 > t0) {
      let iv = res.usedIv.get(si);
      if (!iv) res.usedIv.set(si, (iv = [t0, t1]));
      else {
        if (t0 < iv[0]) iv[0] = t0;
        if (t1 > iv[1]) iv[1] = t1;
      }
    }
  };

  let startM = 0, endM = 0;
  if (tail) {
    const seq = stopsXY.slice(stopsXY.length - tail).map((pt) => ({ pt, radius }));
    const ch = chainThrough(graph, { pt: coords[coords.length - 1], radius: 30 }, seq, use, { maxGap });
    if (ch.reached) { appendCoords(coords, ch.coords); endM = ch.meters; }
  }
  if (head) {
    // travel order: the first orphan stop → … → the point the match starts at
    const seq = [...stopsXY.slice(1, head).map((pt) => ({ pt, radius })), { pt: coords[0], radius: 30 }];
    const ch = chainThrough(graph, { pt: stopsXY[0], radius }, seq, use, { maxGap });
    if (ch.reached === seq.length) {
      const pre = ch.coords;
      while (pre.length && Math.abs(pre[pre.length - 1][0] - coords[0][0]) < 0.01 &&
             Math.abs(pre[pre.length - 1][1] - coords[0][1]) < 0.01) pre.pop();
      coords.unshift(...pre);
      startM = ch.meters;
    }
  }
  for (const [si, m] of usedLen) {
    if (m >= Math.min(25, graph.segs[si].len * 0.5)) res.usedSegs.add(si);
  }
  res.stats.extStart = Math.round(startM);
  res.stats.extEnd = Math.round(endM);
  return { head, tail, startM: Math.round(startM), endM: Math.round(endM) };
}
