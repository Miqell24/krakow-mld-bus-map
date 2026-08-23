// Octilinear layout — the heart of the schematic mode (Etap 2).
//
// The layout graph is the contracted one: nodes = interchanges / branch points /
// termini, edges = corridors (beads follow their corridor afterwards). Method is
// Stott & Rodgers-style local search: nodes live on an integer grid, every round
// each node (least important first, hubs last) tries the cells within a shrinking
// radius and takes the best cost improvement. The cost is the user's agreed
// specification w1…w8. Distances on the diagram are counted in STOPS, not km:
// each corridor gets a target length from its bead count; geography enters only
// as the soft anchor (w1), the octant preference (w3) and the initial state.
//
// Coordinates: "units" = grid cells. anchor = radially √-compressed geographic
// position, divided by a scale s (m/unit) fitted so the median corridor's
// compressed length matches its stop-count target.

import { sideOf, crossesAt, extendEnds } from './river.mjs';

const TAU = Math.PI * 2;
const OCT = Math.PI / 4; // 45°

const key = (x, y) => x + '|' + y;
const wrapAng = (a) => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };

// proper segment intersection (shared endpoints excluded by the caller via ids)
function segCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function pointSegDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const L2 = vx * vx + vy * vy;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L2)) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

export function runLayout(stations, contracted, graph, cfg, log, riverGeo) {
  const W = cfg.weights;
  const nodes = [...contracted.layoutNodes].sort((a, b) => a - b);
  const nodeSet = new Set(nodes);

  // ---------- anchors: centroid → radial √ compression → scale to units ----------
  let cx = 0, cy = 0;
  for (const v of nodes) { cx += stations[v].gpsX; cy += stations[v].gpsY; }
  cx /= nodes.length; cy /= nodes.length;
  const compress = (x, y) => {
    const dx = x - cx, dy = y - cy;
    const r = Math.hypot(dx, dy);
    if (r <= cfg.radialR0 || r === 0) return [dx, dy];
    const r2 = cfg.radialR0 * Math.pow(r / cfg.radialR0, cfg.radialGamma);
    return [dx * (r2 / r), dy * (r2 / r)];
  };
  const comp = new Map(); // station idx → compressed [mx,my] (meters, centroid origin)
  for (const st of stations) comp.set(st.idx, compress(st.gpsX, st.gpsY));

  // corridors that take part in the geometry (self-loops handled separately)
  // Target length: stops first (rule 4 — the diagram counts stops, not km), but
  // a long non-stop hop still needs room. 712 runs 2.5 km from Tyniecka
  // Autostrada to Zielińskiego without a single stop; on stop count alone it got
  // the minimum length and landed on top of the Kolna branch, reading like a
  // local link. The geographic term is a square root, so distance stretches the
  // line without restoring scale (rule 5).
  const corr = contracted.corridors.map((c, i) => {
    const geoD = Math.hypot(
      stations[c.b].gpsX - stations[c.a].gpsX,
      stations[c.b].gpsY - stations[c.a].gpsY);
    const byStops = 1 + cfg.beadLen * c.beads.length;
    const byGeo = Math.sqrt(geoD / cfg.geoLenRefM);
    return {
      ...c, i,
      t: Math.max(cfg.edgeLenMin, Math.min(cfg.edgeLenMax, Math.max(byStops, byGeo))),
      loop: c.a === c.b,
    };
  });
  // Scale is where the diagram's honesty about direction is won or lost. Taken
  // from the MEDIAN corridor, half the corridors end up under one grid cell
  // long, and rounding their endpoints to integers scrambles which way they
  // point (measured: 44 reversed bearings before the search even starts).
  // Taking a low percentile instead means even short corridors span enough
  // cells to encode a bearing; w2 pulls the long ones back to target anyway.
  const ratios = corr.filter((c) => !c.loop).map((c) => {
    const [ax, ay] = comp.get(c.a), [bx, by] = comp.get(c.b);
    return Math.hypot(bx - ax, by - ay) / c.t;
  }).sort((a, b) => a - b);
  const pick = ratios[Math.floor(ratios.length * cfg.scalePercentile)] || cfg.grid;
  const s = Math.max(cfg.grid, pick);
  log(`layout scale: ${s.toFixed(0)} m/unit (${nodes.length} nodes, ${corr.length} corridors)`);

  const anchor = new Map(); // node → [ux,uy] float
  for (const v of nodes) { const [mx, my] = comp.get(v); anchor.set(v, [mx / s, my / s]); }

  // geographic bearing of every corridor (RAW gps — rule 3 wants true directions).
  // geoDist is how much that bearing is worth trusting: between two stops 80 m
  // apart the compass direction is noise, across 3 km it is a fact about the city.
  for (const c of corr) {
    if (c.loop) continue;
    const gdx = stations[c.b].gpsX - stations[c.a].gpsX;
    const gdy = stations[c.b].gpsY - stations[c.a].gpsY;
    c.geoAng = Math.atan2(gdy, gdx);
    c.geoOct = Math.round(c.geoAng / OCT) & 7;
    c.geoDist = Math.hypot(gdx, gdy);
    c.bearConf = Math.min(1, c.geoDist / cfg.bearFullTrustM);
  }

  // ---------- initial grid positions (hubs claim their cells first) ----------
  const pos = new Map(); // node → [x,y] int
  const occ = new Map(); // "x|y" → node
  const bySize = [...nodes].sort((a, b) => stations[b].imp - stations[a].imp);
  for (const v of bySize) {
    const [ax, ay] = anchor.get(v);
    let X = Math.round(ax), Y = Math.round(ay);
    if (occ.has(key(X, Y))) { // spiral to the nearest free cell
      outer: for (let r = 1; r < 50; r++) {
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (!occ.has(key(X + dx, Y + dy))) { X += dx; Y += dy; break outer; }
        }
      }
    }
    pos.set(v, [X, Y]);
    occ.set(key(X, Y), v);
  }

  // ---------- the Vistula, as part of the layout state ----------
  // The river is not decoration drawn afterwards: it is a polyline of control
  // points living in the same grid as the stations, moved by the same search,
  // and anchored by its bridges. Everything geographic about it is measured
  // ONCE here, against the real centerline, and then defended as a relation.
  let riv = null;
  if (riverGeo) {
    const toUnits = ([x, y]) => { const [mx, my] = compress(x, y); return [mx / s, my / s]; };
    // control points: a coarse sample of the centerline, with every bridge
    // inserted at its own place along the river
    const gc = riverGeo.center;
    const step = Math.max(1, Math.floor(gc.length / cfg.riverPoints));
    const marks = [];
    for (let i = 0; i < gc.length; i += step) marks.push({ t: i, geo: gc[i], bridge: null });
    if (marks[marks.length - 1].t !== gc.length - 1) {
      marks.push({ t: gc.length - 1, geo: gc[gc.length - 1], bridge: null });
    }
    riverGeo.bridges.forEach((b, bi) => marks.push({ t: b.t, geo: [b.x, b.y], bridge: bi }));
    marks.sort((a, b) => a.t - b.t);
    // a bridge and a plain sample landing on the same cell: the bridge wins
    const pts = [], isBridge = [], bridgeOf = [];
    for (const m of marks) {
      const [ux2, uy2] = toUnits(m.geo);
      const px = Math.round(ux2), py = Math.round(uy2);
      const last = pts.length - 1;
      if (last >= 0 && pts[last][0] === px && pts[last][1] === py) {
        if (m.bridge !== null) { isBridge[last] = 1; bridgeOf[last] = m.bridge; }
        continue;
      }
      pts.push([px, py]);
      isBridge.push(m.bridge !== null ? 1 : 0);
      bridgeOf.push(m.bridge);
    }
    if (pts.length >= 2) {
      riv = {
        pos: pts,
        anchor: pts.map((p) => [...p]),
        isBridge, bridgeOf,
        names: riverGeo.bridges.map((b) => b.name),
      };
      // geographic truth, measured once
      for (const st of stations) {
        st.geoSide = st.degree ? sideOf(riverGeo.centerExt, st.gpsX, st.gpsY).side : 0;
      }
      // stations close enough that a river move can flip their bank
      riv.band = nodes.filter((v) => {
        const [ax, ay] = anchor.get(v);
        return sideOf(extendEnds(pts), ax, ay).d < cfg.riverBandM;
      });
      // which corridors cross the river, and at which bridge
      for (const c of corr) {
        c.crosses = false;
        if (c.loop) continue;
        const A = stations[c.a], B = stations[c.b];
        const hit = crossesAt(riverGeo.centerExt, A.gpsX, A.gpsY, B.gpsX, B.gpsY);
        if (!hit) continue;
        c.crosses = true;
        // the bridge this crossing belongs to: nearest in real space
        let best = -1, bd = Infinity;
        riverGeo.bridges.forEach((b, bi) => {
          const d = Math.hypot(b.x - hit.x, b.y - hit.y);
          if (d < bd) { bd = d; best = bi; }
        });
        c.bridge = bd < cfg.riverClipM ? best : -1;
      }
      const nCross = corr.filter((c) => c.crosses).length;
      log(`river constraint: ${pts.length} control points (${isBridge.filter(Boolean).length} bridges), ` +
        `${riv.band.length} nodes in the bank-sensitive band, ${nCross} corridors cross the river`);
    }
  }
  const riverPts = () => (riv ? extendEnds(riv.pos) : null);
  let rivExt = riverPts();
  // where each bridge currently sits, in grid units — the anchor every crossing
  // is measured against
  let bridgePos = [];
  const syncBridges = () => {
    bridgePos = [];
    if (!riv) return;
    riv.pos.forEach((p, i) => { if (riv.isBridge[i]) bridgePos[riv.bridgeOf[i]] = p; });
  };
  syncBridges();

  // ---------- static topology indexes ----------
  const incident = new Map(); // node → [corr]
  for (const v of nodes) incident.set(v, []);
  for (const c of corr) {
    if (c.loop) { incident.get(c.a).push(c); continue; }
    incident.get(c.a).push(c);
    incident.get(c.b).push(c);
  }
  // line paths over layout nodes → turn triples (a,k,b) for w7
  const triples = [];
  const triplesByNode = new Map();
  {
    const seen = new Set();
    for (const line of graph.lines) for (const d of line.dirs) for (const v of d.variants) {
      const lp = v.path.filter((st) => nodeSet.has(st));
      for (let i = 1; i + 1 < lp.length; i++) {
        const a = lp[i - 1], k = lp[i], b = lp[i + 1];
        if (a === k || k === b || a === b) continue;
        const sig = a < b ? `${a}|${k}|${b}` : `${b}|${k}|${a}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        const tr = { a, k, b };
        triples.push(tr);
        for (const n of [a, k, b]) {
          let arr = triplesByNode.get(n);
          if (!arr) triplesByNode.set(n, (arr = []));
          arr.push(tr);
        }
      }
    }
  }

  // ---------- spatial hashes (cell size cfg.cellSize) ----------
  const CS = cfg.cellSize;
  const cellOf = (x, y) => Math.floor(x / CS) + '|' + Math.floor(y / CS);
  const corrCells = new Map(); // cell → Set(corr index)
  const cellsOfCorr = new Map(); // corr index → [cell keys]
  const nodeCells = new Map(); // cell → Set(node)
  const bboxCells = (ax, ay, bx, by) => {
    const out = [];
    const x0 = Math.floor(Math.min(ax, bx) / CS), x1 = Math.floor(Math.max(ax, bx) / CS);
    const y0 = Math.floor(Math.min(ay, by) / CS), y1 = Math.floor(Math.max(ay, by) / CS);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) out.push(gx + '|' + gy);
    return out;
  };
  const indexCorr = (c) => {
    const [ax, ay] = pos.get(c.a), [bx, by] = pos.get(c.b);
    const cells = bboxCells(ax, ay, bx, by);
    cellsOfCorr.set(c.i, cells);
    for (const ck of cells) {
      let set = corrCells.get(ck);
      if (!set) corrCells.set(ck, (set = new Set()));
      set.add(c.i);
    }
  };
  const unindexCorr = (c) => {
    for (const ck of cellsOfCorr.get(c.i) || []) corrCells.get(ck).delete(c.i);
  };
  for (const c of corr) if (!c.loop) indexCorr(c);
  const indexNode = (v) => {
    const [x, y] = pos.get(v);
    const ck = cellOf(x, y);
    let set = nodeCells.get(ck);
    if (!set) nodeCells.set(ck, (set = new Set()));
    set.add(v);
  };
  const unindexNode = (v) => {
    const [x, y] = pos.get(v);
    const set = nodeCells.get(cellOf(x, y));
    if (set) set.delete(v);
  };
  for (const v of nodes) indexNode(v);

  // ---------- cost of node v at position p (everything that involves v) ----------
  const labelHalf = new Map(); // coarse label half-width for w6
  for (const v of nodes) labelHalf.set(v, 0.5 + 0.05 * (stations[v].name || '').length);

  function nodeCost(v, px, py) {
    const st = stations[v];
    let C = 0;

    // w1: soft geographic anchor …
    const [ax, ay] = anchor.get(v);
    const da = Math.hypot(px - ax, py - ay);
    C += W.w1 * (da / cfg.anchorSoft) ** 2;
    // w8: majors barely move
    if (st.major) {
      const over = Math.max(0, da - cfg.freeR);
      C += W.w8 * st.impN * over * over;
    }

    const inc = incident.get(v);
    for (const c of inc) {
      if (c.loop) continue;
      const u = c.a === v ? c.b : c.a;
      const [ux, uy] = pos.get(u);
      const dx = ux - px, dy = uy - py;
      const len = Math.hypot(dx, dy);

      // w2: target length from the stop count
      C += W.w2 * ((len - c.t) / c.t) ** 2;

      if (len > 1e-6) {
        const ang = Math.atan2(dy, dx);
        const geoA = c.a === v ? c.geoAng : c.geoAng + Math.PI; // bearing v→u
        const geoO = Math.round(geoA / OCT) & 7;

        // w1 (part 2): a branch must still point where the city points (rule 10).
        // GRADED, not a sign test: the diagram may bend a bearing by 20°, but a
        // stop that lies north in reality must not end up east. The old binary
        // flip test cost 0.125 while a crossing costs w4 — so the search bought
        // straight lines by inverting the map, which is what the user caught.
        const bearDev = Math.abs(wrapAng(ang - geoA));
        C += W.w1 * c.bearConf * (bearDev / (Math.PI / 2)) ** 2;

        // w3: octilinearity, preferring the octant of the true bearing
        let best = Infinity;
        for (let o = 0; o < 8; o++) {
          const dev = wrapAng(ang - o * OCT);
          const p = (dev / (OCT / 2)) ** 2 + (o === geoO ? 0 : cfg.octantSwitchPen);
          if (p < best) best = p;
        }
        C += W.w3 * best;
      } else C += W.w3 * 4; // degenerate zero-length edge

      // w4: crossings of this corridor against non-adjacent corridors
      let crossings = 0;
      for (const ck of bboxCells(px, py, ux, uy)) {
        const set = corrCells.get(ck);
        if (!set) continue;
        for (const oi of set) {
          const o = corr[oi];
          if (o.i === c.i || o.loop) continue;
          if (o.a === v || o.b === v || o.a === u || o.b === u) continue; // shares a node
          // count each pair once per evaluation
          if (inc.includes(o) && o.i < c.i) continue;
          const [oax, oay] = pos.get(o.a), [obx, oby] = pos.get(o.b);
          if (segCross(px, py, ux, uy, oax, oay, obx, oby)) crossings++;
        }
      }
      C += W.w4 * crossings;

      // w5 (part 2): this corridor sliding over a foreign node
      for (const ck of bboxCells(px, py, ux, uy)) {
        const set = nodeCells.get(ck);
        if (!set) continue;
        for (const n of set) {
          if (n === v || n === u) continue;
          const [nx, ny] = n === v ? [px, py] : pos.get(n);
          const d = pointSegDist(nx, ny, px, py, ux, uy);
          if (d < cfg.edgeClear) C += W.w5 * ((cfg.edgeClear - d) / cfg.edgeClear) ** 2;
        }
      }
    }

    // w5 (part 1) + w6: node pairs too close / label boxes colliding
    const R = Math.ceil(Math.max(cfg.nodeMin, 3));
    const gx0 = Math.floor((px - R) / CS), gx1 = Math.floor((px + R) / CS);
    const gy0 = Math.floor((py - R) / CS), gy1 = Math.floor((py + R) / CS);
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const set = nodeCells.get(gx + '|' + gy);
      if (!set) continue;
      for (const u of set) {
        if (u === v) continue;
        const [ux, uy] = pos.get(u);
        const d = Math.hypot(ux - px, uy - py);
        if (d < cfg.nodeMin) C += W.w5 * ((cfg.nodeMin - d) / cfg.nodeMin) ** 2;
        // w6: coarse horizontal label boxes (height ~0.8 units)
        const ox = labelHalf.get(v) + labelHalf.get(u) - Math.abs(ux - px);
        const oy = 0.8 - Math.abs(uy - py);
        if (ox > 0 && oy > 0) C += W.w6 * ox * oy;
      }
    }
    // w5 (part 3): v itself too close to a foreign corridor
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const set = corrCells.get(gx + '|' + gy);
      if (!set) continue;
      for (const oi of set) {
        const o = corr[oi];
        if (o.loop || o.a === v || o.b === v) continue;
        const [oax, oay] = pos.get(o.a), [obx, oby] = pos.get(o.b);
        const d = pointSegDist(px, py, oax, oay, obx, oby);
        if (d < cfg.edgeClear) C += W.w5 * ((cfg.edgeClear - d) / cfg.edgeClear) ** 2;
      }
    }

    // w10: the bank. Bodzów is north of the Vistula in Kraków and must be north
    // of it on the diagram; this is the constraint the user pays attention to.
    if (rivExt && st.geoSide) {
      const r = sideOf(rivExt, px, py);
      if (r.side !== st.geoSide) C += W.w10 * (0.4 + st.impN);
    }

    // w13: geographic_region_distortion — a district keeps its compass sector
    // around the city centre, so "north Kraków" stays north as a whole. Weighted
    // by distance: near the centre a sector means nothing.
    if (W.w13) {
      const [ax0, ay0] = anchor.get(v);
      const rGeo = Math.hypot(ax0, ay0);
      if (rGeo > cfg.regionMinR) {
        const dev = Math.abs(wrapAng(Math.atan2(py, px) - Math.atan2(ay0, ax0)));
        C += W.w13 * Math.min(1, rGeo / (3 * cfg.regionMinR)) * (dev / (Math.PI / 2)) ** 2;
      }
    }

    // w12: river_crossing_displacement — a line that crosses the Vistula must do
    // it AT its bridge, and a line that never crosses must not cross here.
    if (rivExt) {
      for (const c of inc) {
        if (c.loop) continue;
        const u = c.a === v ? c.b : c.a;
        const [ux2, uy2] = pos.get(u);
        const hit = crossesAt(rivExt, px, py, ux2, uy2);
        if (c.crosses) {
          if (!hit) C += W.w12 * 0.5; // should cross and does not
          else if (c.bridge >= 0 && bridgePos[c.bridge]) {
            const [bx2, by2] = bridgePos[c.bridge];
            C += W.w12 * Math.min(9, ((hit.x - bx2) ** 2 + (hit.y - by2) ** 2) / (cfg.bridgeReachU ** 2));
          }
        } else if (hit) C += W.w12; // crosses a river it never crosses in reality
      }
    }

    // w9: branches must fan out — two corridors leaving v on the same heading
    // draw as one stroke and their stops interleave into a false single line
    const sep = cfg.branchSepDeg * Math.PI / 180;
    const dirs = [];
    for (const c of inc) {
      if (c.loop) continue;
      const u = c.a === v ? c.b : c.a;
      const [ux, uy] = pos.get(u);
      if (ux !== px || uy !== py) dirs.push(Math.atan2(uy - py, ux - px));
    }
    for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) {
      const d = Math.abs(wrapAng(dirs[i] - dirs[j]));
      if (d < sep) C += W.w9 * (1 - d / sep) ** 2;
    }

    // w7: line straightness through the triples touching v
    const trs = triplesByNode.get(v);
    if (trs) for (const tr of trs) {
      const [pax, pay] = tr.a === v ? [px, py] : pos.get(tr.a);
      const [pkx, pky] = tr.k === v ? [px, py] : pos.get(tr.k);
      const [pbx, pby] = tr.b === v ? [px, py] : pos.get(tr.b);
      const a1 = Math.atan2(pky - pay, pkx - pax);
      const a2 = Math.atan2(pby - pky, pbx - pkx);
      const turn = Math.abs(wrapAng(a2 - a1));
      C += W.w7 * 0.25 * (turn / OCT) ** 2;
    }
    return C;
  }

  const evalTotal = () => {
    let t = 0;
    for (const v of nodes) t += nodeCost(v, ...pos.get(v));
    return t; // pairwise terms counted twice — fine for before/after comparison
  };
  const countCrossings = () => {
    let n = 0;
    const list = corr.filter((c) => !c.loop);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const [ax, ay] = pos.get(a.a), [bx, by] = pos.get(a.b);
      for (let j = i + 1; j < list.length; j++) {
        const o = list[j];
        if (o.a === a.a || o.a === a.b || o.b === a.a || o.b === a.b) continue;
        const [ocx, ocy] = pos.get(o.a), [odx, ody] = pos.get(o.b);
        if (segCross(ax, ay, bx, by, ocx, ocy, odx, ody)) n++;
      }
    }
    return n;
  };

  // ---------- cost of the river itself ----------
  // Moving a river vertex is judged by what it does to the city around it: which
  // bank the nearby stations end up on, whether the bridges keep their place and
  // their order along the stream, whether the crossings still meet their bridge,
  // and whether the band still reads as the Vistula rather than a zigzag.
  function riverCost(i) {
    if (!riv) return 0;
    const ext = extendEnds(riv.pos);
    let C = 0;
    // w10 — banks, for the stations this stretch can reach
    for (const v of riv.band) {
      const st = stations[v];
      if (!st.geoSide) continue;
      const r = sideOf(ext, ...pos.get(v));
      if (r.side !== st.geoSide) C += W.w10 * (0.4 + st.impN);
      else if (r.d < cfg.riverClearU) C += W.w10 * 0.25 * (cfg.riverClearU - r.d) / cfg.riverClearU;
    }
    // w11 — bridge_displacement: anchors hold their position AND their order
    riv.pos.forEach((p, k) => {
      const [ax0, ay0] = riv.anchor[k];
      const drift = (p[0] - ax0) ** 2 + (p[1] - ay0) ** 2;
      C += (riv.isBridge[k] ? W.w11 : cfg.riverSmooth) * drift / (cfg.bridgeReachU ** 2);
    });
    for (let k = 1; k < riv.pos.length; k++) {
      // the stream must keep flowing the same way it flows in the city
      const [ax0, ay0] = riv.anchor[k - 1], [bx0, by0] = riv.anchor[k];
      const gd = Math.atan2(by0 - ay0, bx0 - ax0);
      const sd = Math.atan2(riv.pos[k][1] - riv.pos[k - 1][1], riv.pos[k][0] - riv.pos[k - 1][0]);
      C += cfg.riverSmooth * (Math.abs(wrapAng(sd - gd)) / (Math.PI / 2)) ** 2;
    }
    // w12 — crossings still meet their bridge
    for (const c of corr) {
      if (!c.crosses || c.loop) continue;
      const [ax1, ay1] = pos.get(c.a), [bx1, by1] = pos.get(c.b);
      const hit = crossesAt(ext, ax1, ay1, bx1, by1);
      if (!hit) { C += W.w12 * 0.5; continue; }
      if (c.bridge >= 0 && bridgePos[c.bridge]) {
        const [bx2, by2] = bridgePos[c.bridge];
        C += W.w12 * Math.min(9, ((hit.x - bx2) ** 2 + (hit.y - by2) ** 2) / (cfg.bridgeReachU ** 2));
      }
    }
    return C;
  }

  // ---------- local search ----------
  const costBefore = evalTotal();
  const crossBefore = countCrossings();
  const order = [...nodes].sort((a, b) => stations[a].imp - stations[b].imp || a - b);
  let rounds = 0;
  for (let round = 0; round < cfg.iters; round++) {
    const r = cfg.moveRadius[Math.min(round, cfg.moveRadius.length - 1)];
    let moved = 0;
    for (const v of order) {
      const [x0, y0] = pos.get(v);
      const base = nodeCost(v, x0, y0);
      let bestC = base, bestX = x0, bestY = y0;
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (!dx && !dy) continue;
        const X = x0 + dx, Y = y0 + dy;
        if (occ.has(key(X, Y))) continue; // one node per cell, hard
        const c = nodeCost(v, X, Y);
        if (c < bestC - 1e-9) { bestC = c; bestX = X; bestY = Y; }
      }
      if (bestX !== x0 || bestY !== y0) {
        unindexNode(v);
        for (const c of incident.get(v)) if (!c.loop) unindexCorr(c);
        occ.delete(key(x0, y0));
        pos.set(v, [bestX, bestY]);
        occ.set(key(bestX, bestY), v);
        indexNode(v);
        for (const c of incident.get(v)) if (!c.loop) indexCorr(c);
        moved++;
      }
    }
    // the river is swept in the same rounds as the network: both sides of the
    // constraint get to give way, instead of the river being fitted afterwards
    let rMoved = 0;
    if (riv) {
      const rr = Math.max(1, Math.min(2, r - 1));
      for (let i = 0; i < riv.pos.length; i++) {
        const [x0, y0] = riv.pos[i];
        let base = riverCost(i), bx3 = x0, by3 = y0;
        for (let dx = -rr; dx <= rr; dx++) for (let dy = -rr; dy <= rr; dy++) {
          if (!dx && !dy) continue;
          riv.pos[i] = [x0 + dx, y0 + dy];
          syncBridges();
          const c = riverCost(i);
          if (c < base - 1e-9) { base = c; bx3 = x0 + dx; by3 = y0 + dy; }
        }
        riv.pos[i] = [bx3, by3];
        syncBridges();
        if (bx3 !== x0 || by3 !== y0) rMoved++;
      }
      rivExt = riverPts();
    }
    rounds++;
    log(`  round ${round + 1} (r=${r}): ${moved} nodes moved` + (riv ? `, ${rMoved} river points` : ''));
    if (!moved && !rMoved) break;
  }
  const costAfter = evalTotal();
  const crossAfter = countCrossings();

  // ---------- corridor paths: straight when octilinear, else one 45° bend ----------
  const paths = new Map(); // corr index → [[ux,uy],…]
  const bendPenalty = (bx, by, c) => {
    // a bend point on top of a node or crossing foreign corridors is a bad bend
    let p = 0;
    const set = nodeCells.get(cellOf(bx, by));
    if (set) for (const n of set) {
      if (n === c.a || n === c.b) continue;
      const [nx, ny] = pos.get(n);
      const d = Math.hypot(nx - bx, ny - by);
      if (d < cfg.nodeMin) p += 10 * (cfg.nodeMin - d);
    }
    return p;
  };
  // The cost function reasons about the STRAIGHT a→b segment, but what gets
  // drawn is the bent path — so a leg can graze a station or cut across other
  // corridors without the optimiser ever noticing (this is what drew the false
  // triangle at Kolna: line 712's diagonal leg arrived at Tyniecka Autostrada
  // straight past Wały Wiślane). Score the legs themselves when choosing.
  const legPenalty = (p0, p1, c) => {
    let pen = 0;
    for (const ck of bboxCells(p0[0], p0[1], p1[0], p1[1])) {
      const nset = nodeCells.get(ck);
      if (nset) for (const n of nset) {
        if (n === c.a || n === c.b) continue;
        const [nx, ny] = pos.get(n);
        // a leg running through a station it does not serve is the worst thing
        // a transit diagram can do — it invents a stop on the line
        const d = pointSegDist(nx, ny, p0[0], p0[1], p1[0], p1[1]);
        if (d < cfg.nodeMin) pen += 25 * (cfg.nodeMin - d) / cfg.nodeMin;
      }
      const cset = corrCells.get(ck);
      if (cset) for (const oi of cset) {
        const o = corr[oi];
        if (o.i === c.i || o.loop) continue;
        if (o.a === c.a || o.b === c.a || o.a === c.b || o.b === c.b) continue;
        const [oax, oay] = pos.get(o.a), [obx, oby] = pos.get(o.b);
        if (segCross(p0[0], p0[1], p1[0], p1[1], oax, oay, obx, oby)) pen += 3;
      }
    }
    // The drawn path decides which bank the intermediate stops land on, so a leg
    // of a corridor that never crosses the Vistula must not cross it either —
    // otherwise its beads appear on the far bank (Bodzowska, Płaszowska…).
    if (rivExt && !c.crosses) {
      const hit = crossesAt(rivExt, p0[0], p0[1], p1[0], p1[1]);
      if (hit) pen += 30;
    }
    return pen;
  };
  // Headings are a scarce resource at a node: two corridors leaving along the
  // same one draw as a single stroke and their stops interleave into a false
  // shared line. Straight corridors have no choice, so they book their heading
  // first; bent ones then pick the bend that keeps clear of what is taken.
  const usedDir = new Map(); // node → Set(octant index)
  const octOf = (dx, dy) => (((Math.round(Math.atan2(dy, dx) / OCT) % 8) + 8) % 8);
  const book = (node, dx, dy) => {
    let s = usedDir.get(node);
    if (!s) usedDir.set(node, (s = new Set()));
    s.add(octOf(dx, dy));
  };
  const taken = (node, dx, dy) => (usedDir.get(node)?.has(octOf(dx, dy)) ? 1 : 0);

  const bent = [];
  for (const c of corr) {
    // turning loops were straightened into dead-end branches back in contract(),
    // so a self-loop here would be a degenerate leftover — nothing to draw
    if (c.loop) { paths.set(c.i, null); continue; }
    const [ax, ay] = pos.get(c.a), [bx, by] = pos.get(c.b);
    const dx = bx - ax, dy = by - ay;
    if (dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)) {
      paths.set(c.i, [[ax, ay], [bx, by]]);
      book(c.a, dx, dy);
      book(c.b, -dx, -dy);
      continue;
    }
    bent.push(c);
  }
  bent.sort((p, q) => q.t - p.t); // the longest, most visible branches choose first
  for (const c of bent) {
    const [ax, ay] = pos.get(c.a), [bx, by] = pos.get(c.b);
    const dx = bx - ax, dy = by - ay;
    const sx = Math.sign(dx), sy = Math.sign(dy);
    const diag = Math.min(Math.abs(dx), Math.abs(dy));
    const run = Math.abs(Math.abs(dx) - Math.abs(dy)); // the straight remainder
    const horiz = Math.abs(dx) > Math.abs(dy);
    const ux = horiz ? sx : 0, uy = horiz ? 0 : sy;
    // Every octilinear route between two points is "some straight, one diagonal,
    // some straight" — so the diagonal can SLIDE along the run. Sampling that
    // whole family (not just the two end cases) is what lets a corridor step
    // around a station instead of ploughing through it.
    let bestPath = null, bestScore = Infinity;
    for (let t = 0; t <= run; t++) {
      const p1 = [ax + ux * t, ay + uy * t];
      const p2 = [p1[0] + sx * diag, p1[1] + sy * diag];
      const pts = [[ax, ay]];
      for (const p of [p1, p2, [bx, by]]) {
        const last = pts[pts.length - 1];
        if (p[0] !== last[0] || p[1] !== last[1]) pts.push(p);
      }
      let sc = cfg.bendCost * (pts.length - 2); // w7's spirit: bends are not free
      for (let i = 1; i < pts.length; i++) sc += legPenalty(pts[i - 1], pts[i], c);
      for (let i = 1; i < pts.length - 1; i++) sc += bendPenalty(pts[i][0], pts[i][1], c);
      sc += 8 * taken(c.a, pts[1][0] - ax, pts[1][1] - ay);
      const pl = pts[pts.length - 2];
      sc += 8 * taken(c.b, pl[0] - bx, pl[1] - by);
      if (sc < bestScore) { bestScore = sc; bestPath = pts; }
    }
    paths.set(c.i, bestPath);
    book(c.a, bestPath[1][0] - ax, bestPath[1][1] - ay);
    const pl = bestPath[bestPath.length - 2];
    book(c.b, pl[0] - bx, pl[1] - by);
  }

  // how badly the diagram lies about direction: an edge more than 90° off points
  // the opposite way from reality (the Tor Kajakowy case), 45–90° is a stretch
  const bearings = () => {
    let flipped = 0, bent = 0, counted = 0;
    for (const c of corr) {
      if (c.loop || c.bearConf < 0.5) continue;
      const [ax, ay] = pos.get(c.a), [bx, by] = pos.get(c.b);
      if (ax === bx && ay === by) continue;
      counted++;
      const dev = Math.abs(wrapAng(Math.atan2(by - ay, bx - ax) - c.geoAng)) * 180 / Math.PI;
      if (dev > 90) flipped++;
      else if (dev > 45) bent++;
    }
    return { flipped, bent, counted };
  };
  const bear0 = bearings();

  // displacement stats (meters of diagram space)
  const moves = nodes.map((v) => {
    const [x, y] = pos.get(v);
    const [ax, ay] = anchor.get(v);
    return Math.hypot(x - ax, y - ay) * s;
  }).sort((a, b) => a - b);
  // how well the river constraint held
  let river = null;
  if (riv) {
    const ext = extendEnds(riv.pos);
    // beads are not placed yet, so the honest measure here is the layout nodes
    let wrongBank = 0, checked = 0;
    for (const v of nodes) {
      const st = stations[v];
      if (!st.geoSide) continue;
      checked++;
      if (sideOf(ext, ...pos.get(v)).side !== st.geoSide) wrongBank++;
    }
    let bridgeDrift = 0, offBridge = 0, nCross = 0;
    riv.pos.forEach((p, k) => {
      if (!riv.isBridge[k]) return;
      bridgeDrift += Math.hypot(p[0] - riv.anchor[k][0], p[1] - riv.anchor[k][1]);
    });
    const nb = riv.isBridge.filter(Boolean).length;
    for (const c of corr) {
      if (!c.crosses || c.loop) continue;
      nCross++;
      const hit = crossesAt(ext, ...pos.get(c.a), ...pos.get(c.b));
      if (!hit) { offBridge++; continue; }
      if (c.bridge >= 0 && bridgePos[c.bridge]) {
        const [bx2, by2] = bridgePos[c.bridge];
        if (Math.hypot(hit.x - bx2, hit.y - by2) > cfg.bridgeReachU * 1.6) offBridge++;
      }
    }
    river = {
      pos: riv.pos, isBridge: riv.isBridge, bridgeOf: riv.bridgeOf, names: riv.names,
      wrongBank, checkedNodes: checked, bridges: nb,
      bridgeDriftM: Math.round((nb ? bridgeDrift / nb : 0) * s),
      crossings: nCross, offBridge,
    };
    log(`river: ${wrongBank}/${checked} layout nodes on the wrong bank, ` +
      `${nb} bridges drifted ${river.bridgeDriftM} m on average, ` +
      `${offBridge}/${nCross} crossings not at their bridge`);
  }

  const stats = {
    scaleMPerUnit: Math.round(s),
    nodes: nodes.length,
    rounds,
    cost: { before: +costBefore.toFixed(1), after: +costAfter.toFixed(1) },
    crossings: { before: crossBefore, after: crossAfter },
    bearings: bear0,
    river: river && {
      wrongBank: river.wrongBank, checkedNodes: river.checkedNodes,
      bridges: river.bridges, bridgeDriftM: river.bridgeDriftM,
      crossings: river.crossings, offBridge: river.offBridge,
    },
    movedM: {
      median: Math.round(moves[Math.floor(moves.length / 2)] || 0),
      max: Math.round(moves[moves.length - 1] || 0),
    },
  };
  log(`layout: cost ${stats.cost.before} → ${stats.cost.after}, crossings ${crossBefore} → ${crossAfter}, ` +
    `median move ${stats.movedM.median} m, max ${stats.movedM.max} m; ` +
    `bearings: ${bear0.flipped} reversed + ${bear0.bent} strained of ${bear0.counted}`);
  return { pos, paths, corr, s, cx, cy, stats, river };
}
