// Local metric projection (equirectangular around the area center) — Kraków is
// small enough that the error vs full geodesy is negligible for map matching.
const R = 6371008.8;
const D2R = Math.PI / 180;

export function makeProj(lat0, lon0) {
  const ky = R * D2R;
  const kx = R * D2R * Math.cos(lat0 * D2R);
  return {
    toXY(lat, lon) { return [(lon - lon0) * kx, (lat - lat0) * ky]; },
    toLonLat(x, y) { return [x / kx + lon0, y / ky + lat0]; },
  };
}

export function dist(ax, ay, bx, by) {
  return Math.hypot(bx - ax, by - ay);
}

// Resample a polyline every `step` meters (keeps the first and last point).
// Segments longer than `gapMin` are gaps in GTFS data (the trace jumps in a straight
// line across built-up areas — the ZTP network has ~200 of them) — we do not
// fabricate observations inside them, only keep both ends; the HMM bridges the gap
// by routing along real streets.
export function resample(points, step, gapMin = Infinity) {
  if (points.length < 2) return points.slice();
  const out = [points[0]];
  const push = (p) => {
    const last = out[out.length - 1];
    if (dist(last[0], last[1], p[0], p[1]) > 0.01) out.push(p);
  };
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const segLen = dist(ax, ay, bx, by);
    if (segLen === 0) continue;
    if (segLen > gapMin) {
      push([ax, ay]);
      push([bx, by]);
      carry = 0;
      continue;
    }
    let d = step - carry;
    while (d <= segLen) {
      const t = d / segLen;
      push([ax + t * (bx - ax), ay + t * (by - ay)]);
      d += step;
    }
    carry = segLen - (d - step);
  }
  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (dist(tail[0], tail[1], last[0], last[1]) > step / 4) out.push(last);
  return out;
}

// Nearest point on a polyline to point p; returns {x, y, d, segIdx, t}.
export function nearestOnPolyline(px, py, coords) {
  let best = null;
  for (let i = 0; i + 1 < coords.length; i++) {
    const [ax, ay] = coords[i];
    const [bx, by] = coords[i + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx, y = ay + t * dy;
    const d = dist(px, py, x, y);
    if (!best || d < best.d) best = { x, y, d, segIdx: i, t };
  }
  return best;
}

export function polylineLength(coords) {
  let L = 0;
  for (let i = 1; i < coords.length; i++) L += dist(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  return L;
}
