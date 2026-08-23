// LINE-BY-LINE PASS for the Trójmiasto "lines" map.
//
// Reads the finished network from data/out/ (streets + labels + meta) and emits
// a SECOND, parallel set of files — it never rewrites anything build.mjs made,
// so a bad run can only ever cost the lines-*.geojson it wrote itself.
//
// The rule, from the user: a roadway carrying up to MAX_SEPARATE lines is drawn
// line by line, every line in its own colour, the strands running side by side.
// Anything busier collapses to ONE grey stroke — the list of numbers beside it
// (reused from the map's existing number rows) says which lines gather there.
// On the real network that splits 77% of the length into coloured strands and
// leaves the 5–38-line trunks grey, which is exactly the part that turned into
// a blot when an earlier attempt drew all 38 of them as parallel strands.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data/out');
const log = (...a) => console.log('Lines:', ...a);

// ---------- tunables ----------
const MAX_SEPARATE = 4;    // bundles this wide or narrower are drawn line by line
const STITCH_BUNDLE = 30;  // how far a strand pokes into the next bundle (m)
const STITCH_CORRIDOR = 15;// ... and into a grey corridor, where it only has to touch
const DP_TOL = 1.5;        // Douglas–Peucker tolerance (m)
const MAX_TURN = 45;       // corners sharper than this get rounded: line-offset
const CUT_MAX = 4;         // folds over them, and that looked like torn thread
const LABEL_EVERY = 150;   // one label station per this much chain (m)
const PITCH_RATIO = 0.5;   // strand spacing as a multiple of label text size —
                           // keeps the em-offset of a number valid at every zoom

// ---------- geo (local metric frame; the city spans 60 km, error < 0.3%) ----------
// local metric frame centred on the network itself (meta.bbox), so the same
// script serves any city
const LAT0 = (() => { const b = JSON.parse(readFileSync(join(OUT, 'meta.json'), 'utf8')).bbox; return (b[1] + b[3]) / 2; })();
const MX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const MY = 111132;
const toM = (c) => [c[0] * MX, c[1] * MY];
const toDeg = (p) => [Math.round(p[0] / MX * 1e6) / 1e6, Math.round(p[1] / MY * 1e6) / 1e6];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const chainLen = (p) => { let s = 0; for (let i = 1; i < p.length; i++) s += dist(p[i - 1], p[i]); return s; };
const nk = (c) => c[0].toFixed(6) + ',' + c[1].toFixed(6);

// line numbers sort like a timetable, not like strings (build.mjs convention)
const keyParts = (s) => { const m = /^(\D*)(\d*)(.*)$/.exec(s); return [m[1], m[2] ? Number(m[2]) : Infinity, m[3]]; };
const numSort = (a, b) => { const A = keyParts(a), B = keyParts(b); return A[0].localeCompare(B[0]) || (A[1] - B[1]) || A[2].localeCompare(B[2]); };

// ---------- colour: CIE-Lab, so "different enough" is a measurable distance ----------
function lab2rgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const f = (t) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  const X = 0.95047 * f(fx), Y = f(fy), Z = 1.08883 * f(fz);
  const lin = [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.2040 * Y + 1.0570 * Z];
  return lin.map((u) => (u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055));
}
const hex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
const dE = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
// Lightness carries further than hue when the patch is a 3 px line — two mid
// browns at the same L read as one stroke long before their plain ΔE says so,
// so the colouring judges neighbours on a lightness-weighted distance.
const dInk = (p, q) => Math.hypot(2 * (p[0] - q[0]), p[1] - q[1], p[2] - q[2]);

// LCh walked down in chroma until it lands inside sRGB — an even spread in Lab
// is what makes "pick the most distant colour" mean anything.
function swatch(L, C0, h) {
  const rad = h * Math.PI / 180;
  for (let C = C0; C >= 8; C -= 2) {
    const lab = [L, C * Math.cos(rad), C * Math.sin(rad)];
    const rgb = lab2rgb(...lab);
    if (rgb.every((v) => v >= -0.002 && v <= 1.002)) return { hex: hex(rgb), lab };
  }
  return null;
}
// A 66-swatch palette served the 192 lines of the Tricity; a 467-line
// network (GZM) has bundles whose conflict graph outruns it and two lines in
// one bundle ended up the same colour. Networks past 300 lines get a finer
// hue step and a fourth lightness level (~110 swatches, still ΔE ≥ 9 apart).
const BIG = (JSON.parse(readFileSync(join(OUT, 'meta.json'), 'utf8')).lines || []).length > 300;
const PALETTE = [];
for (const L of (BIG ? [32, 44, 56, 66] : [38, 51, 63])) for (let h = 0; h < 360; h += (BIG ? 12 : 15)) {
  const s = swatch(L, 68, h);
  if (s && !PALETTE.some((p) => dE(p.lab, s.lab) < 9)) PALETTE.push(s);
}

