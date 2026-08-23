// Geographic input for the Vistula constraint.
//
// This module no longer draws anything. It prepares the FACTS the layout needs
// to treat the river as a constraint rather than decoration: an ordered
// centerline, the bridges that cross it (anchors), and the primitives for
// asking "which bank is this on" and "does this line cross, and where".
//
// The centerline is NOT built by chaining OSM ways: around islands the river
// splits into parallel ways and chaining by shared endpoints shatters into
// fragments (Kraków's Vistula comes back as 30 ways). The in-network points are
// treated as a cloud, ordered along their own principal axis and median-binned
// across it — braided channels collapse into one line, which is what a diagram
// band needs.
import { readFileSync, existsSync } from 'node:fs';

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

// ---------- bank tests ----------
// The ends are pushed far outward so stations past the drawn stretch still get
// a definite answer instead of wrapping around the tip.
const EXT = 1e7;
export function extendEnds(pts) {
  const unit = (p, q) => {
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const L = Math.hypot(dx, dy) || 1;
    return [dx / L, dy / L];
  };
  const a = pts[0], b = pts[1];
  const p = pts[pts.length - 2], q = pts[pts.length - 1];
  const [ux, uy] = unit(b, a);
  const [vx, vy] = unit(p, q);
  return [[a[0] + ux * EXT, a[1] + uy * EXT], ...pts, [q[0] + vx * EXT, q[1] + vy * EXT]];
}

export function sideOf(pts, x, y) {
  let bestD = Infinity, side = 0, seg = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], ay = pts[i - 1][1];
    const vx = pts[i][0] - ax, vy = pts[i][1] - ay;
    const L2 = vx * vx + vy * vy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / L2)) : 0;
    const d = Math.hypot(x - (ax + t * vx), y - (ay + t * vy));
    if (d < bestD) { bestD = d; side = Math.sign(vx * (y - ay) - vy * (x - ax)); seg = i; }
  }
  return { d: bestD, side, seg };
}

// proper segment intersection
export function segCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

// Where does segment a→b cross the polyline? Returns the river parameter
// (segment index + fraction) and the crossing point, or null.
export function crossesAt(pts, ax, ay, bx, by) {
  for (let i = 1; i < pts.length; i++) {
    const cx = pts[i - 1][0], cy = pts[i - 1][1];
    const dx = pts[i][0], dy = pts[i][1];
    if (!segCross(ax, ay, bx, by, cx, cy, dx, dy)) continue;
    const r1x = bx - ax, r1y = by - ay, r2x = dx - cx, r2y = dy - cy;
    const den = r1x * r2y - r1y * r2x;
    const u = den ? ((cx - ax) * r2y - (cy - ay) * r2x) / den : 0;
    const v = den ? ((cx - ax) * r1y - (cy - ay) * r1x) / den : 0;
    return { t: i - 1 + Math.max(0, Math.min(1, v)), x: ax + u * r1x, y: ay + u * r1y };
  }
  return null;
}

// ---------- the geographic river + its bridges ----------
export function loadRiverGeo(riverPath, bridgePath, stations, proj, cfg, log) {
  if (!existsSync(riverPath)) { log('river: no data/osm/wisla.json — the diagram will have no river'); return null; }
  const osm = JSON.parse(readFileSync(riverPath, 'utf8'));

  const raw = [];
  for (const e of osm.elements || []) for (const g of e.geometry || []) raw.push(proj.toXY(g.lat, g.lon));
  if (raw.length < 8) { log('river: no usable geometry'); return null; }

  // keep only what runs across the network — beyond the station cloud the river
  // has nothing to be a constraint ON
  const cloud = stations.filter((st) => st.degree > 0);
  const near = raw.filter(([x, y]) => {
    let best = Infinity;
    for (const st of cloud) {
      const d2 = (st.gpsX - x) ** 2 + (st.gpsY - y) ** 2;
      if (d2 < best) best = d2;
    }
    return best < cfg.riverClipM * cfg.riverClipM;
  });
  if (near.length < 8) { log('river: no stretch crosses the network'); return null; }

  // principal axis → order along it, median across it
  let cx = 0, cy = 0;
  for (const [x, y] of near) { cx += x; cy += y; }
  cx /= near.length; cy /= near.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of near) {
    const dx = x - cx, dy = y - cy;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(theta), uy = Math.sin(theta);
  const along = near.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    return [dx * ux + dy * uy, -dx * uy + dy * ux];
  });
  let tMin = Infinity, tMax = -Infinity;
  for (const [t] of along) { if (t < tMin) tMin = t; if (t > tMax) tMax = t; }
  const BINS = Math.max(10, Math.min(90, Math.round((tMax - tMin) / cfg.riverBinM)));
  const buckets = Array.from({ length: BINS }, () => []);
  for (const [t, v] of along) {
    const b = Math.min(BINS - 1, Math.floor((t - tMin) / (tMax - tMin) * BINS));
    buckets[b].push(v);
  }
  const center = [];
  buckets.forEach((vs, b) => {
    if (!vs.length) return;
    const t = tMin + (b + 0.5) / BINS * (tMax - tMin);
    const v = median(vs); // braided channels and islands collapse to one line
    center.push([cx + t * ux - v * uy, cy + t * uy + v * ux]);
  });
  if (center.length < 2) { log('river: centerline collapsed'); return null; }

  // ---------- bridges: the anchors ----------
  // A bridge counts when its way actually intersects the centerline — that is
  // what makes it a Vistula crossing rather than a culvert over a stream.
  const bridges = [];
  if (existsSync(bridgePath)) {
    const bj = JSON.parse(readFileSync(bridgePath, 'utf8'));
    const byName = new Map();
    for (const e of bj.elements || []) {
      const g = e.geometry;
      if (!Array.isArray(g) || g.length < 2) continue;
      const pts = g.map((p) => proj.toXY(p.lat, p.lon));
      let hit = null;
      for (let i = 1; i < pts.length && !hit; i++) {
        hit = crossesAt(center, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
      }
      if (!hit) continue;
      const name = (e.tags && e.tags.name) || (e.tags && e.tags.railway ? 'most kolejowy' : 'most');
      const key = name.toLowerCase();
      let b = byName.get(key);
      if (!b) byName.set(key, (b = { name, xs: [], ys: [], ts: [], rail: !!(e.tags && e.tags.railway) }));
      b.xs.push(hit.x); b.ys.push(hit.y); b.ts.push(hit.t);
    }
    for (const b of byName.values()) {
      bridges.push({
        name: b.name, rail: b.rail,
        x: b.xs.reduce((s, v) => s + v, 0) / b.xs.length,
        y: b.ys.reduce((s, v) => s + v, 0) / b.ys.length,
        t: median(b.ts),
      });
    }
    bridges.sort((a, b) => a.t - b.t);
  }
  log(`river: ${raw.length} vertices → ${near.length} across the network → ${center.length} centerline points; ` +
    `${bridges.length} bridges: ${bridges.map((b) => b.name).join(', ')}`);
  return { center, centerExt: extendEnds(center), bridges };
}