// ---------- load ----------
const streets = JSON.parse(readFileSync(join(OUT, 'streets.geojson'), 'utf8'));
const rawLabels = JSON.parse(readFileSync(join(OUT, 'labels.geojson'), 'utf8'));
const meta = JSON.parse(readFileSync(join(OUT, 'meta.json'), 'utf8'));

// ---------- 1. chains: weld runs with the same line set through their nodes ----------
// build.mjs cuts a roadway wherever the line set changes, so a single avenue
// arrives as dozens of fragments. Offsetting each fragment on its own makes the
// strands restart at every seam; welded first, they hold one course.
function buildChains(feats, keyOf) {
  const groups = new Map();
  feats.forEach((f, i) => {
    const k = keyOf(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  });
  const chains = [];
  for (const [, idx] of groups) {
    const pts = idx.map((i) => feats[i].geometry.coordinates.map(toM));
    const ends = new Map();
    const at = (k) => { if (!ends.has(k)) ends.set(k, []); return ends.get(k); };
    idx.forEach((i, j) => {
      const c = feats[i].geometry.coordinates;
      at(nk(c[0])).push({ j, end: 0 });
      at(nk(c[c.length - 1])).push({ j, end: 1 });
    });
    const used = new Array(idx.length).fill(false);
    const keyAt = (j, end) => {
      const c = feats[idx[j]].geometry.coordinates;
      return nk(end ? c[c.length - 1] : c[0]);
    };
    for (let j0 = 0; j0 < idx.length; j0++) {
      if (used[j0]) continue;
      used[j0] = true;
      let coords = pts[j0].slice();
      let headKey = keyAt(j0, 0), tailKey = keyAt(j0, 1);
      const members = [idx[j0]];
      // grow from both ends, but only where the continuation is unambiguous:
      // guessing at a fork is how a chain ends up doubling back on itself
      for (const dir of [1, 0]) {
        for (;;) {
          const k = dir ? tailKey : headKey;
          const cand = (ends.get(k) || []).filter((e) => !used[e.j]);
          if (cand.length !== 1) break;
          const { j, end } = cand[0];
          used[j] = true;
          members.push(idx[j]);
          let add = pts[j].slice();
          if (end === 1) add.reverse();          // it meets us at its own tail
          if (dir) { coords = coords.concat(add.slice(1)); tailKey = keyAt(j, end === 1 ? 0 : 1); }
          else { add.reverse(); coords = add.slice(0, -1).concat(coords); headKey = keyAt(j, end === 1 ? 0 : 1); }
        }
      }
      chains.push({ pts: coords, members, headKey, tailKey });
    }
  }
  return chains;
}

const feats = streets.features;
const compKey = (f) => f.properties.mode + '|' + f.properties.arr.slice().sort(numSort).join(',');
const chains = buildChains(feats, compKey);
chains.forEach((ch, i) => { ch.idx = i; });
for (const ch of chains) {
  const p = feats[ch.members[0]].properties;
  ch.mode = p.mode;
  ch.arr = p.arr.slice().sort(numSort);
  ch.n = ch.arr.length;
  ch.len = chainLen(ch.pts);
}
log(`${feats.length} roadway runs welded into ${chains.length} chains ` +
    `(${chains.filter((c) => c.n <= MAX_SEPARATE).length} coloured bundles, ${chains.filter((c) => c.n > MAX_SEPARATE).length} grey corridors)`);

// ---------- 2. orientation: one drawing sense per corridor ----------
// line-offset measures from the DRAWING direction, so two chains of the same
// avenue drawn in opposite senses throw a line from one kerb to the other at
// the seam. Flood a sense across chains that meet and share lines.
{
  const node = new Map();
  chains.forEach((c, i) => {
    for (const [k, end] of [[c.headKey, 0], [c.tailKey, 1]]) {
      if (!node.has(k)) node.set(k, []);
      node.get(k).push({ i, end });
    }
  });
  const seen = new Array(chains.length).fill(false);
  const order = chains.map((c, i) => i).sort((a, b) => (chains[b].len * chains[b].n) - (chains[a].len * chains[a].n));
  let flipped = 0, spread = 0;
  for (const root of order) {
    if (seen[root]) continue;
    seen[root] = true;
    const queue = [root];
    while (queue.length) {
      const i = queue.shift();
      const c = chains[i];
      const setOf = new Set(c.arr);
      for (const [k, end] of [[c.headKey, 0], [c.tailKey, 1]]) {
        // strongest continuation first: the more lines carry through, the more
        // it deserves to dictate the sense
        const nb = (node.get(k) || []).filter((e) => e.i !== i && !seen[e.i] && chains[e.i].mode === c.mode)
          .map((e) => ({ ...e, shared: chains[e.i].arr.filter((l) => setOf.has(l)).length }))
          .filter((e) => e.shared > 0)
          .sort((a, b) => b.shared - a.shared);
        for (const e of nb) {
          if (seen[e.i]) continue;
          seen[e.i] = true;
          spread++;
          // head-to-tail continues the sense; head-to-head or tail-to-tail reverses it
          if (e.end === end) { chains[e.i].pts.reverse(); const t = chains[e.i].headKey; chains[e.i].headKey = chains[e.i].tailKey; chains[e.i].tailKey = t; flipped++; }
          queue.push(e.i);
        }
      }
    }
  }
  log(`${spread} chains took their sense from a neighbour (${flipped} reversed to do it)`);
}

// node index AFTER the flood, for stitching
const nodeIdx = new Map();
chains.forEach((c, i) => {
  for (const [k, end] of [[c.headKey, 0], [c.tailKey, 1]]) {
    if (!nodeIdx.has(k)) nodeIdx.set(k, []);
    nodeIdx.get(k).push({ i, end });
  }
});

// ---------- 3. colours: lines that ride together must look apart ----------
const bundles = chains.filter((c) => c.n <= MAX_SEPARATE);
const hard = new Map(), soft = new Map();
const bump = (m, a, b, w) => {
  if (a === b) return;
  const k = a < b ? a + '\0' + b : b + '\0' + a;
  m.set(k, (m.get(k) || 0) + w);
};
for (const c of bundles) for (let i = 0; i < c.n; i++) for (let j = i + 1; j < c.n; j++) bump(hard, c.arr[i], c.arr[j], c.len);
// crossing at the same junction is not sharing a strand, but two near-identical
// colours meeting there still read as one line — a weaker pull on the palette
for (const [, list] of nodeIdx) {
  const here = [...new Set(list.flatMap((e) => chains[e.i].arr))];
  if (here.length > 12) continue;
  for (let i = 0; i < here.length; i++) for (let j = i + 1; j < here.length; j++) bump(soft, here[i], here[j], 1);
}
const nbOf = new Map();
const addNb = (m, w) => { for (const [k, v] of m) { const [a, b] = k.split('\0');
  if (!nbOf.has(a)) nbOf.set(a, []); if (!nbOf.has(b)) nbOf.set(b, []);
  nbOf.get(a).push({ o: b, w: v * w }); nbOf.get(b).push({ o: a, w: v * w }); } };
addNb(hard, 1);
addNb(soft, 12);

const allLines = meta.lines.map((l) => l.line);
const weightOf = (l) => (nbOf.get(l) || []).reduce((s, e) => s + e.w, 0);
const colour = new Map(), used = new Map();
for (const l of allLines.slice().sort((a, b) => weightOf(b) - weightOf(a) || numSort(a, b))) {
  let best = null, bestScore = Infinity;
  for (const p of PALETTE) {
    let score = (used.get(p.hex) || 0) * 1e-3;   // spread the palette when nothing is at stake
    for (const e of (nbOf.get(l) || [])) {
      const c = colour.get(e.o);
      if (!c) continue;
      const gap = dInk(p.lab, c.lab);
      if (gap < 62) score += e.w * (62 - gap) ** 2;
    }
    if (score < bestScore) { bestScore = score; best = p; }
  }
  colour.set(l, best);
  used.set(best.hex, (used.get(best.hex) || 0) + 1);
}
// One greedy pass is order-dependent: whoever is coloured last takes what is
// left, however badly it clashes. Sweeping every line again — now that all of
// its neighbours have a colour — is what actually pulls the worst pairs apart.
const penaltyOf = (l, p) => {
  let score = 0;
  for (const e of (nbOf.get(l) || [])) {
    const c = colour.get(e.o);
    if (!c || e.o === l) continue;
    const gap = dInk(p.lab, c.lab);
    if (gap < 62) score += e.w * (62 - gap) ** 2;
  }
  return score;
};
for (let sweep = 0; sweep < 8; sweep++) {
  let moved = 0;
  for (const l of allLines) {
    const cur = penaltyOf(l, colour.get(l));
    let best = colour.get(l), bestScore = cur;
    for (const p of PALETTE) {
      const sc = penaltyOf(l, p);
      if (sc < bestScore - 1e-9) { bestScore = sc; best = p; }
    }
    if (best !== colour.get(l)) { colour.set(l, best); moved++; }
  }
  if (!moved) break;
}
{ // report the worst neighbour pair, so a bad palette shows up in the log
  let worst = Infinity, pair = '';
  for (const [k] of hard) { const [a, b] = k.split('\0'); const g = dE(colour.get(a).lab, colour.get(b).lab); if (g < worst) { worst = g; pair = a + '/' + b; } }
  log(`${allLines.length} lines coloured from ${PALETTE.length} swatches; ` +
      `tightest pair sharing a bundle: ${pair} at ink-distance ${worst.toFixed(1)}`);
}

// ---------- 4. geometry cleaning ----------
function dedupe(p) {
  const out = [p[0]];
  for (let i = 1; i < p.length - 1; i++) if (dist(p[i], out[out.length - 1]) > 0.4) out.push(p[i]);
  // the endpoints are the keys two chains weld on: dropping one for being too
  // close to its neighbour silently unhooks the chain from the junction
  const last = p[p.length - 1];
  if (out.length > 1 && dist(last, out[out.length - 1]) <= 0.4) out.pop();
  out.push(last);
  return out;
}
function dp(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    let mi = -1, md = tol;
    for (let i = a + 1; i < b; i++) {
      // A CLOSED chain (a terminal loop, a roundabout) has a zero-length chord,
      // and distance-to-chord is then 0 for every point — plain Douglas-Peucker
      // deletes the whole loop and leaves a stroke of length nothing. Fall back
      // to distance from the endpoint, which splits the loop at its far side.
      const d = L < 1e-6 ? Math.hypot(pts[i][0] - ax, pts[i][1] - ay)
        : Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (mi > 0) { keep[mi] = true; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
// A sharp vertex is where an offset stroke folds over itself, so the sharp ones
// get ROUNDED — once, with a proper fillet.
//
// The first version cut corners repeatedly until nothing was sharp, and that
// ate the map: this geometry is sampled every ~13 m, so a normal bend already
// turns 35° at each vertex, every pass shaved another few metres off every one
// of them, and line 143 came out 15 % shorter than the street it rides. A
// single quadratic Bézier through the corner is tangent to both arms, its
// samples never turn more than 30°, and it takes exactly one pass.
const turnAt = (a, b, c) => {
  const v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]];
  const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
  if (l1 < 1e-9 || l2 < 1e-9) return { turn: 180, l1, l2, v1, v2 };
  return { turn: Math.abs(Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1]) * 180 / Math.PI), l1, l2, v1, v2 };
};
function filletOnce(pts) {
  const out = [pts[0]];
  let sharp = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const t = turnAt(a, b, c);
    // arms under a metre are map-matching jitter, not a corner of the street
    if (t.l1 < 0.9 || t.l2 < 0.9) { sharp++; continue; }
    if (t.turn <= MAX_TURN) { out.push(b); continue; }
    sharp++;
    const d = Math.min(t.l1 * 0.35, t.l2 * 0.35, CUT_MAX);
    const u1 = [t.v1[0] / t.l1, t.v1[1] / t.l1], u2 = [t.v2[0] / t.l2, t.v2[1] / t.l2];
    const B1 = [b[0] - u1[0] * d, b[1] - u1[1] * d], B2 = [b[0] + u2[0] * d, b[1] + u2[1] * d];
    const N = Math.max(2, Math.ceil(t.turn / 30));
    for (let j = 0; j <= N; j++) {
      const q = j / N;
      const m1 = [B1[0] + (b[0] - B1[0]) * q, B1[1] + (b[1] - B1[1]) * q];
      const m2 = [b[0] + (B2[0] - b[0]) * q, b[1] + (B2[1] - b[1]) * q];
      out.push([m1[0] + (m2[0] - m1[0]) * q, m1[1] + (m2[1] - m1[1]) * q]);
    }
  }
  out.push(pts[pts.length - 1]);
  return { pts: out, sharp };
}
// ONE pass, deliberately. Looping it until nothing is sharp reads like the
// thorough thing to do and is the opposite: each pass drops the jitter vertices
// again and shaves the corners again, and measured over the whole network it
// turned 3 folds into 90 while quietly eating a line's length.
const fillet = (p) => filletOnce(p).pts;
const smooth = (p) => fillet(dp(dedupe(p), DP_TOL));

// Smooth every chain once, here, and let everything downstream measure the
// geometry that will actually be drawn — the slot handovers depend on the
// tangent at a node, and a tangent taken from the raw geometry can point to the
// other side of a bend than the smoothed one does. (Endpoints are preserved, so
// the node keys the chains were welded on still hold.)
for (const c of chains) c.sm = smooth(c.pts);

// ---------- 5. strands, and how one hands over to the next ----------
// A slot only means something inside the bundle that owns it. The moment the
// line set changes the same line belongs in a DIFFERENT slot, and where a
// bundle runs into a grey trunk it belongs in no slot at all — so a strand that
// simply stops at its own offset ends in mid-air beside the next stroke. That
// was the ugly part: four blunt stubs lying next to a trunk they never touched.
// Instead every strand SWINGS into the slot it will occupy next, over the last
// stretch before the junction. line-offset is one constant per feature, so the
// swing is cut into a few sub-features whose offsets step across; at 0.3 of a
// slot per step (about a pixel) the staircase reads as a curve, and four lines
// funnelling to offset 0 read as what they are — lines merging into the trunk.
// The swing is cut into sub-features because line-offset is one constant per
// feature — so the swing is a STAIRCASE, and the riser of each step is what the
// eye picks up. The riser is (step × pitch) pixels: at z17 a 0.3-slot step
// jumps 2 px, which serrates the edge of a strand whose neighbours run smooth
// (found at the Witomino terminus loop, where one line came out visibly jagged
// against three that did not). 0.06 of a slot keeps every riser under half a
// pixel out to z17 and costs the file about 2.5 MB — paid only by the view that
// draws them, which is why the lines sources load on first use.
const TAPER_M = 36;
const TAPER_STEP = 0.06;

// the piece of a polyline between two distances along it
function slicePts(pts, from, to) {
  const out = [];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = dist(a, b);
    if (d < 1e-9) continue;
    if (acc + d >= from && acc <= to) {
      const t0 = Math.max(0, (from - acc) / d), t1 = Math.min(1, (to - acc) / d);
      const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (!out.length) out.push(at(t0));
      const p1 = at(t1);
      if (dist(out[out.length - 1], p1) > 1e-9) out.push(p1);
    }
    acc += d;
  }
  return out.length >= 2 ? out : null;
}

// WHERE THE STROKES MEET, AND WHERE THEY DO NOT HAVE TO
//
// Two problems live at a junction, and only one of them is about slots.
//
// The first: the same line sits in a different slot on the other side, or in no
// slot at all because the other side is a grey trunk. That one is solved by
// SWINGING into the slot it will have next — but both sides have to agree on
// the answer, or they swap places and the step is just as wide as before.
//
// The second is subtler and it is what made the corners look torn: line-offset
// is measured from the direction a stroke is DRAWN in, so two separate features
// meeting at a corner offset themselves in two different directions and their
// ends miss each other by the width of the turn. MapLibre only miters an offset
// around a corner INSIDE one feature. So the strands are welded first: a line's
// chains are strung into one polyline for as long as its slot does not change,
// and only where the slot really changes is there a seam to smooth.
const slotIn = (c, line) => c.arr.indexOf(line) - (c.n - 1) / 2;

// unit vector pointing from a node INTO the chain
function tangentAt(ci, end) {
  const p = chains[ci].sm;
  const d = end ? [p[p.length - 2][0] - p[p.length - 1][0], p[p.length - 2][1] - p[p.length - 1][1]]
    : [p[1][0] - p[0][0], p[1][1] - p[0][1]];
  const L = Math.hypot(d[0], d[1]) || 1;
  return [d[0] / L, d[1] / L];
}

// The offset this line has to be on when it reaches this node — the same answer
// from either side, so the two strokes actually land on each other.
function meeting(ci, end, line) {
  const c = chains[ci];
  const key = end ? c.tailKey : c.headKey;
  const here = (nodeIdx.get(key) || []).filter((e) => chains[e.i].mode === c.mode && chains[e.i].arr.includes(line));
  if (here.length < 2) return null;                     // the line ends here
  if (here.length > 2) return 0;                        // a fork: pinch to the centreline
  const other = here.find((e) => e.i !== ci);
  if (!other) return 0;                                 // a loop meeting its own tail
  const d = chains[other.i];
  if (d.n > MAX_SEPARATE) return 0;                     // funnel into the grey trunk
  // their slot read in our frame: a neighbour that meets us with the same END
  // as ours is drawn the opposite way through the node, so its sides mirror
  const sign = other.end !== end ? 1 : -1;
  const mine = slotIn(c, line), theirs = sign * slotIn(d, line);
  if (mine === theirs) return mine;                     // nothing to do: they weld
  // wider bundle wins the slot, ties broken on chain order — both sides agree
  const iWin = c.n !== d.n ? c.n > d.n : ci < other.i;
  // Two SEPARATE features cannot carry an offset around a bend: each measures
  // from its own direction, so their ends sit 2·slot·sin(θ/2) apart however well
  // the numbers agree. Past 25° the side that gives way runs down to the
  // CENTRELINE instead — it then finishes inside the other one's band, which
  // reads as joining it. Pinching BOTH sides was tried and it collapses every
  // roundabout into a knot: the ring loses the parallel bands that are the whole
  // point of the map, right where they look best.
  const t1 = tangentAt(ci, end), t2 = tangentAt(other.i, other.end);
  if (-(t1[0] * t2[0] + t1[1] * t2[1]) < Math.cos(25 * Math.PI / 180)) return iWin ? mine : 0;
  return iWin ? mine : theirs;
}

// Can this run keep going through this end without changing slot?
function weldAt(ci, end, line, slot) {
  const c = chains[ci];
  const key = end ? c.tailKey : c.headKey;
  const here = (nodeIdx.get(key) || []).filter((e) => chains[e.i].mode === c.mode && chains[e.i].arr.includes(line));
  if (here.length !== 2) return null;
  const other = here.find((e) => e.i !== ci);
  if (!other) return null;
  const d = chains[other.i];
  if (d.n > MAX_SEPARATE) return null;
  const rev = other.end === 1;                          // its tail is here: turn it round
  const theirs = slotIn(d, line) * (rev ? -1 : 1);
  return theirs === slot ? { d, rev } : null;
}

const byLine = new Map();
for (const c of bundles) for (const line of c.arr) {
  if (!byLine.has(line)) byLine.set(line, []);
  byLine.get(line).push(c);
}

const strandF = [];
let swings = 0, funnels = 0, welded = 0, runsOut = 0;
// self-check: a strand's pieces must tile its run, and every stroke arriving at
// a junction must arrive on the same physical side as the others
let holes = 0, holeM = 0, holeWhere = null;
const arrive = new Map();
const arriveAt = (key, mode, line, o, dir, what, into) => {
  const L = Math.hypot(dir[0], dir[1]) || 1;
  const d = [dir[0] / L, dir[1] / L];
  const k = key + '|' + mode + '|' + line;
  if (!arrive.has(k)) arrive.set(k, []);
  arrive.get(k).push({ o, v: [o * d[1], -o * d[0]], d, into, what });
};

for (const [line, mem] of byLine) {
  const hex = colour.get(line).hex;
  const used = new Set();
  for (const seed of mem) {
    if (used.has(seed.idx)) continue;
    used.add(seed.idx);
    let seq = [{ c: seed, rev: false }];
    let slot = slotIn(seed, line);
    // a run that comes back onto itself cannot be welded shut — a LineString has
    // two ends whatever its shape — so the seam is pinched to the centreline
    // instead, where there is no offset left to step across
    let loopHead = false, loopTail = false;
    const grow = () => {
      for (;;) {
        const last = seq[seq.length - 1];
        const w = weldAt(last.c.idx, last.rev ? 0 : 1, line, slot);
        if (!w) return false;
        if (used.has(w.d.idx)) return true;
        used.add(w.d.idx);
        seq.push({ c: w.d, rev: w.rev });
        welded++;
      }
    };
    loopTail = grow();
    // turn the run round and grow the other way, then leave it in that orientation
    seq = seq.reverse().map((x) => ({ c: x.c, rev: !x.rev }));
    slot = -slot;
    loopHead = loopTail;
    loopTail = grow();
    runsOut++;

    // geometry of the whole run
    let base = [];
    for (const seg of seq) {
      const p = seg.rev ? seg.c.sm.slice().reverse() : seg.c.sm;
      base = base.length ? base.concat(p.slice(1)) : p.slice();
    }
    // welding makes a NEW corner at every seam, and nothing has rounded that one
    if (seq.length > 1) base = fillet(base);
    const total = chainLen(base);
    const head = seq[0], tail = seq[seq.length - 1];
    const hM = meeting(head.c.idx, head.rev ? 1 : 0, line);
    const tM = meeting(tail.c.idx, tail.rev ? 0 : 1, line);
    const hIn = loopHead ? 0 : hM === null ? null : (head.rev ? -hM : hM);
    const tOut = loopTail ? 0 : tM === null ? null : (tail.rev ? -tM : tM);
    // on a short run the two swings simply meet in the middle — better than a
    // sliver of straight stroke between them
    const hLen = (hIn !== null && hIn !== slot) ? Math.min(TAPER_M, total * 0.5) : 0;
    const tLen = (tOut !== null && tOut !== slot) ? Math.min(TAPER_M, total * 0.5) : 0;

    const emit = (pts, o, swinging) => {
      if (!pts || pts.length < 2 || chainLen(pts) < 0.8) return;
      const props = { line, mode: seed.mode, color: hex, oi: Math.round(o * 1000) / 1000, n: seed.n };
      // A swing is cut into sub-features because line-offset is one constant per
      // feature — and the WHITE CASING is what makes those cuts visible: it is
      // wider than the stroke, so at every step it juts out sideways from under
      // its neighbour, and ten of those in a row fur the edge of the line (or,
      // with the pieces abutting instead of overlapping, nick it into dashes).
      // Marked here, dropped from the casing layer there. The casing exists to
      // hold neighbouring strands apart; through a swing they are converging
      // anyway, so there is nothing left for it to separate.
      if (swinging) props.sw = 1;
      strandF.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: pts.map(toDeg) } });
    };
    emit(slicePts(base, hLen, total - tLen), slot);
    // The swing lands EXACTLY on both ends: its first step is the run's own slot
    // and its last is the neighbour's, so neither seam shows a step of its own.
    const swing = (from, to, a2, b2, trunk) => {
      // fine enough that the staircase reads as a curve, never so fine that a
      // step comes out shorter than the stroke is wide
      const K = Math.max(2, Math.min(Math.ceil(Math.abs(to - from) / TAPER_STEP) + 1, Math.floor((b2 - a2) / 0.9)));
      const L = (b2 - a2) / K;
      for (let m = 0; m < K; m++) {
        const u = K === 1 ? 1 : m / (K - 1);
        // a small overlap so consecutive colours meet with no nick between them
        emit(slicePts(base, a2 + m * L - 0.3, a2 + (m + 1) * L + 0.3), from + (to - from) * (u * u * (3 - 2 * u)), true);
      }
      swings++;
      if (trunk) funnels++;
    };
    if (hLen) swing(hIn, slot, 0, hLen, hIn === 0);
    if (tLen) swing(slot, tOut, total - tLen, total, tOut === 0);
    const covered = hLen + Math.max(0, total - tLen - hLen) + tLen;
    if (covered < total - 0.5) { holes++; holeM += total - covered; if (!holeWhere) holeWhere = { line, total, covered, at: toDeg(base[0]) }; }
    const hKey = head.rev ? head.c.tailKey : head.c.headKey;
    const tKey = tail.rev ? tail.c.headKey : tail.c.tailKey;
    arriveAt(hKey, seed.mode, line, hLen ? hIn : slot, [base[1][0] - base[0][0], base[1][1] - base[0][1]], 'strand', true);
    arriveAt(tKey, seed.mode, line, tLen ? tOut : slot, [base[base.length - 1][0] - base[base.length - 2][0], base[base.length - 1][1] - base[base.length - 2][1]], 'strand', false);
  }
}

// trunks arrive on their own centreline, so they land in the same ledger at 0
for (const c of chains) if (c.n > MAX_SEPARATE) for (const line of c.arr) {
  arriveAt(c.headKey, c.mode, line, 0, [c.sm[1][0] - c.sm[0][0], c.sm[1][1] - c.sm[0][1]], 'trunk', true);
  arriveAt(c.tailKey, c.mode, line, 0, [c.sm[c.sm.length - 1][0] - c.sm[c.sm.length - 2][0], c.sm[c.sm.length - 1][1] - c.sm[c.sm.length - 2][1]], 'trunk', false);
}
{
  let bad = 0, worstSpread = 0, worstKey = null, worstList = null;
  for (const [k, list] of arrive) {
    if (list.length < 2) continue;
    let spread = 0, bent = false;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a2 = list[i], b2 = list[j];
      const gap = Math.hypot(a2.v[0] - b2.v[0], a2.v[1] - b2.v[1]);
      if (gap <= spread) continue;
      spread = gap;
      const dot = a2.into === b2.into ? -(a2.d[0] * b2.d[0] + a2.d[1] * b2.d[1]) : (a2.d[0] * b2.d[0] + a2.d[1] * b2.d[1]);
      bent = dot <= Math.cos(25 * Math.PI / 180);
    }
    // a step at a BEND is the deliberate one: the giving-way stroke runs down to
    // the centreline and finishes inside the other one's band
    if (spread > 0.35 && !bent) { bad++; if (spread > worstSpread) { worstSpread = spread; worstKey = k; worstList = list; } }
  }
  if (process.env.TRACE_NODE) {
    const [nkey, ln] = process.env.TRACE_NODE.split('@');
    const ends = (nodeIdx.get(nkey) || []).filter((e) => chains[e.i].arr.includes(ln));
    for (const e of ends) {
      const c = chains[e.i];
      log(`  NODE ${nkey} ${ln}: chain ${e.i} n=${c.n} end=${e.end} slot=${slotIn(c, ln)} meeting=${meeting(e.i, e.end, ln)} weld=${JSON.stringify(weldAt(e.i, e.end, ln, slotIn(c, ln)) ? 'yes' : 'no')} tangent=${tangentAt(e.i, e.end).map((x) => x.toFixed(2))}`);
    }
  }
  if (bad) log(`!! ${bad} junctions where the strokes arrive on different sides — worst ${worstSpread.toFixed(2)} slots at ${worstKey} (${worstList.map((e) => e.what + '@' + e.o).join(' ')})`);
  else log(`every junction hands over on the same side (${arrive.size} line-ends checked)`);
}
if (holes) log(`!! ${holes} strands do not tile their run — ${(holeM / 1000).toFixed(2)} km missing, first: line ${holeWhere.line} @ ${holeWhere.at}`);
log(`${welded} chain-to-chain welds: ${bundles.length} bundles became ${runsOut} unbroken strand runs`);
log(`${strandF.length} strand pieces drawn line by line`);
log(`${swings} slot handovers smoothed at junctions, ${funnels} of them funnelling into a grey trunk`);

// ---------- 6. grey corridors ----------
// One stroke, one grey, whatever rides there. The line list stays on the
// feature even though nothing paints it: picking a line in the panel repaints
// exactly the trunks that carry it, so a line stays traceable end to end
// instead of disappearing into the grey.
const corridorF = chains.filter((c) => c.n > MAX_SEPARATE).map((c) => ({
  type: 'Feature',
  properties: { mode: c.mode, n: c.n, arr: c.arr, lines: c.arr.join(', ') },
  geometry: { type: 'LineString', coordinates: c.sm.map(toDeg) },
}));
log(`${corridorF.length} grey trunks (widest carries ${Math.max(...corridorF.map((f) => f.properties.n))} lines)`);

// ---------- 7. the numbers, one cluster per roadway ----------
// EVERY roadway gets one row of numbers beside it — the coloured bundles as
// much as the grey trunks — and every number is written in its line's colour.
// The first version put a number beside each strand instead, round-robin along
// the corridor; it scattered "700" and "Z" down a street that only needed to say
// "700, Z" once (user report). One cluster reads faster and the colours still
// say which strand is which.
//
// MapLibre paints one colour per text SECTION, and a `format` expression can
// carry many — but the sections have to be enumerated in the style, so the row
// ships one property per number (l0, l1, …) and one per colour (c0, c1, …) and
// the style stitches them back together. Laying the block out here instead, as
// one symbol per number, was tried first and turned Gdynia into digit soup: a
// row must be ONE symbol so that the collision engine can drop or keep it whole.
const rowF = [];
let maxSlots = 0;
for (const f of rawLabels.features) {
  const list = f.properties.arr;
  maxSlots = Math.max(maxSlots, list.length);
  const props = { lines: f.properties.lines, arr: list, mode: f.properties.mode, angle: f.properties.angle };
  if (f.properties.side !== undefined) props.side = f.properties.side;
  if (f.properties.extra !== undefined) { props.extra = f.properties.extra; props.ei = f.properties.ei; }
  if (f.properties.mi !== undefined) props.mi = f.properties.mi;
  list.forEach((l, i) => {
    // the separator travels INSIDE the section, so the row still wraps at the
    // spaces exactly the way a plain string one did
    props['l' + i] = l + (i < list.length - 1 ? ', ' : '');
    props['c' + i] = (colour.get(l) || { hex: '#41464e' }).hex;
  });
  rowF.push({ type: 'Feature', properties: props, geometry: f.geometry });
}
// A trunk with no numbers beside it anywhere is a stroke that says nothing at
// all — and build.mjs, which placed these anchors for a map where every stroke
// was navy, skipped the runs it judged too short to bother with. Here they are
// the only thing naming the lines, so any trunk left unnamed gets a row of its
// own at its midpoint.
{
  const CELL = 150;
  const cellOf = (p) => Math.round(p[0] / CELL) + ',' + Math.round(p[1] / CELL);
  const anchors = new Map();
  for (const f of rowF) {
    const p = toM(f.geometry.coordinates);
    const k = cellOf(p);
    if (!anchors.has(k)) anchors.set(k, []);
    anchors.get(k).push(p);
  }
  let added = 0;
  for (const c of chains) {
    const total = chainLen(c.sm);
    let acc = 0, at = null;
    for (let i = 1; i < c.sm.length; i++) {
      const d = dist(c.sm[i - 1], c.sm[i]);
      if (acc + d >= total / 2) { const t = (total / 2 - acc) / d; at = { p: [c.sm[i - 1][0] + (c.sm[i][0] - c.sm[i - 1][0]) * t, c.sm[i - 1][1] + (c.sm[i][1] - c.sm[i - 1][1]) * t], a: c.sm[i - 1], b: c.sm[i] }; break; }
      acc += d;
    }
    if (!at) continue;
    const [cx, cy] = [Math.round(at.p[0] / CELL), Math.round(at.p[1] / CELL)];
    let near = false;
    for (let dx = -1; dx <= 1 && !near; dx++) for (let dy = -1; dy <= 1 && !near; dy++)
      for (const q of (anchors.get((cx + dx) + ',' + (cy + dy)) || []))
        if (dist(q, at.p) < 170) { near = true; break; }
    if (near) continue;
    let ang = Math.atan2(at.b[0] - at.a[0], at.b[1] - at.a[1]) * 180 / Math.PI - 90;
    while (ang > 90) ang -= 180;
    while (ang < -90) ang += 180;
    const props = { lines: c.arr.join(', '), arr: c.arr, mode: c.mode, angle: Math.round(ang * 10) / 10 };
    c.arr.forEach((l, i) => {
      props['l' + i] = l + (i < c.arr.length - 1 ? ', ' : '');
      props['c' + i] = (colour.get(l) || { hex: '#41464e' }).hex;
    });
    rowF.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: toDeg(at.p) } });
    maxSlots = Math.max(maxSlots, c.arr.length);
    const k = cellOf(at.p);
    if (!anchors.has(k)) anchors.set(k, []);
    anchors.get(k).push(at.p);
    added++;
  }
  if (added) log(`${added} roadways had no numbers anywhere along them — a row added at each midpoint`);
}
log(`${rowF.length} number rows, one cluster per roadway, every number in its line's colour (widest row: ${maxSlots})`);

// ---------- 8. write (new files only) ----------
const fc = (features) => JSON.stringify({ type: 'FeatureCollection', features });
writeFileSync(join(OUT, 'lines-strands.geojson'), fc(strandF));
writeFileSync(join(OUT, 'lines-corridors.geojson'), fc(corridorF));
writeFileSync(join(OUT, 'lines-rows.geojson'), fc(rowF));
writeFileSync(join(OUT, 'lines-meta.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  maxSeparate: MAX_SEPARATE,
  pitchRatio: PITCH_RATIO,
  palette: PALETTE.length,
  rowSlots: maxSlots,
  colors: Object.fromEntries([...colour].map(([l, c]) => [l, c.hex])),
  stats: {
    chains: chains.length, bundles: bundles.length, strands: strandF.length,
    corridors: corridorF.length, rows: rowF.length,
    kmColoured: Math.round(bundles.reduce((s, c) => s + c.len * c.n / 1000, 0)),
    kmGrey: Math.round(chains.filter((c) => c.n > MAX_SEPARATE).reduce((s, c) => s + c.len / 1000, 0)),
  },
}, null, 2));
log('written: lines-strands, lines-corridors, lines-rows, lines-meta');
